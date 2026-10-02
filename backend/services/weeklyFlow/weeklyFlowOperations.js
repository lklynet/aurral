import { db } from "../../config/db-sqlite.js";
import { finalizeRetainedPlaylistRelocations } from "./weeklyFlowMediaRelocation.js";
import { randomUUID } from "crypto";
import { dbOps, userOps } from "../../db/helpers/index.js";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
  recordTrackJobQueued,
} from "../aurralHistoryService.js";
import {
  buildImportTrackIdentity,
  buildSharedTrackIdentity,
  dedupeSharedTracks,
  filterMissingSharedTracks,
  flowPlaylistConfig,
  isRetiredFlow,
  normalizeSharedTrack,
  rebuildSharedPlaylistTracksFromJobs,
  tracksShareMembership,
  DEFAULT_SIZE,
} from "./weeklyFlowPlaylistConfig.js";
import {
  normalizeExistingFileMode,
  removePlaylistFileIfUnshared,
  reuseTrackForPlaylist,
  sortJobsForTrackReuse,
} from "./weeklyFlowFileReuse.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { resolveAurralOwnedTrackJob } from "../libraryTrackResearchService.js";
import { isAurralOwnedPath } from "../qualityProfileService.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import {
  restartWorkerIfPending,
  wakeDownloadWorker,
  withPlaylistMutation,
  withPlaylistMutationLock,
} from "./weeklyFlowMutationGuards.js";
import { withHonkerLock } from "../honkerDb.js";
import { getUnavailableFlowSourceError } from "./weeklyFlowValidation.js";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.js";
import { filterBlockedArtistsForUser } from "../discovery/feedback.js";
import {
  activatePlaylistDownloadGeneration,
  isDownloadJobCancelled,
  restorePlaylistDownloadWork,
} from "./weeklyFlowDownloadCancellation.js";
import {
  cancelPlaylistDownloadWork,
} from "./weeklyFlowDownloadCancellationService.js";

import {
  captureSharedPlaylistSelection,
  cleanupRemovedPlaylistFiles,
  getPlaylistRemovalLockIds,
  removeSharedPlaylistSelectionsLocked,
  withSharedPlaylistRemovalMutation,
} from "./weeklyFlowTrackRemoval.js";

const OPERATION_TOKENS_KEY = "weeklyFlowOperationTokens";
const operationTokenKey = (scope) =>
  `${OPERATION_TOKENS_KEY}:${encodeURIComponent(scope)}`;

export function createWeeklyFlowOperationToken() {
  return `${Date.now()}-${randomUUID()}`;
}

export function markLatestWeeklyFlowOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return;
  dbOps.setJSONSetting(operationTokenKey(safeScope), safeToken);
}

export function getLatestWeeklyFlowOperationToken(scope) {
  const safeScope = String(scope || "").trim();
  if (!safeScope) return null;
  const current = dbOps.getJSONSetting(operationTokenKey(safeScope));
  if (current != null) return current;
  const legacy = dbOps.getJSONSetting(OPERATION_TOKENS_KEY) || {};
  return legacy[safeScope] ?? null;
}

export function restoreWeeklyFlowOperationToken({ scope, token, previousToken } = {}) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken || getLatestWeeklyFlowOperationToken(safeScope) !== safeToken) {
    return false;
  }
  dbOps.setJSONSetting(operationTokenKey(safeScope), previousToken ?? null);
  return true;
}

function isLatestWeeklyFlowOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return true;
  return getLatestWeeklyFlowOperationToken(safeScope) === safeToken;
}

function normalizeTrackList(value) {
  return (Array.isArray(value) ? value : [])
    .map((track) => normalizeSharedTrack(track))
    .filter(Boolean);
}

const filterBlockedPlaylistTracks = (ownerUserId, tracks) => {
  if (ownerUserId == null) return tracks;
  return filterBlockedArtistsForUser(String(ownerUserId), tracks);
};

