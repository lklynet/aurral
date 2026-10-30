import { db } from "../../config/db-sqlite.ts";
import { finalizeRetainedPlaylistRelocations } from "./mediaRelocation.ts";
import { randomUUID } from "crypto";
import * as v from "valibot";
import { asAppError } from "../../../lib/errors.ts";
import { dbOps, userOps } from "../../db/helpers/index.ts";
import { listOf } from "../../db/helpers/storedSchemas.ts";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
  recordTrackJobQueued,
  recordTrackJobSearching,
} from "../aurralHistoryService.ts";
import {
  buildCoreTrackIdentity,
  buildImportTrackIdentity,
  buildPlaylistTrackIdentity,
  dedupePlaylistTracks,
  filterMissingPlaylistTracks,
  flowPlaylistConfig,
  isRetiredFlow,
  normalizePlaylistTrack,
  rebuildStaticPlaylistTracksFromJobs,
  tracksShareMembership,
  DEFAULT_SIZE,
} from "./flowPlaylistConfig.ts";
import {
  jobDownloadedItsFile,
  normalizeExistingFileMode,
  removePlaylistFileIfUnshared,
  reuseTrackForPlaylist,
  sortJobsForTrackReuse,
} from "../downloadJobs/fileReuse.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { resolveAurralOwnedTrackJob } from "../libraryTrackResearchService.ts";
import { isAurralOwnedPath } from "../qualityProfileService.ts";
import { playlistManager } from "./playlistManager.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import {
  restartWorkerIfPending,
  wakeDownloadWorker,
  withPlaylistMutation,
  withPlaylistMutationLock,
} from "../downloadJobs/mutationGuards.ts";
import { withHonkerLock } from "../honkerDb.ts";
import type { DownloadJob } from "../downloadJobs/downloadTracker.ts";
import type { ArtistMatchFields } from "../discovery/artistKeys.ts";
import type { PlaylistTrack, StaticPlaylist } from "./flowPlaylistConfig.ts";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.ts";
import { filterBlockedArtistsForUser } from "../discovery/feedback.ts";
import {
  activatePlaylistDownloadGeneration,
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
  restorePlaylistDownloadWork,
} from "../downloadJobs/downloadCancellation.ts";
import { cancelPlaylistDownloadWork } from "../downloadJobs/downloadCancellationService.ts";

import {
  captureStaticPlaylistSelection,
  cleanupRemovedPlaylistFiles,
  getPlaylistRemovalLockIds,
  removeStaticPlaylistSelectionsLocked,
  withStaticPlaylistRemovalMutation,
} from "./trackRemoval.ts";

const OPERATION_TOKENS_KEY = "weeklyFlowOperationTokens";
const operationTokenKey = (scope: string) => `${OPERATION_TOKENS_KEY}:${encodeURIComponent(scope)}`;

export function createPlaylistOperationToken() {
  return `${Date.now()}-${randomUUID()}`;
}

export function markLatestPlaylistOperationToken(scope: string, token: string) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return;
  dbOps.setJSONSetting(operationTokenKey(safeScope), safeToken);
}

export function getLatestPlaylistOperationToken(scope: string) {
  const safeScope = String(scope || "").trim();
  if (!safeScope) return null;
  const current = dbOps.getJSONSetting(operationTokenKey(safeScope), v.string());
  if (current != null) return current;
  const legacy = dbOps.getJSONSetting(OPERATION_TOKENS_KEY, v.record(v.string(), v.unknown()));
  const token = legacy?.[safeScope];
  return typeof token === "string" ? token : null;
}

export function restorePlaylistOperationToken({
  scope,
  token,
  previousToken,
}: { scope?: string; token?: string; previousToken?: string | null } = {}) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken || getLatestPlaylistOperationToken(safeScope) !== safeToken) {
    return false;
  }
  dbOps.setJSONSetting(operationTokenKey(safeScope), previousToken ?? null);
  return true;
}

function isLatestPlaylistOperationToken(scope: unknown, token: unknown) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return true;
  return getLatestPlaylistOperationToken(safeScope) === safeToken;
}

function normalizeTrackList(value: unknown): PlaylistTrack[] {
  return (Array.isArray(value) ? value : [])
    .map((track) => normalizePlaylistTrack(track))
    .filter((track): track is NonNullable<typeof track> => Boolean(track));
}

const filterBlockedPlaylistTracks = <T extends ArtistMatchFields>(
  ownerUserId: unknown,
  tracks: T[],
) => {
  if (ownerUserId == null) return tracks;
  return filterBlockedArtistsForUser(String(ownerUserId), tracks);
};

const isOwnerActive = (ownerUserId: unknown) => {
  if (ownerUserId == null) return true;
  const owner = userOps.getUserById(Number(ownerUserId));
  return owner?.status === "active";
};

type OperationPayload = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface FlowOutcome {
  cancelled?: boolean;
  missing?: boolean;
  skipped?: boolean;
  inactiveOwner?: boolean;
  jobIds?: string[];
  tracksQueued?: number;
  reserveTracks?: number;
  empty?: boolean;
  flowName?: string;
}

