import { db } from "../../config/db-sqlite.ts";
import { DEFAULT_FLOW_SIZE } from "../../../lib/flows.ts";
import { randomUUID } from "crypto";
import * as v from "valibot";
import { asAppError } from "../../../lib/errors.ts";
import { dbOps, userOps } from "../../db/helpers/index.ts";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
  recordTrackJobQueued,
  recordTrackJobSearching,
} from "../aurralHistoryService.ts";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import {
  buildCoreTrackIdentity,
  buildImportTrackIdentity,
  buildPlaylistTrackIdentity,
  filterMissingPlaylistTracks,
  normalizePlaylistTrack,
  tracksShareMembership,
} from "./playlistTracks.ts";
import {
  fileExists,
  removePlaylistFileIfUnshared,
  reuseTrackForPlaylist,
} from "../downloadJobs/fileReuse.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { resolveAurralOwnedTrackJob } from "../libraryTrackResearchService.ts";
import { isAurralOwnedPath } from "../qualityProfile.ts";
import { playlistManager } from "./playlistManager.ts";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import { withPlaylistMutationLock } from "../downloadJobs/downloadLocks.ts";
import { withPlaylistMutation } from "../downloadJobs/mutationGuards.ts";
import { withLock } from "../jobs/queue.ts";
import { flowRunSpec } from "../flows/flowTrackSource.ts";
import type { DownloadJob } from "../downloadJobs/downloadTracker.ts";
import type { ArtistMatchFields } from "../discovery/artistKeys.ts";
import type { FlowConfig, StaticPlaylist } from "./flowPlaylistConfig.ts";
import type { PlaylistTrack, PlaylistTrackInput } from "./playlistTracks.ts";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.ts";
import { filterBlockedArtistsForUser } from "../discovery/feedback.ts";
import {
  activatePlaylistDownloadGeneration,
  restoreDownloadJobCancellations,
} from "../downloadJobs/downloadCancellation.ts";
import { cancelPlaylistDownloadWork } from "../downloadJobs/downloadCancellationService.ts";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";
import type {
  LibraryAlbumTracksRow,
  LibraryMediaFilesRow,
  LibraryTracksRow,
} from "../../db/rows.ts";
import { discardLibraryJobs, linkTracksToLibrary, releaseLibraryJobs } from "./playlistLibrary.ts";
import { unknownList } from "../../../lib/unknownList.ts";
import { isRecord } from "../../../lib/isRecord.ts";
import { finalizeQualityUpgradeFailure } from "../qualityUpgradeOutcome.ts";

const operationTokenKey = (scope: string) => `playlistOperationTokens:${encodeURIComponent(scope)}`;

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
  return dbOps.getJSONSetting(operationTokenKey(safeScope), v.string());
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
  return unknownList(value)
    .map((track) => normalizePlaylistTrack(track && typeof track === "object" ? track : null))
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

interface FlowOutcome {
  cancelled?: boolean;
  missing?: boolean;
  skipped?: boolean;
  inactiveOwner?: boolean;
  jobIds?: string[];
  tracksQueued?: number;
  empty?: boolean;
  flowName?: string;
}

const withPlaylistOperationLock = <T>(operation: () => T) =>
  withLock("playlist-operation", operation, {
    ttlMs: 180_000,
    waitTimeoutMs: 30 * 60 * 1000,
    retryDelayMs: 250,
  });

const flowSeedingWorker = () => {
  if (!("seedFlowRun" in downloadWorker)) {
    throw new TypeError("Flows are seeded by the download worker process");
  }
  return downloadWorker;
};

const removePlaylistLocalTrackFile = async (
  job: Partial<Pick<DownloadJob, "id" | "finalPath">> | null | undefined,
  playlistId: string,
) => {
  if (!job || typeof job.finalPath !== "string") return;
  await removePlaylistFileIfUnshared(job.finalPath, playlistId, {
    downloadRoot: downloadWorker.downloadRoot,
    excludeJobIds: job.id ? [job.id] : [],
  });
};