const isOwnerActive = (ownerUserId) => {
  if (ownerUserId == null) return true;
  const owner = userOps.getUserById(Number(ownerUserId));
  return owner?.status === "active";
};

const removePlaylistLocalTrackFile = async (job, playlistId, { protectPlayback = true } = {}) => {
  if (!job || typeof job.finalPath !== "string") return;
  await removePlaylistFileIfUnshared(job.finalPath, playlistId, {
    weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
    excludeJobIds: job.id ? [job.id] : [],
    protectPlayback,
  });
};

const sharedPlaylistTracksMatchJobs = (playlist, jobs) => {
  const configTracks = dedupeSharedTracks(playlist?.tracks);
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

const getSharedPlaylistJobs = (playlist) => {
  const referencedJobs = (playlist?.tracks || [])
    .map((track) => (track?.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null))
    .filter(Boolean);
  const jobs = [...referencedJobs, ...downloadTracker.getByPlaylistType(playlist?.id)];
  return jobs.filter(
    (job, index, values) => values.findIndex((candidate) => candidate.id === job.id) === index,
  );
};

const syncSharedPlaylistConfigFromJobs = async (playlistId) => {
  const safePlaylistId = String(playlistId || "").trim();
  const playlist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!playlist) return null;
  const jobs = getSharedPlaylistJobs(playlist);
  if (sharedPlaylistTracksMatchJobs(playlist, jobs)) {
    return playlist;
  }
  const updatedPlaylist = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
    tracks: rebuildSharedPlaylistTracksFromJobs(playlist.tracks, jobs),
  });
  playlistManager.updateConfig(false);
  return updatedPlaylist;
};