const flowSeedingWorker = () => {
  if (!("seedFlowRun" in downloadWorker)) {
    throw new TypeError("Flows are seeded by the download worker process");
  }
  return downloadWorker;
};

const removePlaylistLocalTrackFile = async (
  job: Partial<Pick<DownloadJob, "id" | "finalPath">> | null | undefined,
  playlistId: string,
  { protectPlayback = true }: { protectPlayback?: boolean } = {},
) => {
  if (!job || typeof job.finalPath !== "string") return;
  await removePlaylistFileIfUnshared(job.finalPath, playlistId, {
    downloadRoot: downloadWorker.downloadRoot,
    excludeJobIds: job.id ? [job.id] : [],
    protectPlayback,
  });
};

const staticPlaylistTracksMatchJobs = (playlist: StaticPlaylist, jobs: DownloadJob[]) => {
  const configTracks = dedupePlaylistTracks(playlist?.tracks);
  if (configTracks.length !== jobs.length) return false;
  const unmatchedJobs = new Set(jobs.map((job) => job.id));
  for (const track of configTracks) {
    const match = jobs.find(
      (job) => unmatchedJobs.has(job.id) && tracksShareMembership(job, track),
    );
    if (!match) return false;
    unmatchedJobs.delete(match.id);
  }
  return unmatchedJobs.size === 0;
};

const getStaticPlaylistJobs = (playlist: StaticPlaylist) => {
  const referencedJobs: DownloadJob[] = (playlist?.tracks || [])
    .map((track) => (track?.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null))
    .filter((job): job is NonNullable<typeof job> => Boolean(job));
  const jobs = [...referencedJobs, ...downloadTracker.getByPlaylistType(playlist?.id)];
  return jobs.filter(
    (job, index, values) => values.findIndex((candidate) => candidate.id === job.id) === index,
  );
};

const syncStaticPlaylistConfigFromJobs = async (playlistId: string) => {
  const safePlaylistId = String(playlistId || "").trim();
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return null;
  const jobs = getStaticPlaylistJobs(playlist);
  if (staticPlaylistTracksMatchJobs(playlist, jobs)) {
    return playlist;
  }
  const updatedPlaylist = flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, {
    tracks: rebuildStaticPlaylistTracksFromJobs(playlist.tracks, jobs),
  });
  playlistManager.updateConfig();
  return updatedPlaylist;
};

const queueTracksForPlaylist = async (tracks: PlaylistTrack[], playlistId: string) => {
  const settings = downloadWorker.getWorkerSettings();
  const existingFileMode = normalizeExistingFileMode(settings.existingFileMode);
  const reusedJobIds = [];
  const jobIds = [];
  const createdJobIds = [];
  for (const track of normalizeTrackList(tracks)) {
    const libraryJob = track.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null;
    if (libraryJob && tracksShareMembership(libraryJob, track)) {
      reusedJobIds.push(libraryJob.id);
      continue;
    }
    const jobId = downloadTracker.addJob(track, playlistId);
    if (!jobId) continue;
    createdJobIds.push(jobId);
    try {
      const reuse = await reuseTrackForPlaylist(track, playlistId, {
        existingFileMode,
        downloadRoot: downloadWorker.downloadRoot,
        targetPlaylistType: playlistId,
        skipHistory: true,
        existingJobId: jobId,
      });
      if (reuse.reused) {
        reusedJobIds.push(jobId);
        continue;
      }
    } catch (error) {
      console.warn(
        `[Playlists] Reuse failed for ${track.artistName} - ${track.trackName}: ${asAppError(error)?.message || error}`,
      );
    }
    jobIds.push(jobId);
    recordTrackJobQueued(downloadTracker.getJob(jobId));
  }
  return { reusedJobIds, jobIds, createdJobIds };
};

const filterTracksMissingDownloadJobs = (tracks: PlaylistTrack[], playlistId: string) => {
  const existingJobs = downloadTracker.getByPlaylistType(playlistId);
  const missing: PlaylistTrack[] = [];
  const queued: PlaylistTrack[] = [];
  for (const track of normalizeTrackList(tracks)) {
    const libraryJob = track.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null;
    const duplicate =
      Boolean(libraryJob && tracksShareMembership(libraryJob, track)) ||
      existingJobs.some((job) => tracksShareMembership(job, track)) ||
      queued.some((entry) => tracksShareMembership(entry, track));
    if (duplicate) continue;
    queued.push(track);
    missing.push(track);
  }
  return missing;
};

const recordPlaylistHistory = (playlistId: string, { tracksQueued = 0, tracksReused = 0 } = {}) => {
  if (tracksQueued + tracksReused <= 0) return;
  recordPlaylistTracksAdded({
    playlistId,
    tracksQueued,
    tracksReused,
  });
};