async function reuseSavedFlowTracks(flowId: string, jobIds: string[]) {
  for (const jobId of jobIds) {
    const job = downloadTracker.getJob(jobId);
    if (job?.status !== "saved") continue;
    await reuseTrackForPlaylist(job, flowId, {
      downloadRoot: downloadWorker.downloadRoot,
      existingJobId: jobId,
      excludeJobIds: [jobId],
      skipHistory: true,
    }).catch((error: unknown) => {
      console.warn(
        `[Flows] Reuse failed for ${job.artistName} - ${job.trackName}: ${asAppError(error)?.message || error}`,
      );
    });
  }
}

const indexedFileStmt = db.prepare<
  [string],
  Pick<LibraryMediaFilesRow, "path" | "source" | "duration_ms"> &
    Pick<LibraryTracksRow, "title"> &
    Partial<Pick<LibraryAlbumTracksRow, "track_number" | "disc_number">> & {
      track_mbid: string | null;
      artist_name: string | null;
      artist_mbid: string | null;
      album_title: string | null;
      album_mbid: string | null;
    }
>(`
  SELECT media.path, media.source, media.duration_ms, track.title, track.mbid AS track_mbid,
    COALESCE(track.artist_name, artist.name) AS artist_name,
    CASE WHEN track.artist_name IS NULL OR track.artist_name = artist.name THEN artist.mbid END AS artist_mbid,
    album.title AS album_title, album.release_group_mbid AS album_mbid,
    link.track_number, link.disc_number
  FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  LEFT JOIN library_album_tracks AS link ON link.track_id = media.track_id AND link.album_id = media.album_id
  LEFT JOIN library_albums AS album ON album.id = media.album_id
  LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE media.path = ? AND media.available = 1 AND media.source != 'flow'
  LIMIT 1
`);

const linkIndexedFiles = async (tracks: unknown, ownerUserId: unknown) => {
  const libraryJobsByPath = new Map(
    downloadTracker
      .getAll()
      .filter((job) => job.playlistType === "library" && job.status === "done" && job.finalPath)
      .map((job) => [job.finalPath, job] as const),
  );
  const linked: unknown[] = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const file =
      isRecord(track) && typeof track.path === "string" ? indexedFileStmt.get(track.path) : null;
    const input =
      file &&
      normalizePlaylistTrack({
        artistName: file.artist_name,
        trackName: file.title,
        albumName: file.album_title,
        artistMbid: file.artist_mbid,
        albumMbid: file.album_mbid,
        trackMbid: file.track_mbid,
        durationMs: file.duration_ms,
        trackNumber: file.track_number,
        discNumber: file.disc_number,
      });
    if (!file || !input || !filterBlockedPlaylistTracks(ownerUserId, [input]).length) {
      linked.push(track);
      continue;
    }
    const finalPath =
      file.source === "lidarr" ? resolveLocalPath(file.path, getPathMappings("lidarr")) : file.path;
    const existing = libraryJobsByPath.get(finalPath);
    if (existing) {
      linked.push({ ...input, canonicalJobId: existing.id });
      continue;
    }
    const jobId = (await fileExists(finalPath)) && downloadTracker.addJob(input, "library");
    if (!jobId) {
      linked.push(track);
      continue;
    }
    const external = file.source === "lidarr" || file.source === "readonly";
    downloadTracker.setDone(jobId, finalPath, input.albumName, external ? file.path : null, {
      reusedLibraryFile: true,
    });
    libraryJobsByPath.set(finalPath, downloadTracker.getJob(jobId)!);
    linked.push({ ...input, canonicalJobId: jobId });
  }
  return linked;
};