const queueTracksForPlaylist = async (tracks, playlistId) => {
  const settings = weeklyFlowWorker.getWorkerSettings();
  const existingFileMode = normalizeExistingFileMode(settings.existingFileMode);
  const reusedJobIds = [];
  const jobIds = [];
  const createdJobIds = [];
  for (const track of normalizeTrackList(tracks)) {
    const canonicalJob = track.canonicalJobId
      ? downloadTracker.getJob(track.canonicalJobId)
      : null;
    if (canonicalJob && tracksShareMembership(canonicalJob, track)) {
      reusedJobIds.push(canonicalJob.id);
      continue;
    }
    const jobId = downloadTracker.addJob(track, playlistId);
    if (!jobId) continue;
    createdJobIds.push(jobId);
    try {
      const reuse = await reuseTrackForPlaylist(track, playlistId, {
        existingFileMode,
        weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
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
        `[WeeklyFlow] Reuse failed for ${track.artistName} - ${track.trackName}: ${error?.message || error}`,
      );
    }
    jobIds.push(jobId);
    recordTrackJobQueued(downloadTracker.getJob(jobId));
  }
  return { reusedJobIds, jobIds, createdJobIds };
};

const filterTracksMissingDownloadJobs = (tracks, playlistId) => {
  const existingJobs = downloadTracker.getByPlaylistType(playlistId);
  const missing = [];
  const queued = [];
  for (const track of normalizeTrackList(tracks)) {
    const canonicalJob = track.canonicalJobId
      ? downloadTracker.getJob(track.canonicalJobId)
      : null;
    const duplicate =
      Boolean(canonicalJob && tracksShareMembership(canonicalJob, track)) ||
      existingJobs.some((job) => tracksShareMembership(job, track)) ||
      queued.some((entry) => tracksShareMembership(entry, track));
    if (duplicate) continue;
    queued.push(track);
    missing.push(track);
  }
  return missing;
};

const recordPlaylistHistory = (playlistId, { tracksQueued = 0, tracksReused = 0 } = {}) => {
  if (tracksQueued + tracksReused <= 0) return;
  recordPlaylistTracksAdded({
    playlistId,
    tracksQueued,
    tracksReused,
  });
};

async function seedSharedPlaylistTracks(playlistId, tracks) {
  const playlist = flowPlaylistConfig.getSharedPlaylist(playlistId);
  const allowedTracks = filterBlockedPlaylistTracks(playlist?.ownerUserId, tracks);
  const missingTracks = filterTracksMissingDownloadJobs(allowedTracks, playlistId);
  const { reusedJobIds, jobIds, createdJobIds } = await queueTracksForPlaylist(
    missingTracks,
    playlistId,
  );
  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
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
} = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (isRetiredFlow(flow)) return { skipped: true, retired: true };
  if (!isAnyDownloadSourceConfigured()) {
    const error = new Error(getDownloadSourceNotConfiguredMessage());
    error.code = "NO_DOWNLOAD_SOURCE";
    throw error;
  }
  if (requireEnabled && flow.enabled !== true) return { skipped: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const unavailableError = getUnavailableFlowSourceError(flow.mix);
  if (unavailableError) throw new Error(unavailableError);

  const effectiveSize =
    Number.isFinite(Number(size)) && Number(size) > 0
      ? Number(size)
      : flow.size || DEFAULT_SIZE;
  const flowSnapshot = JSON.stringify(flow);
  const preparedPlan = await weeklyFlowWorker.prepareFlowRunPlan(flow, {
    size: effectiveSize,
  });

  const result = await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
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
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset([safeFlowId]);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    downloadTracker.clearByPlaylistId(safeFlowId);

    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return { cancelled: true };
    }
    const seeded = await weeklyFlowWorker.seedFlowRun(safeFlowId, latestFlow, {
      size: effectiveSize,
      plan: preparedPlan,
    });
    await playlistManager.refreshPlaylist(safeFlowId);
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
  }, {
    clearPending: false,
    async beforeMutation() {
      if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
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
      if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
        return { cancelled: true };
      }
      return undefined;
    },
  });

  if (Array.isArray(result?.jobIds)) rescanLibraryForFlows([safeFlowId]);
  if (result?.tracksQueued > 0) {
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

function rescanLibraryForFlows(flowIds) {
  const shownInLibrary = flowIds.some(
    (flowId) => flowPlaylistConfig.getFlow(flowId)?.showInLibrary === true,
  );
  if (shownInLibrary) playlistManager.scheduleScanLibrary();
}

async function runFlowCleanup({ flowId, tokenScope = null, token = null } = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return;
    }
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset([safeFlowId]);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    downloadTracker.clearByPlaylistId(safeFlowId);
  });
  rescanLibraryForFlows([safeFlowId]);
  await restartWorkerIfPending();
  return { success: true, flowId: safeFlowId };
}

async function deleteFlow({ flowId, tokenScope = null, token = null } = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return false;
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return false;
  if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  let didDelete = false;
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return;
    }
    weeklyFlowWorker.setRetryCyclePaused(safeFlowId, false);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    playlistManager.updateConfig(false);
    await playlistManager.deletePlaybackPlaylist(flow);
    await playlistManager.weeklyReset([safeFlowId], { protectPlayback: false });
    downloadTracker.clearByPlaylistId(safeFlowId);
    await playlistManager.cleanupEntityPlexPlaylists(safeFlowId);
    didDelete = flowPlaylistConfig.deleteFlow(safeFlowId);
    await playlistManager.ensureSmartPlaylists();
  });
  if (didDelete) playlistManager.scheduleScanLibrary();
  await restartWorkerIfPending();
  return didDelete;
}

