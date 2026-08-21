import { randomUUID } from "crypto";
import { dbOps } from "../../db/helpers/index.js";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
} from "../aurralHistoryService.js";
import {
  buildSharedTrackIdentity,
  dedupeSharedTracks,
  filterMissingSharedTracks,
  flowPlaylistConfig,
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
} from "./weeklyFlowMutationGuards.js";
import { withHonkerLock } from "../honkerDb.js";
import { getUnavailableFlowSourceError } from "./weeklyFlowValidation.js";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.js";
import { filterBlockedArtistsForUser } from "../discovery/feedback.js";

const OPERATION_TOKENS_KEY = "weeklyFlowOperationTokens";

export function createWeeklyFlowOperationToken() {
  return `${Date.now()}-${randomUUID()}`;
}

export function markLatestWeeklyFlowOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return;
  const current = dbOps.getJSONSetting(OPERATION_TOKENS_KEY) || {};
  dbOps.setJSONSetting(OPERATION_TOKENS_KEY, {
    ...current,
    [safeScope]: safeToken,
  });
}

function isLatestWeeklyFlowOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return true;
  const current = dbOps.getJSONSetting(OPERATION_TOKENS_KEY) || {};
  return current[safeScope] === safeToken;
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

const removePlaylistLocalTrackFile = async (job, playlistId) => {
  if (!job || typeof job.finalPath !== "string") return;
  await removePlaylistFileIfUnshared(job.finalPath, playlistId, {
    weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
    excludeJobIds: job.id ? [job.id] : [],
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
  if (!isAnyDownloadSourceConfigured()) {
    const error = new Error(getDownloadSourceNotConfiguredMessage());
    error.code = "NO_DOWNLOAD_SOURCE";
    throw error;
  }
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (requireEnabled && flow.enabled !== true) return { skipped: true };
  const unavailableError = getUnavailableFlowSourceError(flow.mix);
  if (unavailableError) throw new Error(unavailableError);

  const result = await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return { cancelled: true };
    }
    const latestFlow = flowPlaylistConfig.getFlow(safeFlowId);
    if (!latestFlow) return { missing: true };
    if (requireEnabled && latestFlow.enabled !== true) return { skipped: true };

    recordFlowGenerationStarted({ flowId: safeFlowId });
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset([safeFlowId]);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    downloadTracker.clearByPlaylistType(safeFlowId);

    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return { cancelled: true };
    }
    const effectiveSize =
      Number.isFinite(Number(size)) && Number(size) > 0
        ? Number(size)
        : latestFlow.size || DEFAULT_SIZE;
    const seeded = await weeklyFlowWorker.seedFlowRun(safeFlowId, latestFlow, {
      size: effectiveSize,
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
  });

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

async function runFlowCleanup({ flowId, tokenScope = null, token = null } = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return;
    }
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset([safeFlowId]);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    downloadTracker.clearByPlaylistType(safeFlowId);
  });
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
  let didDelete = false;
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestWeeklyFlowOperationToken(tokenScope, token)) {
      return;
    }
    weeklyFlowWorker.setRetryCyclePaused(safeFlowId, false);
    weeklyFlowWorker.clearPlaylistRunState(safeFlowId);
    playlistManager.updateConfig(false);
    await playlistManager.deletePlaybackPlaylist(flow);
    await playlistManager.weeklyReset([safeFlowId]);
    downloadTracker.clearByPlaylistType(safeFlowId);
    await playlistManager.cleanupEntityPlexPlaylists(safeFlowId);
    didDelete = flowPlaylistConfig.deleteFlow(safeFlowId);
    await playlistManager.ensureSmartPlaylists();
  });
  await restartWorkerIfPending();
  return didDelete;
}