const recordPlaylistHistory = (playlistId: string, { tracksQueued = 0, tracksReused = 0 } = {}) => {
  if (tracksQueued + tracksReused <= 0) return;
  recordPlaylistTracksAdded({
    playlistId,
    tracksQueued,
    tracksReused,
  });
};

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
  if (requireEnabled && flow.enabled !== true) return { skipped: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const effectiveSize =
    Number.isFinite(Number(size)) && Number(size) > 0
      ? Number(size)
      : flow.size || DEFAULT_FLOW_SIZE;
  const spec = flowRunSpec(flow);
  const recipe = JSON.stringify(spec);
  const assertRecipeUnchanged = (current: FlowConfig) => {
    if (JSON.stringify(flowRunSpec(current)) !== recipe) {
      throw new Error("Flow settings changed while planning; retrying");
    }
  };
  const preparedPlan = await flowSeedingWorker().prepareFlowRunPlan(spec, {
    size: effectiveSize,
  });

  const result = await withPlaylistOperationLock(() =>
    withPlaylistMutation(
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
        assertRecipeUnchanged(latestFlow);

        activatePlaylistDownloadGeneration(safeFlowId);
        recordFlowGenerationStarted({ flowId: safeFlowId });
        await playlistManager.weeklyReset([safeFlowId]);
        downloadTracker.clearByPlaylistId(safeFlowId);

        if (!isLatestPlaylistOperationToken(tokenScope, token)) {
          return { cancelled: true };
        }
        const autoDownload = latestFlow.autoDownload && isAnyDownloadSourceConfigured();
        const seeded = await flowSeedingWorker().seedFlowRun(safeFlowId, latestFlow, {
          size: effectiveSize,
          plan: preparedPlan,
          saved: !autoDownload,
        });
        if (!autoDownload) await reuseSavedFlowTracks(safeFlowId, seeded.jobIds);
        playlistManager.requestPlaylistSync([safeFlowId]);
        if (scheduleNext) {
          flowPlaylistConfig.scheduleNextRun(safeFlowId);
        }
        return {
          jobIds: seeded?.jobIds || [],
          tracksQueued: autoDownload ? seeded.tracksQueued : 0,
          empty: seeded.tracksQueued === 0,
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
          assertRecipeUnchanged(current);
          const existingFlowJobs = downloadTracker.getByPlaylistId(safeFlowId);
          await cancelPlaylistDownloadWork(safeFlowId, existingFlowJobs, { lock: false });
          if (!isLatestPlaylistOperationToken(tokenScope, token)) {
            return { cancelled: true };
          }
          return undefined;
        },
      },
    ),
  );

  if (Array.isArray(result?.jobIds)) rescanLibraryForFlows([safeFlowId]);
  if (result?.tracksQueued && result.tracksQueued > 0) {
    recordFlowTracksGenerated({
      flowId: safeFlowId,
      tracksQueued: result.tracksQueued,
    });
  } else {
    recordFlowTracksGenerated({ flowId: safeFlowId, tracksFound: result?.jobIds?.length });
  }
  return result;
}

async function downloadSavedFlowTracks({ flowId }: OperationPayload = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!flowPlaylistConfig.getFlow(safeFlowId)) return { missing: true };
  let queued = 0;
  for (const job of downloadTracker.getByPlaylistType(safeFlowId)) {
    if (job.status !== "saved" || !downloadTracker.setPending(job.id, null)) continue;
    recordTrackJobQueued(downloadTracker.getJob(job.id));
    queued += 1;
  }
  playlistManager.requestPlaylistSync([safeFlowId]);
  return { queued };
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
    await playlistManager.weeklyReset([safeFlowId]);
    downloadTracker.clearByPlaylistId(safeFlowId);
  });
  rescanLibraryForFlows([safeFlowId]);
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
    await playlistManager.weeklyReset([safeFlowId]);
    downloadTracker.clearByPlaylistId(safeFlowId);
    didDelete = flowPlaylistConfig.deleteFlow(safeFlowId);
  });
  if (didDelete) {
    playlistManager.requestPlaylistSync([safeFlowId]);
    playlistManager.scheduleScanLibrary();
  }
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
    await playlistManager.weeklyReset(types);
  });
  rescanLibraryForFlows(types);
  return { success: true, playlistTypes: types };
}