async function resetPlaylists({ playlistTypes = [] } = {}) {
  const types = (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  await Promise.all(
    types.map((playlistType) =>
      cancelPlaylistDownloadWork(playlistType, downloadTracker.getByPlaylistId(playlistType)),
    ),
  );
  await withPlaylistMutation(types, async () => {
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset(types, { protectPlayback: false });
  });
  rescanLibraryForFlows(types);
  await restartWorkerIfPending();
  return { success: true, playlistTypes: types };
}

async function adoptFlowSeed({ flowId, tracks = [] } = {}) {
  const safeFlowId = String(flowId || "").trim();
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const normalizedTracks = normalizeTrackList(tracks);
  await cancelPlaylistDownloadWork(safeFlowId, downloadTracker.getByPlaylistId(safeFlowId));
  const result = await withPlaylistMutation(safeFlowId, async () => {
    const latestFlow = flowPlaylistConfig.getFlow(safeFlowId);
    if (!latestFlow) return { missing: true };
    if (!isOwnerActive(latestFlow.ownerUserId)) {
      return { skipped: true, inactiveOwner: true };
    }
    activatePlaylistDownloadGeneration(safeFlowId);
    return weeklyFlowWorker.seedFlowRunWithTracks(safeFlowId, latestFlow, normalizedTracks);
  });
  if (result?.skipped || result?.missing) return result;
  await wakeDownloadWorker();
  recordFlowTracksGenerated({
    flowId: safeFlowId,
    tracksQueued: result?.tracksQueued || normalizedTracks.length,
    reserveTracks: 0,
  });
  return result;
}

async function withCanonicalPlaylistMutation(payload, operation) {
  const playlistId = String(payload.playlistId || "").trim();
  const canonicalIds = (Array.isArray(payload.tracks) ? payload.tracks : []).map((track) => track?.canonicalJobId).filter(Boolean);
  while (true) {
    const jobs = [...downloadTracker.getByPlaylistId(playlistId), ...canonicalIds.map((id) => downloadTracker.getJob(id)).filter(Boolean)];
    const lockIds = getPlaylistRemovalLockIds(playlistId, jobs);
    const result = await withPlaylistMutationLock(lockIds, async () => {
      const currentJobs = [...downloadTracker.getByPlaylistId(playlistId), ...canonicalIds.map((id) => downloadTracker.getJob(id)).filter(Boolean)];
      if (!getPlaylistRemovalLockIds(playlistId, currentJobs).every((id) => lockIds.includes(id))) return { retryLocks: true };
      for (const track of payload.tracks || []) {
        if (!track?.canonicalJobId) continue;
        const job = downloadTracker.getJob(track.canonicalJobId);
        if (!job || isDownloadJobCancelled(job.id) || !tracksShareMembership(job, track)) {
          throw new Error("A referenced download is no longer available. Refresh the playlist and try again.");
        }
      }
      return { value: await operation(payload) };
    });
    if (!result.retryLocks) return result.value;
  }
}

async function createSharedPlaylist(payload = {}) {
  return withCanonicalPlaylistMutation({ ...payload, playlistId: String(payload.playlistId || "").trim() || randomUUID() }, createSharedPlaylistLocked);
}

export async function appendSharedPlaylistTracks(payload = {}) {
  return withCanonicalPlaylistMutation(payload, appendSharedPlaylistTracksLocked);
}

export async function updateSharedPlaylist(payload = {}) {
  return withCanonicalPlaylistMutation(payload, updateSharedPlaylistLocked);
}

async function createSharedPlaylistLocked({
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
} = {}) {
  const safePlaylistId = String(playlistId || "").trim() || randomUUID();
  const normalizedTracks = filterBlockedPlaylistTracks(
    ownerUserId,
    normalizeTrackList(tracks),
  );
  let playlist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!playlist) {
    playlist = flowPlaylistConfig.createSharedPlaylist({
      id: safePlaylistId,
      name,
      sourceName,
      sourceFlowId,
      discoverPresetId,
      type,
      tracks: normalizedTracks,
      ownerUserId,
      importSource,
      description,
    });
  }
  activatePlaylistDownloadGeneration(safePlaylistId);
  const queued = normalizedTracks.length
    ? await seedSharedPlaylistTracks(safePlaylistId, normalizedTracks)
    : { jobIds: [], reusedJobIds: [], createdJobIds: [], tracksQueued: 0, tracksReused: 0 };
  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
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

async function appendSharedPlaylistTracksLocked({ playlistId, tracks = [] } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const playlist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!playlist) return { missing: true };
  const allowedTracks = filterBlockedPlaylistTracks(
    playlist.ownerUserId,
    normalizeTrackList(tracks),
  );
  const tracksToAdd = filterMissingSharedTracks(playlist.tracks, allowedTracks);
  const updatedPlaylist =
    tracksToAdd.length > 0
      ? flowPlaylistConfig.appendSharedPlaylistTracks(safePlaylistId, tracksToAdd)
      : playlist;
  const queued =
    tracksToAdd.length > 0
      ? await seedSharedPlaylistTracks(safePlaylistId, tracksToAdd)
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

async function updateSharedPlaylistLocked({
  playlistId,
  name = null,
  tracks = [],
  hasNameUpdate = false,
  hasTracksUpdate = false,
  hasImportSourceUpdate = false,
  importSource = null,
  deleteUnsharedFiles = false,
  mergeImportSource = false,
} = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const currentPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!currentPlaylist) return { missing: true };
  const safeName = hasNameUpdate
    ? String(name || "").trim()
    : String(currentPlaylist.name || "").trim();
  let playlist = null;
  let tracksQueued = 0;
  let tracksReused = 0;
  if (!hasTracksUpdate) {
    await withPlaylistMutation(safePlaylistId, async () => {
      const lockedPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
      const lockedImportSource = lockedPlaylist?.importSource || currentPlaylist.importSource;
      const importSourceToStore =
        mergeImportSource && hasImportSourceUpdate
          ? { ...lockedImportSource, ...(importSource || {}) }
          : importSource;
      playlist = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
        ...(hasNameUpdate ? { name: safeName } : {}),
        ...(hasImportSourceUpdate ? { importSource: importSourceToStore } : {}),
      });
    });
  } else {
    const normalizedTracks = filterBlockedPlaylistTracks(
      currentPlaylist.ownerUserId,
      normalizeTrackList(tracks),
    );
    await withPlaylistMutation(getPlaylistRemovalLockIds(safePlaylistId, downloadTracker.getByPlaylistId(safePlaylistId)), async () => {
      const lockedPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
      const lockedImportSource = lockedPlaylist?.importSource || currentPlaylist.importSource;
      const shouldDeleteUnsharedFiles =
        deleteUnsharedFiles ||
        (mergeImportSource && lockedImportSource?.keepRemovedTracks === false);
      const existingJobs = downloadTracker.getByPlaylistType(safePlaylistId).filter((job) => !job.upgradeForJobId);
      const reusableJobsByIdentity = new Map();
      const reusableJobsByImportIdentity = new Map();
      for (const job of existingJobs) {
        const identity = buildSharedTrackIdentity(job);
        const current = reusableJobsByIdentity.get(identity) || [];
        current.push(job);
        reusableJobsByIdentity.set(identity, current);
        if (mergeImportSource) {
          const importIdentity = buildImportTrackIdentity(job);
          const importJobs = reusableJobsByImportIdentity.get(importIdentity) || [];
          importJobs.push(job);
          reusableJobsByImportIdentity.set(importIdentity, importJobs);
        }
      }
      for (const [identity, jobsForIdentity] of reusableJobsByIdentity.entries()) {
        reusableJobsByIdentity.set(identity, sortJobsForTrackReuse(jobsForIdentity));
      }
      for (const [identity, jobsForIdentity] of reusableJobsByImportIdentity.entries()) {
        reusableJobsByImportIdentity.set(identity, sortJobsForTrackReuse(jobsForIdentity));
      }

      const matchedJobIds = new Set();
      const tracksNeedingWork = [];
      const tracksWithoutExactJob = [];
      const takeReusableJob = (jobs) => {
        const index = jobs.findIndex((job) => !matchedJobIds.has(job.id));
        if (index < 0) return null;
        const [job] = jobs.splice(index, 1);
        return job;
      };
      for (const track of normalizedTracks) {
        const identity = buildSharedTrackIdentity(track);
        const reusableJobs = reusableJobsByIdentity.get(identity) || [];
        const matchedJob = takeReusableJob(reusableJobs);
        if (matchedJob) {
          matchedJobIds.add(matchedJob.id);
        } else {
          tracksWithoutExactJob.push(track);
        }
      }
      for (const track of tracksWithoutExactJob) {
        const reusableJobs = reusableJobsByImportIdentity.get(buildImportTrackIdentity(track)) || [];
        const matchedJob = takeReusableJob(reusableJobs);
        if (matchedJob) matchedJobIds.add(matchedJob.id);
        else tracksNeedingWork.push(track);
      }

      const removedJobs = existingJobs.filter((job) => !matchedJobIds.has(job.id));
      const latestImportSource = flowPlaylistConfig.getSharedPlaylist(safePlaylistId)?.importSource;
      const importSourceToStore =
        mergeImportSource && hasImportSourceUpdate
          ? { ...(latestImportSource || lockedImportSource), ...(importSource || {}) }
          : importSource;
      await removeSharedPlaylistSelectionsLocked({
        playlistId: safePlaylistId,
        selections: removedJobs.map((job) => captureSharedPlaylistSelection(lockedPlaylist, job.id)).filter(Boolean),
        deleteFiles: shouldDeleteUnsharedFiles,
        requireAll: true,
        onCommitted: () => {
          playlist = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
            ...(hasNameUpdate ? { name: safeName } : {}),
            tracks: normalizedTracks,
            ...(hasImportSourceUpdate ? { importSource: importSourceToStore } : {}),
          });
        },
      });
      const queued = await queueTracksForPlaylist(tracksNeedingWork, safePlaylistId);
      tracksQueued = queued.jobIds.length;
      tracksReused = matchedJobIds.size + queued.reusedJobIds.length;
    }, { clearPending: false });
    weeklyFlowWorker.pruneOrphanedJobState();
  }

  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
  await playlistManager.scheduleScanLibrary(true);
  await finalizeRetainedPlaylistRelocations(safePlaylistId, { weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot });
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