async function seedStaticPlaylistTracks(playlistId: string, tracks: PlaylistTrack[]) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  const allowedTracks = filterBlockedPlaylistTracks(playlist?.ownerUserId, tracks);
  const missingTracks = filterTracksMissingDownloadJobs(allowedTracks, playlistId);
  const { reusedJobIds, jobIds, createdJobIds } = await queueTracksForPlaylist(
    missingTracks,
    playlistId,
  );
  playlistManager.requestPlaylistSync([playlistId]);
  if (reusedJobIds.length > 0) {
    playlistManager.scheduleScanLibrary();
  }
  if (jobIds.length > 0) {
    await wakeDownloadWorker();
  }
  recordPlaylistHistory(playlistId, {
    tracksQueued: jobIds.length,
    tracksReused: reusedJobIds.length,
  });
  return {
    reusedJobIds,
    jobIds,
    createdJobIds,
    tracksQueued: jobIds.length,
    tracksReused: reusedJobIds.length,
  };
}

async function runFlowSeed({
  flowId,
  size = null,
  tokenScope = null,
  token = null,
  requireEnabled = false,
  scheduleNext = false,
}: OperationPayload = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (isRetiredFlow(flow)) return { skipped: true, retired: true };
  if (!isAnyDownloadSourceConfigured()) {
    const error: Error & { code?: string } = new Error(getDownloadSourceNotConfiguredMessage());
    error.code = "NO_DOWNLOAD_SOURCE";
    throw error;
  }
  if (requireEnabled && flow.enabled !== true) return { skipped: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const effectiveSize =
    Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : flow.size || DEFAULT_SIZE;
  const flowSnapshot = JSON.stringify(flow);
  const preparedPlan = await flowSeedingWorker().prepareFlowRunPlan(flow, {
    size: effectiveSize,
  });

  const result = await withPlaylistMutation(
    safeFlowId,
    async (): Promise<FlowOutcome> => {
      if (!isLatestPlaylistOperationToken(tokenScope, token)) {
        return { cancelled: true };
      }
      const latestFlow = flowPlaylistConfig.getFlow(safeFlowId);
      if (!latestFlow) return { missing: true };
      if (requireEnabled && latestFlow.enabled !== true) return { skipped: true };
      if (!isOwnerActive(latestFlow.ownerUserId)) {
        return { skipped: true, inactiveOwner: true };
      }
      if (JSON.stringify(latestFlow) !== flowSnapshot) {
        throw new Error("Flow settings changed while planning; retrying");
      }

      activatePlaylistDownloadGeneration(safeFlowId);
      recordFlowGenerationStarted({ flowId: safeFlowId });
      playlistManager.updateConfig();
      await playlistManager.weeklyReset([safeFlowId]);
      downloadTracker.clearByPlaylistId(safeFlowId);

      if (!isLatestPlaylistOperationToken(tokenScope, token)) {
        return { cancelled: true };
      }
      const seeded = await flowSeedingWorker().seedFlowRun(safeFlowId, latestFlow, {
        size: effectiveSize,
        plan: preparedPlan,
      });
      playlistManager.requestPlaylistSync([safeFlowId]);
      if (scheduleNext) {
        flowPlaylistConfig.scheduleNextRun(safeFlowId);
      }
      return {
        jobIds: seeded?.jobIds || [],
        tracksQueued: Number(seeded?.tracksQueued || 0),
        reserveTracks: Number(seeded?.reserveTracks || 0),
        empty: Number(seeded?.tracksQueued || 0) === 0,
        flowName: latestFlow.name,
      };
    },
    {
      clearPending: false,
      async beforeMutation(): Promise<FlowOutcome | undefined> {
        if (!isLatestPlaylistOperationToken(tokenScope, token)) {
          return { cancelled: true };
        }
        const current = flowPlaylistConfig.getFlow(safeFlowId);
        if (!current) return { missing: true };
        if (requireEnabled && current.enabled !== true) return { skipped: true };
        if (!isOwnerActive(current.ownerUserId)) {
          return { skipped: true, inactiveOwner: true };
        }
        if (JSON.stringify(current) !== flowSnapshot) {
          throw new Error("Flow settings changed while planning; retrying");
        }
        const existingFlowJobs = downloadTracker.getByPlaylistId(safeFlowId);
        await cancelPlaylistDownloadWork(safeFlowId, existingFlowJobs, { lock: false });
        if (!isLatestPlaylistOperationToken(tokenScope, token)) {
          return { cancelled: true };
        }
        return undefined;
      },
    },
  );

  if (Array.isArray(result?.jobIds)) rescanLibraryForFlows([safeFlowId]);
  if (result?.tracksQueued && result.tracksQueued > 0) {
    await wakeDownloadWorker();
    recordFlowTracksGenerated({
      flowId: safeFlowId,
      tracksQueued: result.tracksQueued,
      reserveTracks: result.reserveTracks || 0,
    });
  } else {
    await restartWorkerIfPending();
  }
  return result;
}

function rescanLibraryForFlows(flowIds: string[]) {
  const shownInLibrary = flowIds.some(
    (flowId) => flowPlaylistConfig.getFlow(flowId)?.showInLibrary === true,
  );
  if (shownInLibrary) playlistManager.scheduleScanLibrary();
}

async function runFlowCleanup({ flowId, tokenScope = null, token = null }: OperationPayload = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestPlaylistOperationToken(tokenScope, token)) {
      return;
    }
    playlistManager.updateConfig();
    await playlistManager.weeklyReset([safeFlowId]);
    downloadTracker.clearByPlaylistId(safeFlowId);
  });
  rescanLibraryForFlows([safeFlowId]);
  await restartWorkerIfPending();
  return { success: true, flowId: safeFlowId };
}

