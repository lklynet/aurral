import { withPlaylistMutation, withPlaylistMutationLock } from "../downloadJobs/mutationGuards.js";
import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { listHonkerJobs } from "../honkerDb.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { flowPlaylistConfig, invalidateFlowPlaylistConfigCache, tracksShareMembership } from "./flowPlaylistConfig.js";
import { cancelDownloadWorkForJobs } from "../downloadJobs/downloadCancellationService.js";
import { isDownloadJobCancelled, restoreDownloadJobCancellations } from "../downloadJobs/downloadCancellation.js";
import { transferDownloadOwnershipInTransaction, replaceAlbumDownloadLeaderInTransaction } from "../downloadJobs/downloadOwnership.js";
import { prepareRetainedPlaylistFile, commitRetainedPlaylistRelocationInTransaction } from "./mediaRelocation.js";
import { removePlaylistFileIfUnshared } from "../downloadJobs/fileReuse.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";
import { playlistManager } from "./playlistManager.js";

export function getSharedDownloadReferences(jobId, excludedPlaylistId) {
  return flowPlaylistConfig.getStaticPlaylists().filter((playlist) => playlist.id !== excludedPlaylistId &&
    playlist.tracks.some((track) => track.canonicalJobId === jobId));
}

function playlistsWithMissingDownloads() {
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
  const jobIds = new Set(downloadTracker.getAll().map((job) => job.id));
  return flowPlaylistConfig.getStaticPlaylists()
    .map((playlist) => ({
      playlist,
      tracks: playlist.tracks.filter((track) => !track.canonicalJobId || jobIds.has(track.canonicalJobId)),
    }))
    .filter(({ playlist, tracks }) => tracks.length < playlist.tracks.length);
}

export async function removePlaylistTracksWithoutDownloads() {
  const playlistIds = playlistsWithMissingDownloads().map(({ playlist }) => playlist.id);
  if (!playlistIds.length) return [];
  const repairedIds = await withPlaylistMutationLock(playlistIds, () =>
    playlistsWithMissingDownloads()
      .filter(({ playlist, tracks }) => playlistIds.includes(playlist.id) &&
        flowPlaylistConfig.updateStaticPlaylist(playlist.id, { tracks }))
      .map(({ playlist }) => playlist.id));
  playlistManager.updateConfig(false);
  for (const playlistId of repairedIds) await playlistManager.refreshPlaylist(playlistId);
  return repairedIds;
}

export function captureStaticPlaylistSelection(playlist, jobId) {
  const job = downloadTracker.getJob(jobId);
  if (!job || job.upgradeForJobId) return null;
  const track = playlist.tracks.find((entry) => entry.canonicalJobId === jobId ||
    (!entry.canonicalJobId && job.playlistType === playlist.id && tracksShareMembership(entry, job)));
  if (job.playlistType !== playlist.id && !track?.canonicalJobId) return null;
  return { jobId, membershipId: track?.membershipId || null, jobPlaylistId: job.playlistType,
    jobGeneration: job.playlistGeneration, jobCreatedAt: job.createdAt };
}

export function getPlaylistRemovalLockIds(playlistId, jobs, extraIds = []) {
  const owners = [playlistId, ...extraIds];
  const related = new Map(jobs.map((job) => [job.id, job]));
  const allJobs = downloadTracker.getAll();
  const pipelineRows = listHonkerJobs("slskd-pipeline");
  for (const job of related.values()) {
    owners.push(job.playlistType, ...getSharedDownloadReferences(job.id, playlistId).map((playlist) => playlist.id));
    for (const candidate of allJobs) {
      if (candidate.upgradeForJobId === job.id ||
          (job.status === "done" && job.finalPath && candidate.status === "done" && candidate.finalPath === job.finalPath)) {
        related.set(candidate.id, candidate);
      }
    }
    for (const row of pipelineRows) {
      const groupIds = row.payload?.albumGroupJobIds || [];
      if (row.payload?.jobId !== job.id && !groupIds.includes(job.id)) continue;
      owners.push(row.payload.playlistId);
      for (const id of [row.payload.jobId, ...groupIds]) {
        const peer = downloadTracker.getJob(id);
        if (peer) related.set(id, peer);
      }
    }
  }
  return [...new Set(owners.filter(Boolean))];
}

