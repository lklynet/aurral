import { randomUUID } from "crypto";
import { dbOps, userOps } from "../../db/helpers/index.js";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
  recordTrackJobQueued,
} from "../aurralHistoryService.js";
import {
  buildCoreTrackIdentity,
  buildImportTrackIdentity,
  buildPlaylistTrackIdentity,
  filterMissingPlaylistTracks,
  flowPlaylistConfig,
  isRetiredFlow,
  normalizePlaylistTrack,
  DEFAULT_SIZE,
} from "./flowPlaylistConfig.js";
import {
  normalizeExistingFileMode,
  removePlaylistFileIfUnshared,
  reuseTrackForPlaylist,
} from "../downloadJobs/fileReuse.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { resolveAurralOwnedTrackJob } from "../libraryTrackResearchService.js";
import { isAurralOwnedPath } from "../qualityProfileService.js";
import { playlistManager } from "./playlistManager.js";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";
import {
  restartWorkerIfPending,
  wakeDownloadWorker,
  withPlaylistMutation,
  withPlaylistMutationLock,
} from "../downloadJobs/mutationGuards.js";
import { withHonkerLock } from "../honkerDb.js";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.js";
import { filterBlockedArtistsForUser } from "../discovery/feedback.js";
import { activateOwnerDownloadGeneration } from "../downloadJobs/downloadCancellation.js";
import {
  cancelOwnerDownloadWork,
} from "../downloadJobs/downloadCancellationService.js";

import {
  LIBRARY_OWNER,
  cleanupRemovedLibraryFiles,
  commitStaticPlaylistTracks,
  discardCreatedJobs,
  linkStaticPlaylistTracks,
  staticPlaylistReferencesJob,
  withStaticPlaylistRelease,
} from "./staticPlaylistJobs.js";

const OPERATION_TOKENS_KEY = "playlistOperationTokens";
const operationTokenKey = (scope) =>
  `${OPERATION_TOKENS_KEY}:${encodeURIComponent(scope)}`;

export function createPlaylistOperationToken() {
  return `${Date.now()}-${randomUUID()}`;
}

export function markLatestPlaylistOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return;
  dbOps.setJSONSetting(operationTokenKey(safeScope), safeToken);
}

export function getLatestPlaylistOperationToken(scope) {
  const safeScope = String(scope || "").trim();
  if (!safeScope) return null;
  return dbOps.getJSONSetting(operationTokenKey(safeScope)) ?? null;
}

export function restorePlaylistOperationToken({ scope, token, previousToken } = {}) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken || getLatestPlaylistOperationToken(safeScope) !== safeToken) {
    return false;
  }
  dbOps.setJSONSetting(operationTokenKey(safeScope), previousToken ?? null);
  return true;
}

function isLatestPlaylistOperationToken(scope, token) {
  const safeScope = String(scope || "").trim();
  const safeToken = String(token || "").trim();
  if (!safeScope || !safeToken) return true;
  return getLatestPlaylistOperationToken(safeScope) === safeToken;
}

function normalizeTrackList(value) {
  return (Array.isArray(value) ? value : [])
    .map((track) => normalizePlaylistTrack(track))
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
    downloadRoot: downloadWorker.downloadRoot,
    excludeJobIds: job.id ? [job.id] : [],
    protectPlayback,
  });
};