async function deleteFlow({ flowId, tokenScope = null, token = null }: OperationPayload = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return false;
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return false;
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  let didDelete = false;
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestPlaylistOperationToken(tokenScope, token)) {
      return;
    }
    void downloadWorker.setRetryCyclePaused(safeFlowId, false);
    playlistManager.updateConfig();
    await playlistManager.weeklyReset([safeFlowId], { protectPlayback: false });
    downloadTracker.clearByPlaylistId(safeFlowId);
    didDelete = flowPlaylistConfig.deleteFlow(safeFlowId);
  });
  if (didDelete) {
    playlistManager.requestPlaylistSync([safeFlowId]);
    playlistManager.scheduleScanLibrary();
  }
  await restartWorkerIfPending();
  return didDelete;
}

async function resetPlaylists({ playlistTypes = [] }: OperationPayload = {}) {
  const types = (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  await Promise.all(
    types.map((playlistType) =>
      cancelPlaylistDownloadWork(playlistType, downloadTracker.getByPlaylistId(playlistType)),
    ),
  );
  await withPlaylistMutation(types, async () => {
    playlistManager.updateConfig();
    await playlistManager.weeklyReset(types, { protectPlayback: false });
  });
  rescanLibraryForFlows(types);
  await restartWorkerIfPending();
  return { success: true, playlistTypes: types };
}

async function adoptFlowSeed({ flowId, tracks = [] }: OperationPayload = {}) {
  const safeFlowId = String(flowId || "").trim();
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const normalizedTracks = normalizeTrackList(tracks);
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  const result = await withPlaylistMutation(safeFlowId, async (): Promise<FlowOutcome> => {
    const latestFlow = flowPlaylistConfig.getFlow(safeFlowId);
    if (!latestFlow) return { missing: true };
    if (!isOwnerActive(latestFlow.ownerUserId)) {
      return { skipped: true, inactiveOwner: true };
    }
    activatePlaylistDownloadGeneration(safeFlowId);
    return flowSeedingWorker().seedFlowRunWithTracks(safeFlowId, latestFlow, normalizedTracks);
  });
  if (result?.skipped || result?.missing) return result;
  playlistManager.requestPlaylistSync([safeFlowId]);
  await wakeDownloadWorker();
  recordFlowTracksGenerated({
    flowId: safeFlowId,
    tracksQueued: result?.tracksQueued || normalizedTracks.length,
    reserveTracks: 0,
  });
  return result;
}

async function withLibraryPlaylistMutation<T>(
  payload: OperationPayload,
  operation: (payload: OperationPayload) => Promise<T>,
) {
  const playlistId = String(payload.playlistId || "").trim();
  const payloadTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const libraryIds = payloadTracks
    .map((track) => (isRecord(track) ? track.canonicalJobId : undefined))
    .filter((id): id is string => typeof id === "string" && id !== "");
  const libraryJobs = () =>
    libraryIds
      .map((id) => downloadTracker.getJob(id))
      .filter((job): job is NonNullable<typeof job> => Boolean(job));
  while (true) {
    const jobs = [...downloadTracker.getByPlaylistId(playlistId), ...libraryJobs()];
    const lockIds = getPlaylistRemovalLockIds(playlistId, jobs);
    const result = await withPlaylistMutationLock(lockIds, async () => {
      const currentJobs = [...downloadTracker.getByPlaylistId(playlistId), ...libraryJobs()];
      if (!getPlaylistRemovalLockIds(playlistId, currentJobs).every((id) => lockIds.includes(id)))
        return { retryLocks: true };
      for (const track of payloadTracks) {
        if (!isRecord(track) || !track.canonicalJobId) continue;
        const job =
          typeof track.canonicalJobId === "string"
            ? downloadTracker.getJob(track.canonicalJobId)
            : null;
        if (!job || isDownloadJobCancelled(job.id) || !tracksShareMembership(job, track)) {
          throw new Error(
            "A referenced download is no longer available. Refresh the playlist and try again.",
          );
        }
      }
      return { value: await operation(payload) };
    });
    if (!result.retryLocks) return result.value;
  }
}

async function createStaticPlaylist(payload: OperationPayload = {}) {
  return withLibraryPlaylistMutation(
    { ...payload, playlistId: String(payload.playlistId || "").trim() || randomUUID() },
    createStaticPlaylistLocked,
  );
}

export async function appendStaticPlaylistTracks(payload: OperationPayload = {}) {
  return withLibraryPlaylistMutation(payload, appendStaticPlaylistTracksLocked);
}

export async function updateStaticPlaylist(payload: OperationPayload = {}) {
  return withLibraryPlaylistMutation(payload, updateStaticPlaylistLocked);
}

async function createStaticPlaylistLocked({
  playlistId,
  name,
  sourceName = null,
  sourceFlowId = null,
  discoverPresetId = null,
  type = null,
  tracks = [],
  ownerUserId = null,
  importSource = null,
  description = null,
}: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim() || randomUUID();
  const normalizedTracks = filterBlockedPlaylistTracks(ownerUserId, normalizeTrackList(tracks));
  let playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) {
    playlist = flowPlaylistConfig.createStaticPlaylist({
      id: safePlaylistId,
      name,
      sourceName,
      sourceFlowId,
      discoverPresetId,
      type: typeof type === "string" ? type : null,
      tracks: normalizedTracks,
      ownerUserId,
      importSource: isRecord(importSource) ? importSource : null,
      description,
    });
  }
  activatePlaylistDownloadGeneration(safePlaylistId);
  const queued = normalizedTracks.length
    ? await seedStaticPlaylistTracks(safePlaylistId, normalizedTracks)
    : { jobIds: [], reusedJobIds: [], createdJobIds: [], tracksQueued: 0, tracksReused: 0 };
  await playlistManager.ensurePlaylistArtwork(safePlaylistId);
  playlistManager.requestPlaylistSync([safePlaylistId]);
  if (normalizedTracks.length > 0) {
    schedulePlaylistMbidEnrichment(safePlaylistId, {
      reason: "shared-playlist-create",
      priority: 5,
    });
  }
  return {
    success: true,
    playlist,
    tracksQueued: queued.tracksQueued,
    tracksReused: queued.tracksReused,
    jobIds: queued.createdJobIds,
  };
}