export async function withStaticPlaylistRemovalMutation({ playlistId, jobIds, extraPlaylistIds = [] }, operation) {
  while (true) {
    const readJobs = () => jobIds.map((id) => downloadTracker.getJob(id)).filter(Boolean);
    const lockIds = getPlaylistRemovalLockIds(playlistId, readJobs(), extraPlaylistIds);
    const result = await withPlaylistMutationLock(lockIds, async () => {
      if (!getPlaylistRemovalLockIds(playlistId, readJobs(), extraPlaylistIds).every((id) => lockIds.includes(id))) return { retryLocks: true };
      return { value: await withPlaylistMutation(lockIds, operation, { clearPending: false }) };
    });
    if (!result.retryLocks) return result.value;
  }
}

export function isStaticPlaylistSelectionCurrent(selection, playlist, job) {
  if (selection.membershipId) {
    const track = playlist.tracks.find((entry) => entry.membershipId === selection.membershipId);
    return Boolean(track && (!job || track.canonicalJobId === job.id ||
      (!track.canonicalJobId && job.playlistType === playlist.id && tracksShareMembership(track, job))));
  }
  return Boolean(job && job.playlistType === playlist.id && job.playlistType === selection.jobPlaylistId &&
    job.playlistGeneration === selection.jobGeneration && job.createdAt === selection.jobCreatedAt);
}