function afterTracksLinked(
  playlistId: string,
  {
    queuedJobIds,
    reusedJobIds,
  }: Pick<Awaited<ReturnType<typeof linkTracksToLibrary>>, "queuedJobIds" | "reusedJobIds">,
  reason: string,
) {
  playlistManager.requestPlaylistSync([playlistId]);
  if (reusedJobIds.length > 0) playlistManager.scheduleScanLibrary();
  recordPlaylistHistory(playlistId, {
    tracksQueued: queuedJobIds.length,
    tracksReused: reusedJobIds.length,
  });
  schedulePlaylistMbidEnrichment(playlistId, { reason, priority: 5 });
}

async function createStaticPlaylist({
  playlistId,
  name,
  sourceName = null,
  sourceFlowId = null,
  discoverPresetId = null,
  tracks = [],
  ownerUserId = null,
  importSource = null,
  description = null,
  downloadMissing = true,
}: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim() || randomUUID();
  const existing = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (existing) {
    return { success: true, playlist: existing, tracksQueued: 0, tracksReused: 0, jobIds: [] };
  }
  const allowedTracks = filterBlockedPlaylistTracks(
    ownerUserId,
    normalizeTrackList(await linkIndexedFiles(tracks, ownerUserId)),
  );
  const linked = await linkTracksToLibrary(allowedTracks, {
    startedByPlaylist: safePlaylistId,
    download: downloadMissing !== false,
  });
  let playlist;
  try {
    playlist = flowPlaylistConfig.createStaticPlaylist({
      id: safePlaylistId,
      name,
      sourceName,
      sourceFlowId,
      discoverPresetId,
      tracks: linked.tracks,
      ownerUserId,
      importSource: isRecord(importSource) ? importSource : null,
      description,
    });
  } catch (error) {
    await discardLibraryJobs(linked.createdJobIds);
    throw error;
  }
  await playlistManager.ensurePlaylistArtwork(safePlaylistId);
  if (linked.tracks.length > 0) afterTracksLinked(safePlaylistId, linked, "static-playlist-create");
  else playlistManager.requestPlaylistSync([safePlaylistId]);
  return {
    success: true,
    playlist,
    tracksQueued: linked.queuedJobIds.length,
    tracksReused: linked.reusedJobIds.length,
    jobIds: linked.createdJobIds,
  };
}

async function appendStaticPlaylistTracks({ playlistId, tracks = [] }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return { missing: true };
  const tracksToAdd = filterMissingPlaylistTracks(
    playlist.tracks,
    filterBlockedPlaylistTracks(playlist.ownerUserId, normalizeTrackList(tracks)),
  );
  if (tracksToAdd.length === 0) {
    return { success: true, playlist, tracksQueued: 0, tracksReused: 0, jobIds: [] };
  }
  const linked = await linkTracksToLibrary(tracksToAdd, { startedByPlaylist: safePlaylistId });
  const updatedPlaylist = await withPlaylistMutationLock(safePlaylistId, () =>
    flowPlaylistConfig.appendStaticPlaylistTracks(safePlaylistId, linked.tracks),
  );
  if (!updatedPlaylist) {
    await discardLibraryJobs(linked.createdJobIds);
    return { missing: true };
  }
  afterTracksLinked(safePlaylistId, linked, "static-playlist-append");
  return {
    success: true,
    playlist: updatedPlaylist,
    tracksQueued: linked.queuedJobIds.length,
    tracksReused: linked.reusedJobIds.length,
    jobIds: linked.createdJobIds,
  };
}

function matchCurrentTracks(
  current: StaticPlaylist["tracks"],
  incoming: PlaylistTrack[],
  matchKeys: ((track: PlaylistTrackInput) => string)[],
) {
  const unused = new Map(
    current
      .filter((track) => downloadTracker.getJob(track.canonicalJobId)?.playlistType === "library")
      .map((track, index) => [index, track] as const),
  );
  const assigned = new Map<number, string>();
  const referencedJob = (track: PlaylistTrackInput) => {
    const job = downloadTracker.getJob(String(track.canonicalJobId || ""));
    return job && tracksShareMembership(job, track) ? job.id : "";
  };
  for (const key of [referencedJob, ...matchKeys]) {
    const byKey = new Map<string, number[]>();
    for (const [index, track] of unused) {
      const value = key(track);
      if (value) byKey.set(value, [...(byKey.get(value) ?? []), index]);
    }
    incoming.forEach((track, index) => {
      if (assigned.has(index)) return;
      const match = byKey.get(key(track))?.find((candidate) => unused.has(candidate));
      if (match === undefined) return;
      assigned.set(index, unused.get(match)!.canonicalJobId!);
      unused.delete(match);
    });
  }
  return { assigned, unusedJobIds: [...unused.values()].map((track) => track.canonicalJobId!) };
}