async function appendStaticPlaylistTracksLocked({
  playlistId,
  tracks = [],
}: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return { missing: true };
  const allowedTracks = filterBlockedPlaylistTracks(
    playlist.ownerUserId,
    normalizeTrackList(tracks),
  );
  const tracksToAdd = filterMissingPlaylistTracks(playlist.tracks, allowedTracks);
  const updatedPlaylist =
    tracksToAdd.length > 0
      ? flowPlaylistConfig.appendStaticPlaylistTracks(safePlaylistId, tracksToAdd)
      : playlist;
  const queued =
    tracksToAdd.length > 0
      ? await seedStaticPlaylistTracks(safePlaylistId, tracksToAdd)
      : { jobIds: [], reusedJobIds: [], createdJobIds: [], tracksQueued: 0, tracksReused: 0 };
  if (tracksToAdd.length > 0) {
    schedulePlaylistMbidEnrichment(safePlaylistId, {
      reason: "shared-playlist-append",
      priority: 5,
    });
  }
  return {
    success: true,
    playlist: updatedPlaylist,
    tracksQueued: queued.tracksQueued,
    tracksReused: queued.tracksReused,
    jobIds: queued.createdJobIds,
  };
}

async function updateStaticPlaylistLocked({
  playlistId,
  name = null,
  tracks = [],
  hasNameUpdate = false,
  hasTracksUpdate = false,
  hasImportSourceUpdate = false,
  importSource = null,
  deleteUnsharedFiles = false,
  mergeImportSource = false,
}: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const currentPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!currentPlaylist) return { missing: true };
  const importSourcePatch = isRecord(importSource) ? importSource : null;
  const safeName = hasNameUpdate
    ? String(name || "").trim()
    : String(currentPlaylist.name || "").trim();
  let playlist = null as ReturnType<typeof flowPlaylistConfig.updateStaticPlaylist> | null;
  let tracksQueued = 0;
  let tracksReused = 0;
  let affectedPlaylistIds: string[] = [];
  if (!hasTracksUpdate) {
    await withPlaylistMutationLock(safePlaylistId, async () => {
      const lockedPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
      const lockedImportSource = lockedPlaylist?.importSource || currentPlaylist.importSource;
      const importSourceToStore =
        mergeImportSource && hasImportSourceUpdate
          ? { ...lockedImportSource, ...(importSourcePatch || {}) }
          : importSourcePatch;
      playlist = flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, {
        ...(hasNameUpdate ? { name: safeName } : {}),
        ...(hasImportSourceUpdate ? { importSource: importSourceToStore } : {}),
      });
    });
  } else {
    const normalizedTracks = filterBlockedPlaylistTracks(
      currentPlaylist.ownerUserId,
      normalizeTrackList(tracks),
    );
    let deletedWhileWaiting = false;
    await withPlaylistMutation(
      getPlaylistRemovalLockIds(safePlaylistId, downloadTracker.getByPlaylistId(safePlaylistId)),
      async () => {
        const lockedPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
        if (!lockedPlaylist) {
          deletedWhileWaiting = true;
          return;
        }
        const lockedImportSource = lockedPlaylist.importSource || currentPlaylist.importSource;
        const shouldDeleteUnsharedFiles =
          deleteUnsharedFiles ||
          (mergeImportSource && lockedImportSource?.keepRemovedTracks === false);
        const existingJobs = downloadTracker
          .getByPlaylistType(safePlaylistId)
          .filter((job) => !job.upgradeForJobId);
        const matchedJobIds = new Set();
        const groupJobsBy = (buildKey: typeof buildPlaylistTrackIdentity) => {
          const groups = new Map<string | null, DownloadJob[]>();
          for (const job of existingJobs) {
            const key = buildKey(job);
            if (key) groups.set(key, [...(groups.get(key) || []), job]);
          }
          for (const [key, jobs] of groups) groups.set(key, sortJobsForTrackReuse(jobs));
          return groups;
        };
        const takeReusableJob = (jobs: DownloadJob[] = []) => {
          const index = jobs.findIndex((job) => !matchedJobIds.has(job.id));
          if (index < 0) return null;
          const [job] = jobs.splice(index, 1);
          return job;
        };
        const matchKeys = mergeImportSource
          ? [buildPlaylistTrackIdentity, buildImportTrackIdentity, buildCoreTrackIdentity]
          : [buildPlaylistTrackIdentity];
        let tracksNeedingWork = normalizedTracks;
        for (const buildKey of matchKeys) {
          const jobsByKey = groupJobsBy(buildKey);
          tracksNeedingWork = tracksNeedingWork.filter((track) => {
            const matchedJob = takeReusableJob(jobsByKey.get(buildKey(track)));
            if (matchedJob) matchedJobIds.add(matchedJob.id);
            return !matchedJob;
          });
        }

        const removedJobs = existingJobs.filter((job) => !matchedJobIds.has(job.id));
        const latestImportSource =
          flowPlaylistConfig.getStaticPlaylist(safePlaylistId)?.importSource;
        const importSourceToStore =
          mergeImportSource && hasImportSourceUpdate
            ? { ...(latestImportSource || lockedImportSource), ...(importSourcePatch || {}) }
            : importSourcePatch;
        const removal = await removeStaticPlaylistSelectionsLocked({
          playlistId: safePlaylistId,
          selections: removedJobs
            .map((job) => captureStaticPlaylistSelection(lockedPlaylist, job.id))
            .filter((selection): selection is NonNullable<typeof selection> => Boolean(selection)),
          deleteFiles: Boolean(shouldDeleteUnsharedFiles),
          requireAll: true,
          onCommitted: () => {
            playlist = flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, {
              ...(hasNameUpdate ? { name: safeName } : {}),
              tracks: normalizedTracks,
              ...(hasImportSourceUpdate ? { importSource: importSourceToStore } : {}),
            });
          },
        });
        affectedPlaylistIds = removal.affectedPlaylistIds;
        const queued = await queueTracksForPlaylist(tracksNeedingWork, safePlaylistId);
        tracksQueued = queued.jobIds.length;
        tracksReused = matchedJobIds.size + queued.reusedJobIds.length;
      },
      { clearPending: false },
    );
    if (deletedWhileWaiting) return { missing: true };
  }

  playlistManager.requestPlaylistSync([safePlaylistId, ...affectedPlaylistIds]);
  await playlistManager.scheduleScanLibrary(true);
  await finalizeRetainedPlaylistRelocations(safePlaylistId, {
    downloadRoot: downloadWorker.downloadRoot,
  });
  if (tracksQueued > 0) {
    await wakeDownloadWorker();
    recordPlaylistHistory(safePlaylistId, { tracksQueued });
  }
  schedulePlaylistMbidEnrichment(safePlaylistId, {
    reason: hasTracksUpdate ? "shared-playlist-track-update" : "shared-playlist-update",
    priority: 5,
  });
  return { success: true, playlist, tracksQueued, tracksReused };
}