async function deleteSharedPlaylistTrack({ playlistId, jobId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const playlist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!playlist) return { missingPlaylist: true };
  await cleanupRemovedPlaylistFiles(safePlaylistId);
  const synchronizationKey = `playlistTrackRemovalSync:${safePlaylistId}:${safeJobId}`;
  const job = downloadTracker.getJob(safeJobId);
  const selection = job && captureSharedPlaylistSelection(playlist, safeJobId);
  if (!selection) {
    playlistManager.updateConfig(false);
    const pending = db.prepare("SELECT value FROM settings WHERE key = ?").get(synchronizationKey);
    const pendingIds = pending ? JSON.parse(pending.value) : [safePlaylistId];
    for (const id of pendingIds) await playlistManager.refreshPlaylist(id);
    await playlistManager.scheduleScanLibrary(true);
    await finalizeRetainedPlaylistRelocations(safePlaylistId, { weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot });
    db.prepare("DELETE FROM settings WHERE key = ?").run(synchronizationKey);
    return { missingJob: true };
  }
  let affectedPlaylistIds = [];
  await withSharedPlaylistRemovalMutation(
    { playlistId: safePlaylistId, jobIds: [job.id] },
    async () => {
      const result = await removeSharedPlaylistSelectionsLocked({
        playlistId: safePlaylistId, selections: [selection], deleteFiles: true,
        onCommitted: (_outcomes, ids) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(synchronizationKey, JSON.stringify(ids)),
      });
      affectedPlaylistIds = result.affectedPlaylistIds;
      const failed = result.outcomes.find((outcome) => outcome.status === "failed");
      if (failed) throw new Error(failed.message);
    },
  );
  weeklyFlowWorker.pruneOrphanedJobState();
  const updatedPlaylist = (await syncSharedPlaylistConfigFromJobs(safePlaylistId)) || playlist;
  playlistManager.updateConfig(false);
  for (const id of affectedPlaylistIds) await playlistManager.refreshPlaylist(id);
  await playlistManager.scheduleScanLibrary(true);
  await finalizeRetainedPlaylistRelocations(safePlaylistId, { weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot });
  db.prepare("DELETE FROM settings WHERE key = ?").run(synchronizationKey);
  return {
    success: true,
    playlist: updatedPlaylist,
    removedJobId: safeJobId,
  };
}