function replacementPeer(job, removingIds) {
  const row = listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.albumGrab === true && entry.payload.jobId === job.id);
  if (!row) return null;
  return (row.payload.albumGroupJobIds || []).map((id) => downloadTracker.getJob(id))
    .filter((peer) => peer && !removingIds.has(peer.id) && peer.requestGroupId === job.requestGroupId &&
      peer.albumMbid === job.albumMbid && peer.status === "downloading" && !downloadTracker.isSlskdDispatched(peer.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

export async function removeStaticPlaylistSelectionsLocked({ playlistId, selections, deleteFiles = false, requireAll = false, onCommitted }) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist) throw new Error("Source playlist no longer exists");
  const removingIds = new Set(selections.filter((selection) => isStaticPlaylistSelectionCurrent(selection, playlist, downloadTracker.getJob(selection.jobId))).map((selection) => selection.jobId));
  const plans = [];
  const preparedFiles = new Map();
  const affectedPlaylistIds = new Set();
  const outcomes = [];
  for (const selection of selections) {
    const job = downloadTracker.getJob(selection.jobId);
    if (!isStaticPlaylistSelectionCurrent(selection, playlist, job)) {
      outcomes.push({ jobId: selection.jobId, status: job ? "failed" : "alreadyAbsent",
        ...(job ? { message: "The selected membership changed. Select the track again." } : {}) });
      continue;
    }
    try {
      const owned = job?.playlistType === playlistId;
      const references = owned ? getSharedDownloadReferences(job.id, playlistId) : [];
      const target = references.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      const peer = owned && !target ? replacementPeer(job, removingIds) : null;
      const upgrades = owned ? downloadTracker.getByPlaylistId(playlistId).filter((entry) => entry.upgradeForJobId === job.id) : [];
      if (owned && !target && !peer) {
        await cancelDownloadWorkForJobs([job, ...upgrades], { lock: false });
      } else if (owned && target) {
        restoreDownloadJobCancellations([job.id, ...upgrades.map((entry) => entry.id)]);
      }
      let relocation = null;
      if (owned && job.status === "done") {
        const otherFileJob = downloadTracker.getAll().find((entry) => !removingIds.has(entry.id) && entry.status === "done" && entry.finalPath === job.finalPath);
        const fileTarget = target?.id || otherFileJob?.playlistType;
        if (fileTarget) {
          relocation = preparedFiles.get(job.finalPath);
          if (!relocation) {
            relocation = await prepareRetainedPlaylistFile({ jobId: job.id, sourcePlaylistId: playlistId, targetPlaylistId: fileTarget, downloadRoot: downloadWorker.downloadRoot });
            preparedFiles.set(job.finalPath, relocation);
          }
        }
      }
      affectedPlaylistIds.add(playlistId);
      if (target) {
        for (const reference of references) affectedPlaylistIds.add(reference.id);
      }
      if (owned && job.status === "done") {
        for (const sameFileJob of downloadTracker.getAll().filter((entry) => entry.finalPath === downloadTracker.getJob(job.id)?.finalPath)) {
          affectedPlaylistIds.add(sameFileJob.playlistType);
          for (const reference of getSharedDownloadReferences(sameFileJob.id, playlistId)) affectedPlaylistIds.add(reference.id);
        }
      }
      plans.push({ selection, job, owned, target, peer, upgrades, relocation });
      outcomes.push({ jobId: selection.jobId, status: job ? "removed" : "alreadyAbsent" });
    } catch (error) {
      if (job?.playlistType === playlistId && isDownloadJobCancelled(job.id)) {
        const cancelledJobs = [job, ...downloadTracker.getByPlaylistId(playlistId)
          .filter((entry) => entry.upgradeForJobId === job.id)];
        restoreDownloadJobCancellations(cancelledJobs.map((entry) => entry.id));
        for (const entry of cancelledJobs) {
          if (["pending", "downloading"].includes(entry.status)) downloadTracker.setFailed(entry.id, "Provider cleanup failed. Retry removal or search again.");
        }
      }
      outcomes.push({ jobId: selection.jobId, status: "failed", message: error.message });
    }
  }
  const recoverCancelledPlans = () => {
    for (const plan of plans) {
      if (plan.owned && !plan.target && !plan.peer) {
        restoreDownloadJobCancellations([plan.job.id, ...plan.upgrades.map((job) => job.id)]);
        for (const job of [plan.job, ...plan.upgrades]) {
          if (["pending", "downloading"].includes(job.status)) downloadTracker.setFailed(job.id, "Removal could not be saved after provider cleanup. Retry removal or search again.");
        }
      }
    }
  };
  if (requireAll && outcomes.some((outcome) => outcome.status === "failed")) {
    recoverCancelledPlans();
    throw new Error(outcomes.find((outcome) => outcome.status === "failed").message);
  }
  const redirects = [];
  try {
    db.transaction(() => {
      for (const relocation of new Set(plans.map((plan) => plan.relocation))) commitRetainedPlaylistRelocationInTransaction(relocation);
      for (const plan of plans) {
        if (!plan.owned) continue;
        if (plan.target) {
          for (const job of [plan.job, ...plan.upgrades]) redirects.push(transferDownloadOwnershipInTransaction(job.id, plan.target.id));
        } else if (plan.peer) {
          redirects.push(replaceAlbumDownloadLeaderInTransaction(plan.job.id, plan.peer.id));
        } else {
          for (const job of [plan.job, ...plan.upgrades]) {
            if (deleteFiles && job.status === "done" && job.finalPath && !job.externalPath && job.managedBy === "aurral") {
              dbOps.setJSONSetting(`playlistRemovedMedia:${job.id}`, { playlistId, finalPath: plan.relocation?.finalPath || job.finalPath });
            }
            db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(job.id);
          }
        }
      }
      if (plans.length) {
        const detached = new Set(plans.map((plan) => plan.selection.membershipId).filter(Boolean));
        const updated = flowPlaylistConfig.updateStaticPlaylist(playlistId, { tracks: playlist.tracks.filter((track) => !detached.has(track.membershipId)) });
        if (!updated) throw new Error("Could not persist source membership changes");
      }
      onCommitted?.(outcomes, [...affectedPlaylistIds]);
    })();
  } catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    recoverCancelledPlans();
    throw error;
  }
  downloadTracker.reconcileCommittedJobs(redirects);
  await cleanupRemovedPlaylistFiles(playlistId);
  return { outcomes, changed: plans.length > 0, affectedPlaylistIds: [...affectedPlaylistIds] };
}

export async function cleanupRemovedPlaylistFiles(playlistId) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'playlistRemovedMedia:%'").all();
  for (const row of rows) {
    const intent = JSON.parse(row.value);
    if (intent.playlistId !== playlistId) continue;
    await removePlaylistFileIfUnshared(intent.finalPath, playlistId, {
      downloadRoot: downloadWorker.downloadRoot, deleteIfUnshared: true,
    });
    db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
  }
}