const recordPlaylistHistory = (playlistId, { tracksQueued = 0, tracksReused = 0 } = {}) => {
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
} = {}) {
  const safeFlowId = String(flowId || "").trim();
  if (!safeFlowId) return { missing: true };
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
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
  const effectiveSize =
    Number.isFinite(Number(size)) && Number(size) > 0
      ? Number(size)
      : flow.size || DEFAULT_SIZE;
  const flowSnapshot = JSON.stringify(flow);
  const preparedPlan = await downloadWorker.prepareFlowRunPlan(flow, {
    size: effectiveSize,
  });

  const result = await withPlaylistMutation(safeFlowId, async () => {
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

    activateOwnerDownloadGeneration(safeFlowId);
    recordFlowGenerationStarted({ flowId: safeFlowId });
    playlistManager.updateConfig(false);
    await playlistManager.clearFlowFiles([safeFlowId]);
    downloadTracker.clearAllForOwner(safeFlowId);

    if (!isLatestPlaylistOperationToken(tokenScope, token)) {
      return { cancelled: true };
    }
    const seeded = await downloadWorker.seedFlowRun(safeFlowId, latestFlow, {
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
      const existingFlowJobs = downloadTracker.getAllForOwner(safeFlowId);
      await cancelOwnerDownloadWork(safeFlowId, existingFlowJobs, { lock: false });
      if (!isLatestPlaylistOperationToken(tokenScope, token)) {
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
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelOwnerDownloadWork(safeFlowId, downloadTracker.getAllForOwner(safeFlowId));
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestPlaylistOperationToken(tokenScope, token)) {
      return;
    }
    playlistManager.updateConfig(false);
    await playlistManager.clearFlowFiles([safeFlowId]);
    downloadTracker.clearAllForOwner(safeFlowId);
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
  if (!isLatestPlaylistOperationToken(tokenScope, token)) {
    return { cancelled: true };
  }
  await cancelOwnerDownloadWork(safeFlowId, downloadTracker.getAllForOwner(safeFlowId));
  let didDelete = false;
  await withPlaylistMutation(safeFlowId, async () => {
    if (!isLatestPlaylistOperationToken(tokenScope, token)) {
      return;
    }
    downloadWorker.setRetryCyclePaused(safeFlowId, false);
    playlistManager.updateConfig(false);
    await playlistManager.deletePlaybackPlaylist(flow);
    await playlistManager.clearFlowFiles([safeFlowId], { protectPlayback: false });
    downloadTracker.clearAllForOwner(safeFlowId);
    await playlistManager.cleanupEntityPlexPlaylists(safeFlowId);
    didDelete = flowPlaylistConfig.deleteFlow(safeFlowId);
    await playlistManager.ensureSmartPlaylists();
  });
  if (didDelete) playlistManager.scheduleScanLibrary();
  await restartWorkerIfPending();
  return didDelete;
}

async function resetFlows({ flowIds = [] } = {}) {
  const ids = (Array.isArray(flowIds) ? flowIds : [flowIds])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  await Promise.all(
    ids.map((flowId) => cancelOwnerDownloadWork(flowId, downloadTracker.getAllForOwner(flowId))),
  );
  await withPlaylistMutation(ids, async () => {
    playlistManager.updateConfig(false);
    await playlistManager.clearFlowFiles(ids, { protectPlayback: false });
  });
  rescanLibraryForFlows(ids);
  await restartWorkerIfPending();
  return { success: true, flowIds: ids };
}

async function adoptFlowSeed({ flowId, tracks = [] } = {}) {
  const safeFlowId = String(flowId || "").trim();
  const flow = flowPlaylistConfig.getFlow(safeFlowId);
  if (!flow) return { missing: true };
  if (!isOwnerActive(flow.ownerUserId)) return { skipped: true, inactiveOwner: true };
  const normalizedTracks = normalizeTrackList(tracks);
  await cancelOwnerDownloadWork(safeFlowId, downloadTracker.getAllForOwner(safeFlowId));
  const result = await withPlaylistMutation(safeFlowId, async () => {
    const latestFlow = flowPlaylistConfig.getFlow(safeFlowId);
    if (!latestFlow) return { missing: true };
    if (!isOwnerActive(latestFlow.ownerUserId)) {
      return { skipped: true, inactiveOwner: true };
    }
    activateOwnerDownloadGeneration(safeFlowId);
    return downloadWorker.seedFlowRunWithTracks(safeFlowId, latestFlow, normalizedTracks);
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

async function finishStaticPlaylistChange(playlistId, { tracksQueued = 0, tracksReused = 0, enrichment = null } = {}) {
  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
  if (tracksReused > 0) playlistManager.scheduleScanLibrary();
  if (tracksQueued > 0) await wakeDownloadWorker();
  recordPlaylistHistory(playlistId, { tracksQueued, tracksReused });
  if (enrichment) schedulePlaylistMbidEnrichment(playlistId, { reason: enrichment, priority: 5 });
}

async function createStaticPlaylist(payload = {}) {
  const playlistId = String(payload.playlistId || "").trim() || randomUUID();
  return withPlaylistMutationLock(playlistId, () => createStaticPlaylistLocked({ ...payload, playlistId }));
}

export async function appendStaticPlaylistTracks(payload = {}) {
  return withPlaylistMutationLock(String(payload.playlistId || "").trim(), () =>
    appendStaticPlaylistTracksLocked(payload));
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
} = {}) {
  const normalizedTracks = filterBlockedPlaylistTracks(ownerUserId, normalizeTrackList(tracks));
  const existing = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (existing) {
    return appendStaticPlaylistTracksLocked({ playlistId, tracks: normalizedTracks });
  }
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
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
  const linked = await linkStaticPlaylistTracks(normalizedTracks);
  let playlist;
  try {
    playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, { tracks: linked.tracks });
  } catch (error) {
    discardCreatedJobs(linked.createdJobIds);
    flowPlaylistConfig.deleteStaticPlaylist(playlistId);
    throw error;
  }
  await finishStaticPlaylistChange(playlistId, {
    tracksQueued: linked.tracksQueued,
    tracksReused: linked.tracksReused,
    enrichment: normalizedTracks.length ? "static-playlist-create" : null,
  });
  return {
    success: true,
    playlist,
    tracksQueued: linked.tracksQueued,
    tracksReused: linked.tracksReused,
    jobIds: linked.createdJobIds,
  };
}

async function appendStaticPlaylistTracksLocked({ playlistId, tracks = [] } = {}) {
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
  const linked = await linkStaticPlaylistTracks(tracksToAdd);
  let updatedPlaylist;
  try {
    updatedPlaylist = flowPlaylistConfig.appendStaticPlaylistTracks(safePlaylistId, linked.tracks);
  } catch (error) {
    discardCreatedJobs(linked.createdJobIds);
    throw error;
  }
  await finishStaticPlaylistChange(safePlaylistId, {
    tracksQueued: linked.tracksQueued,
    tracksReused: linked.tracksReused,
    enrichment: "static-playlist-append",
  });
  return {
    success: true,
    playlist: updatedPlaylist,
    tracksQueued: linked.tracksQueued,
    tracksReused: linked.tracksReused,
    jobIds: linked.createdJobIds,
  };
}

function keepExistingMemberships(currentTracks, nextTracks, matchKeys) {
  const available = [...currentTracks];
  let matched = 0;
  const result = nextTracks.map((track) => ({ ...track }));
  for (const buildKey of matchKeys) {
    for (const track of result) {
      if (track.jobId) continue;
      const key = buildKey(track);
      if (!key) continue;
      const index = available.findIndex((entry) => entry.jobId && buildKey(entry) === key);
      if (index < 0) continue;
      const [entry] = available.splice(index, 1);
      track.jobId = entry.jobId;
      track.membershipId = entry.membershipId;
      matched += 1;
    }
  }
  return { tracks: result, matched };
}

export async function updateStaticPlaylist({
  playlistId,
  name = null,
  tracks = [],
  hasNameUpdate = false,
  hasTracksUpdate = false,
  hasImportSourceUpdate = false,
  importSource = null,
  mergeImportSource = false,
} = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const currentPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!currentPlaylist) return { missing: true };
  const safeName = hasNameUpdate
    ? String(name || "").trim()
    : String(currentPlaylist.name || "").trim();
  const importSourceFor = (latest) =>
    mergeImportSource && hasImportSourceUpdate
      ? { ...(latest?.importSource || currentPlaylist.importSource), ...(importSource || {}) }
      : importSource;
  const updates = (latest) => ({
    ...(hasNameUpdate ? { name: safeName } : {}),
    ...(hasImportSourceUpdate ? { importSource: importSourceFor(latest) } : {}),
  });
  let playlist = null;
  let tracksQueued = 0;
  let tracksReused = 0;
  if (!hasTracksUpdate) {
    await withPlaylistMutationLock(safePlaylistId, async () => {
      playlist = flowPlaylistConfig.updateStaticPlaylist(
        safePlaylistId,
        updates(flowPlaylistConfig.getStaticPlaylist(safePlaylistId)),
      );
    });
  } else {
    const normalizedTracks = filterBlockedPlaylistTracks(
      currentPlaylist.ownerUserId,
      normalizeTrackList(tracks).map(({ jobId: _jobId, ...track }) => track),
    );
    await withStaticPlaylistRelease([safePlaylistId], async () => {
      const lockedPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
      if (!lockedPlaylist) return;
      const deleteFiles = mergeImportSource && lockedPlaylist.importSource?.keepRemovedTracks === false;
      const kept = keepExistingMemberships(
        lockedPlaylist.tracks,
        normalizedTracks,
        mergeImportSource
          ? [buildPlaylistTrackIdentity, buildImportTrackIdentity, buildCoreTrackIdentity]
          : [buildPlaylistTrackIdentity],
      );
      const linked = await linkStaticPlaylistTracks(kept.tracks);
      try {
        ({ playlist } = await commitStaticPlaylistTracks({
          playlistId: safePlaylistId,
          tracks: linked.tracks,
          updates: updates(lockedPlaylist),
          deleteFiles,
          requireAll: true,
        }));
      } catch (error) {
        discardCreatedJobs(linked.createdJobIds);
        throw error;
      }
      tracksQueued = linked.tracksQueued;
      tracksReused = kept.matched + linked.tracksReused;
    });
    downloadWorker.pruneOrphanedJobState();
  }

  playlistManager.updateConfig(false);
  await playlistManager.ensureSmartPlaylists();
  await playlistManager.scheduleScanLibrary(true);
  if (tracksQueued > 0) {
    await wakeDownloadWorker();
    recordPlaylistHistory(safePlaylistId, { tracksQueued });
  }
  schedulePlaylistMbidEnrichment(safePlaylistId, {
    reason: hasTracksUpdate ? "static-playlist-track-update" : "static-playlist-update",
    priority: 5,
  });
  return { success: true, playlist, tracksQueued, tracksReused };
}

async function deleteStaticPlaylistTrack({ playlistId, jobId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  const safeJobId = String(jobId || "").trim();
  const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!playlist) return { missingPlaylist: true };
  await cleanupRemovedLibraryFiles();
  if (!staticPlaylistReferencesJob(playlist, safeJobId)) {
    playlistManager.updateConfig(false);
    await playlistManager.refreshPlaylist(safePlaylistId);
    return { missingJob: true };
  }
  let updatedPlaylist = playlist;
  await withStaticPlaylistRelease([safePlaylistId], async () => {
    const lockedPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
    if (!staticPlaylistReferencesJob(lockedPlaylist, safeJobId)) return;
    ({ playlist: updatedPlaylist } = await commitStaticPlaylistTracks({
      playlistId: safePlaylistId,
      tracks: lockedPlaylist.tracks.filter((track) => track.jobId !== safeJobId),
      deleteFiles: true,
      requireAll: true,
    }));
  });
  downloadWorker.pruneOrphanedJobState();
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
  const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  const flow = flowPlaylistConfig.getFlow(safePlaylistId);
  if (safePlaylistId !== LIBRARY_OWNER && !staticPlaylist && !flow) return { missingPlaylist: true };
  const job = downloadTracker.getJob(safeJobId);
  const belongs = staticPlaylist
    ? staticPlaylistReferencesJob(staticPlaylist, safeJobId)
    : job?.ownerId === safePlaylistId && !job.upgradeForJobId;
  if (!job || !belongs) {
    return { missingJob: true };
  }
  if (job.status === "pending" || job.status === "downloading") {
    return { alreadyProcessing: true };
  }
  if (safePlaylistId === LIBRARY_OWNER) downloadTracker.setQueuedForPlaylist(job.id, false);
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
  if (!flow) {
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

async function researchLibraryTrack({ trackId, albumId } = {}) {
  const sourceJob = resolveAurralOwnedTrackJob({ trackId, albumId });
  if (!sourceJob) return { missingAurralOwnedTrack: true };
  if (downloadTracker.findActiveUpgradeJob(sourceJob)) {
    return { alreadyProcessing: true };
  }
  downloadTracker.setQueuedForPlaylist(sourceJob.id, false);

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

async function deleteStaticPlaylist({ playlistId } = {}) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!flowPlaylistConfig.getStaticPlaylist(safePlaylistId)) {
    playlistManager.updateConfig(false);
    await playlistManager.ensureSmartPlaylists();
    await cleanupRemovedLibraryFiles();
    return false;
  }
  let deleted = false;
  await withStaticPlaylistRelease([safePlaylistId], async () => {
    const playlist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
    if (!playlist) return;
    await commitStaticPlaylistTracks({
      playlistId: safePlaylistId,
      tracks: [],
      deleteFiles: true,
      requireAll: true,
    });
    playlistManager.updateConfig(false);
    await playlistManager.deletePlaybackPlaylist(playlist);
    await playlistManager.cleanupEntityPlexPlaylists(safePlaylistId);
    deleted = flowPlaylistConfig.deleteStaticPlaylist(safePlaylistId);
    await playlistManager.ensureSmartPlaylists();
  });
  downloadWorker.pruneOrphanedJobState();
  await restartWorkerIfPending();
  return deleted;
}

export async function processPlaylistOperation(payload = {}) {
  const kind = String(payload?.kind || payload?.type || "").trim();
  return withHonkerLock(
    "playlist-operation",
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
        case "reset-flows":
          return resetFlows(payload);
        case "adopt-flow-seed":
          return adoptFlowSeed(payload);
        case "static-playlist-create":
          return createStaticPlaylist(payload);
        case "static-playlist-append-tracks":
          return appendStaticPlaylistTracks(payload);
        case "static-playlist-update":
          return updateStaticPlaylist(payload);
        case "static-playlist-bulk": {
          const { processStaticPlaylistBulkOperation } = await import("./bulkOperations.js");
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
    },
    {
      ttlSeconds: 180,
      waitTimeoutMs: 30 * 60 * 1000,
      retryDelayMs: 250,
    },
  );
}