async function researchPlaylistTrack({ playlistId, jobId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const isLibraryJob = safePlaylistId === "library";
  const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  const flow = flowPlaylistConfig.getFlow(safePlaylistId);
  if (!isLibraryJob && !sharedPlaylist && !flow) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  if (!job || job.playlistType !== safePlaylistId) {
    return { missingJob: true };
  }
  if (job.status === "pending" || job.status === "downloading") {
    return { alreadyProcessing: true };
  }
  const previousFinalPath = job.finalPath;
  if (
    job.status === "done" &&
    job.managedBy === "aurral" &&
    isAurralOwnedPath(job.finalPath)
  ) {
    const replacementJobId = downloadTracker.addReplacementSearchJob(job);
    if (!replacementJobId) {
      return { alreadyProcessing: true };
    }
    if (!downloadTracker.enqueueDownloadPipeline(replacementJobId)) {
      const replacementJob = downloadTracker.getJob(replacementJobId);
      const { finalizeQualityUpgradeFailure } = await import("../qualityProfileService.js");
      await finalizeQualityUpgradeFailure(
        replacementJob,
        "Could not queue a replacement search",
      );
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
  if (isLibraryJob) {
    if (!downloadTracker.setPending(safeJobId, null)) {
      throw new Error("Failed to requeue track");
    }
    await wakeDownloadWorker();
    return { success: true, reused: false, jobId: safeJobId, playlistId: safePlaylistId };
  }
  let reused = false;
  await withPlaylistMutation(
    safePlaylistId,
    async () => {
      const { existingFileMode } = weeklyFlowWorker.getWorkerSettings();
      const mode = normalizeExistingFileMode(existingFileMode);
      if (mode !== "download" && (job.status === "done" || job.status === "failed")) {
        const reuse = await reuseTrackForPlaylist(job, safePlaylistId, {
          existingFileMode: mode,
          weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
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
      const reset = downloadTracker.setPending(safeJobId, null);
      if (!reset) {
        throw new Error("Failed to requeue track");
      }
    },
    { clearPending: false },
  );
  playlistManager.updateConfig(false);
  await playlistManager.refreshPlaylist(safePlaylistId);
  playlistManager.scheduleScanLibrary();
  if (!reused) {
    await restartWorkerIfPending();
    if (weeklyFlowWorker.running) {
      weeklyFlowWorker.wake();
    }
  }
  return {
    success: true,
    reused,
    jobId: safeJobId,
    playlistId: safePlaylistId,
  };
}

async function researchLibraryTrack({ trackId, albumId } = {}) {
  const sourceJob = resolveAurralOwnedTrackJob({ trackId, albumId });
  if (!sourceJob) return { missingAurralOwnedTrack: true };
  if (downloadTracker.findActiveUpgradeJob(sourceJob)) {
    return { alreadyProcessing: true };
  }

  const replacementJobId = downloadTracker.addReplacementSearchJob(sourceJob);
  if (!replacementJobId) return { alreadyProcessing: true };
  if (!downloadTracker.enqueueDownloadPipeline(replacementJobId)) {
    const replacementJob = downloadTracker.getJob(replacementJobId);
    const { finalizeQualityUpgradeFailure } = await import("../qualityProfileService.js");
    await finalizeQualityUpgradeFailure(
      replacementJob,
      "Could not queue a replacement search",
    );
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

async function deleteSharedPlaylist({ playlistId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const exists = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!exists) {
    playlistManager.updateConfig(false);
    await playlistManager.ensureSmartPlaylists();
    await finalizeRetainedPlaylistRelocations(safePlaylistId, { weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot });
    return false;
  }
  const jobs = downloadTracker.getByPlaylistId(safePlaylistId);
  const selectionIds = [...new Set([...jobs.filter((job) => !job.upgradeForJobId).map((job) => job.id),
    ...exists.tracks.map((track) => track.canonicalJobId).filter(Boolean)])];
  const selections = selectionIds.map((id) => captureSharedPlaylistSelection(exists, id)).filter(Boolean);
  let deleted = false;
  try {
    await withSharedPlaylistRemovalMutation({ playlistId: safePlaylistId, jobIds: jobs.map((job) => job.id) }, async () => {
      const result = await removeSharedPlaylistSelectionsLocked({
        playlistId: safePlaylistId, selections, deleteFiles: true, requireAll: true,
      });
      const failed = result.outcomes.find((outcome) => outcome.status === "failed");
      if (failed) throw new Error(failed.message);
      await cancelPlaylistDownloadWork(safePlaylistId, downloadTracker.getByPlaylistId(safePlaylistId), { lock: false });
      weeklyFlowWorker.setRetryCyclePaused(safePlaylistId, false);
      playlistManager.updateConfig(false);
      await playlistManager.deletePlaybackPlaylist(exists);
      const playlistJobs = downloadTracker.getByPlaylistId(safePlaylistId);
      const removedJobIds = playlistJobs.map((job) => job.id);
      for (const job of playlistJobs) {
        if (job.status !== "done" || job.managedBy !== "aurral" || job.externalPath || !job.finalPath || job.upgradeForJobId) {
          continue;
        }
        await removePlaylistFileIfUnshared(job.finalPath, safePlaylistId, {
          weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
          excludeJobIds: removedJobIds,
          deleteIfUnshared: true,
        });
      }
      await playlistManager.weeklyReset([safePlaylistId], { protectPlayback: true });
      downloadTracker.clearByPlaylistId(safePlaylistId);
      await playlistManager.cleanupEntityPlexPlaylists(safePlaylistId);
      deleted = flowPlaylistConfig.deleteSharedPlaylist(safePlaylistId);
      await playlistManager.ensureSmartPlaylists();
    });
  } catch (error) {
    restorePlaylistDownloadWork(safePlaylistId, downloadTracker.getByPlaylistId(safePlaylistId).map((job) => job.id));
    throw error;
  }
  await restartWorkerIfPending();
  await finalizeRetainedPlaylistRelocations(safePlaylistId, { weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot });
  return deleted;
}

export async function processWeeklyFlowOperation(payload = {}) {
  const kind = String(payload?.kind || payload?.type || "").trim();
  return withHonkerLock(
    "weekly-flow-operation",
    async () => {
      switch (kind) {
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
          return createSharedPlaylist(payload);
        case "shared-playlist-append-tracks":
          return appendSharedPlaylistTracks(payload);
        case "shared-playlist-update":
          return updateSharedPlaylist(payload);
        case "shared-playlist-bulk": {
          const { processSharedPlaylistBulkOperation } = await import("./weeklyFlowBulkOperations.js");
          return processSharedPlaylistBulkOperation(payload.operationId);
        }
        case "shared-playlist-delete-track":
          return deleteSharedPlaylistTrack(payload);
        case "shared-playlist-research-track":
          return researchPlaylistTrack(payload);
        case "library-track-research":
          return researchLibraryTrack(payload);
        case "shared-playlist-delete":
          return deleteSharedPlaylist(payload);
        default:
          throw new Error(`Unknown weekly flow operation: ${kind || "unknown"}`);
      }
    },
    {
      ttlSeconds: 180,
      waitTimeoutMs: 30 * 60 * 1000,
      retryDelayMs: 250,
    },
  );
}