async function updateStaticPlaylistLocked({
  playlistId,
  name = null,
  tracks = [],
  hasNameUpdate = false,
  hasTracksUpdate = false,
  hasImportSourceUpdate = false,
  importSource = null,
  mergeImportSource = false,
}: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const currentPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!currentPlaylist) return { missing: true };
  const importSourcePatch = isRecord(importSource) ? importSource : null;
  const safeName = hasNameUpdate
    ? String(name || "").trim()
    : String(currentPlaylist.name || "").trim();
  const nextImportSource = (stored: StaticPlaylist["importSource"]) =>
    mergeImportSource && hasImportSourceUpdate
      ? { ...stored, ...importSourcePatch }
      : importSourcePatch;
  const normalizedTracks = hasTracksUpdate
    ? filterBlockedPlaylistTracks(currentPlaylist.ownerUserId, normalizeTrackList(tracks))
    : [];
  let createdJobIds: string[] = [];
  const result = await withPlaylistMutationLock(safePlaylistId, async () => {
    const lockedPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
    if (!lockedPlaylist) return null;
    const lockedImportSource = lockedPlaylist.importSource || currentPlaylist.importSource;
    const metadata = {
      ...(!!hasNameUpdate && { name: safeName }),
      ...(!!hasImportSourceUpdate && { importSource: nextImportSource(lockedImportSource) }),
    };
    if (!hasTracksUpdate) {
      return { playlist: flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, metadata) };
    }
    const { assigned, unusedJobIds } = matchCurrentTracks(
      lockedPlaylist.tracks,
      normalizedTracks,
      mergeImportSource
        ? [buildPlaylistTrackIdentity, buildImportTrackIdentity, buildCoreTrackIdentity]
        : [buildPlaylistTrackIdentity],
    );
    const linked = await linkTracksToLibrary(
      normalizedTracks.filter((_, index) => !assigned.has(index)),
      { startedByPlaylist: safePlaylistId },
    );
    createdJobIds = linked.createdJobIds;
    const linkedTracks = [...linked.tracks];
    const nextTracks = normalizedTracks.map((track, index) =>
      assigned.has(index)
        ? { ...track, canonicalJobId: assigned.get(index) }
        : linkedTracks.shift()!,
    );
    const keptJobIds = new Set(nextTracks.map((track) => track.canonicalJobId));
    return {
      playlist: flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, {
        ...metadata,
        tracks: nextTracks,
      }),
      linked,
      tracksReused: assigned.size + linked.reusedJobIds.length,
      removedJobIds: unusedJobIds.filter((jobId) => !keptJobIds.has(jobId)),
      dropFiles: Boolean(mergeImportSource && lockedImportSource?.keepRemovedTracks === false),
    };
  }).catch(async (error: unknown) => {
    await discardLibraryJobs(createdJobIds);
    throw error;
  });
  if (!result?.playlist) return { missing: true };
  const { playlist, linked, tracksReused = 0, removedJobIds = [], dropFiles } = result;
  await releaseLibraryJobs(safePlaylistId, removedJobIds, { dropFiles });
  const tracksQueued = linked?.queuedJobIds.length ?? 0;
  playlistManager.requestPlaylistSync([safePlaylistId]);
  if (linked?.reusedJobIds.length) playlistManager.scheduleScanLibrary();
  if (tracksQueued > 0) recordPlaylistHistory(safePlaylistId, { tracksQueued });
  schedulePlaylistMbidEnrichment(safePlaylistId, {
    reason: hasTracksUpdate ? "static-playlist-track-update" : "static-playlist-update",
    priority: 5,
  });
  return { success: true, playlist, tracksQueued, tracksReused };
}