async function deleteStaticPlaylistTrack({ playlistId, jobId }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return { missingPlaylist: true };
  await cleanupRemovedPlaylistFiles(safePlaylistId);
  const synchronizationKey = `playlistTrackRemovalSync:${safePlaylistId}:${safeJobId}`;
  const job = downloadTracker.getJob(safeJobId);
  const selection = job && captureStaticPlaylistSelection(playlist, safeJobId);
  if (!selection) {
    playlistManager.requestPlaylistSync(
      dbOps.getJSONSetting(synchronizationKey, listOf(v.string())) ?? [safePlaylistId],
    );
    await playlistManager.scheduleScanLibrary(true);
    await finalizeRetainedPlaylistRelocations(safePlaylistId, {
      downloadRoot: downloadWorker.downloadRoot,
    });
    db.prepare("DELETE FROM settings WHERE key = ?").run(synchronizationKey);
    return { missingJob: true };
  }
  let affectedPlaylistIds: string[] = [];
  await withStaticPlaylistRemovalMutation(
    { playlistId: safePlaylistId, jobIds: [job.id] },
    async () => {
      const result = await removeStaticPlaylistSelectionsLocked({
        playlistId: safePlaylistId,
        selections: [selection],
        deleteFiles: true,
        onCommitted: (_outcomes, ids) =>
          db
            .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
            .run(synchronizationKey, JSON.stringify(ids)),
      });
      affectedPlaylistIds = result.affectedPlaylistIds;
      const failed = result.outcomes.find((outcome) => outcome.status === "failed");
      if (failed) throw new Error(failed.message);
    },
  );
  const updatedPlaylist = (await syncStaticPlaylistConfigFromJobs(safePlaylistId)) || playlist;
  playlistManager.requestPlaylistSync(affectedPlaylistIds);
  await playlistManager.scheduleScanLibrary(true);
  await finalizeRetainedPlaylistRelocations(safePlaylistId, {
    downloadRoot: downloadWorker.downloadRoot,
  });
  db.prepare("DELETE FROM settings WHERE key = ?").run(synchronizationKey);
  return {
    success: true,
    playlist: updatedPlaylist,
    removedJobId: safeJobId,
  };
}