async function resetPlaylists({ playlistTypes = [] } = {}) {
  const types = (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  await withPlaylistMutation(types, async () => {
    playlistManager.updateConfig(false);
    await playlistManager.weeklyReset(types);
  });
  await restartWorkerIfPending();
  return { success: true, playlistTypes: types };
}

async function adoptFlowSeed({ flowId, tracks = [] } = {}) {
  const safeFlowId = String(flowId || "").trim();
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  const normalizedTracks = normalizeTrackList(tracks);
  const result = await withPlaylistMutation(safeFlowId, async () =>
    weeklyFlowWorker.seedFlowRunWithTracks(safeFlowId, flow, normalizedTracks),
  );
  await wakeDownloadWorker();
  recordFlowTracksGenerated({
    flowId: safeFlowId,
    tracksQueued: result?.tracksQueued || normalizedTracks.length,
    reserveTracks: 0,
  });
  return result;
}

async function createSharedPlaylist({
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

export async function appendSharedPlaylistTracks({ playlistId, tracks = [] } = {}) {
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

export async function updateSharedPlaylist({
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
    await withPlaylistMutation(safePlaylistId, async () => {
      const lockedPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
      const lockedImportSource = lockedPlaylist?.importSource || currentPlaylist.importSource;
      const shouldDeleteUnsharedFiles =
        deleteUnsharedFiles ||
        (mergeImportSource && lockedImportSource?.keepRemovedTracks === false);
      const shouldDeleteCurrentFiles = mergeImportSource
        ? () =>
            flowPlaylistConfig.getSharedPlaylist(safePlaylistId)?.importSource
              ?.keepRemovedTracks === false
        : null;
      const existingJobs = downloadTracker.getByPlaylistType(safePlaylistId);
      const reusableJobsByIdentity = new Map();
      for (const job of existingJobs) {
        const identity = buildSharedTrackIdentity(job);
        const current = reusableJobsByIdentity.get(identity) || [];
        current.push(job);
        reusableJobsByIdentity.set(identity, current);
      }
      for (const [identity, jobsForIdentity] of reusableJobsByIdentity.entries()) {
        reusableJobsByIdentity.set(identity, sortJobsForTrackReuse(jobsForIdentity));
      }

      const matchedJobIds = new Set();
      const tracksNeedingWork = [];
      for (const track of normalizedTracks) {
        const identity = buildSharedTrackIdentity(track);
        const reusableJobs = reusableJobsByIdentity.get(identity) || [];
        const matchedJob = reusableJobs.shift();
        if (matchedJob) {
          matchedJobIds.add(matchedJob.id);
        } else {
          tracksNeedingWork.push(track);
        }
      }

      for (const job of existingJobs) {
        if (matchedJobIds.has(job.id)) continue;
        if (job.status === "done" && typeof job.finalPath === "string") {
          await removePlaylistFileIfUnshared(job.finalPath, safePlaylistId, {
            weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
            excludeJobIds: [job.id, ...matchedJobIds],
            deleteIfUnshared: shouldDeleteUnsharedFiles,
            shouldDelete: shouldDeleteCurrentFiles,
          });
        }
        downloadTracker.removeJob(job.id);
      }

      const latestImportSource = flowPlaylistConfig.getSharedPlaylist(safePlaylistId)?.importSource;
      const importSourceToStore =
        mergeImportSource && hasImportSourceUpdate
          ? { ...(latestImportSource || lockedImportSource), ...(importSource || {}) }
          : importSource;
      playlist = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
        ...(hasNameUpdate ? { name: safeName } : {}),
        tracks: normalizedTracks,
        ...(hasImportSourceUpdate ? { importSource: importSourceToStore } : {}),
      });
      const queued = await queueTracksForPlaylist(tracksNeedingWork, safePlaylistId);
      tracksQueued = queued.jobIds.length;
    });
    weeklyFlowWorker.pruneOrphanedJobState();
  }

  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
  await playlistManager.scheduleScanLibrary(true);
  if (tracksQueued > 0) {
    await wakeDownloadWorker();
    recordPlaylistHistory(safePlaylistId, { tracksQueued });
  }
  schedulePlaylistMbidEnrichment(safePlaylistId, {
    reason: hasTracksUpdate ? "shared-playlist-track-update" : "shared-playlist-update",
    priority: 5,
  });
  return { success: true, playlist, tracksQueued };
}

async function deleteSharedPlaylistTrack({ playlistId, jobId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const playlist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!playlist) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  const isCanonicalReference =
    job?.playlistType !== safePlaylistId &&
    playlist.tracks?.some((track) => String(track?.canonicalJobId || "") === safeJobId);
  if (!job || (job.playlistType !== safePlaylistId && !isCanonicalReference)) {
    return { missingJob: true };
  }
  await withPlaylistMutation(
    safePlaylistId,
    async () => {
      if (isCanonicalReference) {
        const updated = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
          tracks: playlist.tracks.filter(
            (track) => String(track?.canonicalJobId || "") !== safeJobId,
          ),
        });
        if (!updated) throw new Error("Failed to update shared playlist");
        return;
      }
      if (job.status === "done" && typeof job.finalPath === "string") {
        await removePlaylistLocalTrackFile(job, safePlaylistId);
      }
      downloadTracker.removeJob(safeJobId);
    },
    { clearPending: false },
  );
  weeklyFlowWorker.pruneOrphanedJobState();
  const updatedPlaylist = (await syncSharedPlaylistConfigFromJobs(safePlaylistId)) || playlist;
  playlistManager.updateConfig(false);
  await playlistManager.refreshPlaylist(safePlaylistId);
  await playlistManager.scheduleScanLibrary(true);
  return {
    success: true,
    playlist: updatedPlaylist,
    removedJobId: safeJobId,
  };
}

async function researchPlaylistTrack({ playlistId, jobId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  const flow = flowPlaylistConfig.getFlow(safePlaylistId);
  if (!sharedPlaylist && !flow) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  if (!job || job.playlistType !== safePlaylistId) {
    return { missingJob: true };
  }
  if (job.status === "pending" || job.status === "downloading") {
    return { alreadyProcessing: true };
  }
  const previousFinalPath = job.finalPath;
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

async function deleteSharedPlaylist({ playlistId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const exists = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!exists) return false;
  let deleted = false;
  await withPlaylistMutation(safePlaylistId, async () => {
    weeklyFlowWorker.setRetryCyclePaused(safePlaylistId, false);
    playlistManager.updateConfig(false);
    await playlistManager.deletePlaybackPlaylist(exists);
    await playlistManager.weeklyReset([safePlaylistId]);
    downloadTracker.clearByPlaylistType(safePlaylistId);
    await playlistManager.cleanupEntityPlexPlaylists(safePlaylistId);
    deleted = flowPlaylistConfig.deleteSharedPlaylist(safePlaylistId);
    await playlistManager.ensureSmartPlaylists();
  });
  await restartWorkerIfPending();
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
        case "shared-playlist-delete-track":
          return deleteSharedPlaylistTrack(payload);
        case "shared-playlist-research-track":
          return researchPlaylistTrack(payload);
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