export const updateStaticPlaylist = (payload: OperationPayload) =>
  withPlaylistOperationLock(() => updateStaticPlaylistLocked(payload));

async function deleteStaticPlaylistTrack({ playlistId, jobId }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  if (!flowPlaylistConfig.getStaticPlaylist(safePlaylistId)) return { missingPlaylist: true };
  const playlist = await withPlaylistMutationLock(safePlaylistId, () => {
    const current = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
    const tracks = current?.tracks.filter((track) => track.canonicalJobId !== safeJobId);
    if (!current || !tracks || tracks.length === current.tracks.length) return null;
    return flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, { tracks });
  });
  if (!playlist) return { missingJob: true };
  await releaseLibraryJobs(safePlaylistId, [safeJobId]);
  playlistManager.requestPlaylistSync([safePlaylistId]);
  return { success: true, playlist, removedJobId: safeJobId };
}

async function researchPlaylistTrack({ playlistId, jobId }: OperationPayload = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  const flow = flowPlaylistConfig.getFlow(safePlaylistId);
  if (safePlaylistId !== "library" && !staticPlaylist && !flow) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  const isLibraryJob =
    job?.playlistType === "library" &&
    (!staticPlaylist || staticPlaylist.tracks.some((track) => track.canonicalJobId === job.id));
  if (!job || (!isLibraryJob && job.playlistType !== safePlaylistId)) {
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
    return { success: true, reused: false, jobId: safeJobId, playlistId: safePlaylistId };
  }
  let reused = false;
  await withPlaylistMutation(
    safePlaylistId,
    async () => {
      if (job.status === "done" || job.status === "failed") {
        const reuse = await reuseTrackForPlaylist(job, safePlaylistId, {
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
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return false;
  const jobIds = playlist.tracks.map((track) => track.canonicalJobId);
  await playlistManager.weeklyReset([safePlaylistId]);
  const deleted = await withPlaylistMutationLock(safePlaylistId, () =>
    flowPlaylistConfig.deleteStaticPlaylist(safePlaylistId),
  );
  if (deleted) await releaseLibraryJobs(safePlaylistId, jobIds);
  playlistManager.requestPlaylistSync([safePlaylistId]);
  return deleted;
}

export const playlistOperationSchema = v.looseObject({ kind: v.string() });

export async function processPlaylistOperation(
  payload: v.InferOutput<typeof playlistOperationSchema>,
) {
  const { kind } = payload;
  if (kind === "manual-start-flow") return runFlowSeed(payload);
  if (kind === "scheduled-flow-refresh") {
    return runFlowSeed({ ...payload, requireEnabled: true, scheduleNext: true });
  }
  if (kind === "enable-flow-refresh") return runFlowSeed({ ...payload, requireEnabled: true });
  return withPlaylistOperationLock(async () => {
    switch (kind) {
      case "share-import":
        return (await import("../shareLinks/import.ts")).importShare(payload);
      case "disable-flow-cleanup":
        return runFlowCleanup(payload);
      case "flow-download-saved":
        return downloadSavedFlowTracks(payload);
      case "delete-flow":
        return deleteFlow(payload);
      case "reset-playlists":
        return resetPlaylists(payload);
      case "static-playlist-create":
        return createStaticPlaylist(payload);
      case "static-playlist-append-tracks":
        return appendStaticPlaylistTracks(payload);
      case "static-playlist-update":
        return updateStaticPlaylistLocked(payload);
      case "static-playlist-bulk": {
        const { processStaticPlaylistBulkOperation } = await import("./bulkOperations.ts");
        return processStaticPlaylistBulkOperation(payload.operationId);
      }
      case "static-playlist-delete-track":
        return deleteStaticPlaylistTrack(payload);
      case "static-playlist-research-track":
        return researchPlaylistTrack(payload);
      case "library-track-research":
        return researchLibraryTrack(payload);
      case "static-playlist-delete":
        return deleteStaticPlaylist(payload);
      default:
        throw new Error(`Unknown playlist operation: ${kind || "unknown"}`);
    }
  });
}