async function researchPlaylistTrack({ playlistId, jobId }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const isLibraryJob = safePlaylistId === "library";
  const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  const flow = flowPlaylistConfig.getFlow(safePlaylistId);
  if (!isLibraryJob && !staticPlaylist && !flow) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  if (!job || job.playlistType !== safePlaylistId) {
    return { missingJob: true };
  }
  if (job.status === "pending" || job.status === "downloading") {
    return { alreadyProcessing: true };
  }
  const previousFinalPath = job.finalPath;
  if (job.status === "done" && job.managedBy === "aurral" && isAurralOwnedPath(job.finalPath)) {
    const replacementJobId = downloadTracker.addReplacementSearchJob(job);
    if (!replacementJobId) {
      return { alreadyProcessing: true };
    }
    if (!downloadTracker.enqueueDownloadPipeline(replacementJobId)) {
      const replacementJob = downloadTracker.getJob(replacementJobId);
      const { finalizeQualityUpgradeFailure } = await import("../qualityProfileService.ts");
      await finalizeQualityUpgradeFailure(replacementJob!, "Could not queue a replacement search");
      return { success: false, queueFailed: true };
    }
    const replacementJob = downloadTracker.getJob(replacementJobId);
    recordTrackJobQueued(replacementJob);
    return {
      success: true,
      replacementSearch: true,
      jobId: replacementJobId,
      playlistId: safePlaylistId,
    };
  }
  const requeue = () => {
    if (job.status === "cancelled" && !job.requestGroupId)
      restoreDownloadJobCancellations([safeJobId]);
    if (!downloadTracker.setPending(safeJobId, null)) {
      throw new Error("Failed to requeue track");
    }
    recordTrackJobSearching(downloadTracker.getJob(safeJobId));
  };
  if (isLibraryJob) {
    requeue();
    await wakeDownloadWorker();
    return { success: true, reused: false, jobId: safeJobId, playlistId: safePlaylistId };
  }
  let reused = false;
  await withPlaylistMutation(
    safePlaylistId,
    async () => {
      const { existingFileMode } = downloadWorker.getWorkerSettings();
      const mode = normalizeExistingFileMode(existingFileMode);
      if (mode !== "download" && (job.status === "done" || job.status === "failed")) {
        const reuse = await reuseTrackForPlaylist(job, safePlaylistId, {
          existingFileMode: mode,
          downloadRoot: downloadWorker.downloadRoot,
          existingJobId: safeJobId,
          excludeJobIds: [safeJobId],
        });
        if (reuse.reused) {
          reused = true;
          const updatedJob = downloadTracker.getJob(safeJobId);
          if (
            previousFinalPath &&
            updatedJob?.finalPath &&
            updatedJob.finalPath !== previousFinalPath
          ) {
            await removePlaylistLocalTrackFile({ finalPath: previousFinalPath }, safePlaylistId);
          }
          return;
        }
      }
      await removePlaylistLocalTrackFile(job, safePlaylistId);
      requeue();
    },
    { clearPending: false },
  );
  playlistManager.requestPlaylistSync([safePlaylistId]);
  playlistManager.scheduleScanLibrary();
  if (!reused) {
    await restartWorkerIfPending();
    if (downloadWorker.running) {
      downloadWorker.wake();
    }
  }
  return {
    success: true,
    reused,
    jobId: safeJobId,
    playlistId: safePlaylistId,
  };
}

async function researchLibraryTrack({ trackId, albumId }: OperationPayload = {}) {
  const sourceJob = resolveAurralOwnedTrackJob({ trackId, albumId });
  if (!sourceJob) return { missingAurralOwnedTrack: true };
  if (downloadTracker.findActiveUpgradeJob(sourceJob)) {
    return { alreadyProcessing: true };
  }

  const replacementJobId = downloadTracker.addReplacementSearchJob(sourceJob);
  if (!replacementJobId) return { alreadyProcessing: true };
  if (!downloadTracker.enqueueDownloadPipeline(replacementJobId)) {
    const replacementJob = downloadTracker.getJob(replacementJobId);
    const { finalizeQualityUpgradeFailure } = await import("../qualityProfileService.ts");
    await finalizeQualityUpgradeFailure(replacementJob!, "Could not queue a replacement search");
    return { success: false, queueFailed: true };
  }

  const replacementJob = downloadTracker.getJob(replacementJobId);
  recordTrackJobQueued(replacementJob);
  return {
    success: true,
    replacementSearch: true,
    jobId: replacementJobId,
    trackId: Number(trackId),
  };
}

async function deleteStaticPlaylist({ playlistId }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const exists = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!exists) {
    await finalizeRetainedPlaylistRelocations(safePlaylistId, {
      downloadRoot: downloadWorker.downloadRoot,
    });
    return false;
  }
  const jobs = downloadTracker.getByPlaylistId(safePlaylistId);
  const selectionIds = [
    ...new Set([
      ...jobs.filter((job) => !job.upgradeForJobId).map((job) => job.id),
      ...exists.tracks
        .map((track) => track.canonicalJobId)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];
  const selections = selectionIds
    .map((id) => captureStaticPlaylistSelection(exists, id))
    .filter((selection): selection is NonNullable<typeof selection> => Boolean(selection));
  let deleted = false;
  let affectedPlaylistIds: string[] = [];
  try {
    await withStaticPlaylistRemovalMutation(
      { playlistId: safePlaylistId, jobIds: jobs.map((job) => job.id) },
      async () => {
        const result = await removeStaticPlaylistSelectionsLocked({
          playlistId: safePlaylistId,
          selections,
          deleteFiles: true,
          requireAll: true,
        });
        affectedPlaylistIds = result.affectedPlaylistIds;
        const failed = result.outcomes.find((outcome) => outcome.status === "failed");
        if (failed) throw new Error(failed.message);
        await cancelPlaylistDownloadWork(
          safePlaylistId,
          downloadTracker.getByPlaylistId(safePlaylistId),
          { lock: false },
        );
        void downloadWorker.setRetryCyclePaused(safePlaylistId, false);
        playlistManager.updateConfig();
        const playlistJobs = downloadTracker.getByPlaylistId(safePlaylistId);
        const removedJobIds = playlistJobs.map((job) => job.id);
        for (const job of playlistJobs) {
          if (!jobDownloadedItsFile(job) || job.upgradeForJobId) {
            continue;
          }
          await removePlaylistFileIfUnshared(job.finalPath, safePlaylistId, {
            downloadRoot: downloadWorker.downloadRoot,
            excludeJobIds: removedJobIds,
            deleteIfUnshared: true,
          });
        }
        await playlistManager.weeklyReset([safePlaylistId], { protectPlayback: true });
        downloadTracker.clearByPlaylistId(safePlaylistId);
        deleted = flowPlaylistConfig.deleteStaticPlaylist(safePlaylistId);
      },
    );
  } catch (error) {
    restorePlaylistDownloadWork(
      safePlaylistId,
      downloadTracker.getByPlaylistId(safePlaylistId).map((job) => job.id),
    );
    throw error;
  } finally {
    playlistManager.requestPlaylistSync([safePlaylistId, ...affectedPlaylistIds]);
  }
  await restartWorkerIfPending();
  await finalizeRetainedPlaylistRelocations(safePlaylistId, {
    downloadRoot: downloadWorker.downloadRoot,
  });
  return deleted;
}

export const playlistOperationSchema = v.looseObject({ kind: v.string() });

export async function processPlaylistOperation(
  payload: v.InferOutput<typeof playlistOperationSchema>,
) {
  const { kind } = payload;
  return withHonkerLock(
    "weekly-flow-operation",
    async () => {
      switch (kind) {
        case "share-import":
          return (await import("../shareLinks/import.ts")).importShare(payload);
        case "manual-start-flow":
          return runFlowSeed(payload);
        case "scheduled-flow-refresh":
          return runFlowSeed({
            ...payload,
            requireEnabled: true,
            scheduleNext: true,
          });
        case "enable-flow-refresh":
          return runFlowSeed({
            ...payload,
            requireEnabled: true,
          });
        case "disable-flow-cleanup":
          return runFlowCleanup(payload);
        case "delete-flow":
          return deleteFlow(payload);
        case "reset-playlists":
          return resetPlaylists(payload);
        case "adopt-flow-seed":
          return adoptFlowSeed(payload);
        case "shared-playlist-create":
          return createStaticPlaylist(payload);
        case "shared-playlist-append-tracks":
          return appendStaticPlaylistTracks(payload);
        case "shared-playlist-update":
          return updateStaticPlaylist(payload);
        case "shared-playlist-bulk": {
          const { processStaticPlaylistBulkOperation } = await import("./bulkOperations.ts");
          return processStaticPlaylistBulkOperation(payload.operationId);
        }
        case "shared-playlist-delete-track":
          return deleteStaticPlaylistTrack(payload);
        case "shared-playlist-research-track":
          return researchPlaylistTrack(payload);
        case "library-track-research":
          return researchLibraryTrack(payload);
        case "shared-playlist-delete":
          return deleteStaticPlaylist(payload);
        default:
          throw new Error(`Unknown playlist operation: ${kind || "unknown"}`);
      }
    },
    {
      ttlSeconds: 180,
      waitTimeoutMs: 30 * 60 * 1000,
      retryDelayMs: 250,
    },
  );
}
