import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { listHonkerJobs } from "../honkerDb.js";
import { logger } from "../logger.js";
import { recordTrackJobQueued } from "../aurralHistoryService.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";
import { cancelDownloadWorkForJobs } from "../downloadJobs/downloadCancellationService.js";
import { restoreDownloadJobCancellations } from "../downloadJobs/downloadCancellation.js";
import { replaceAlbumDownloadLeaderInTransaction } from "../downloadJobs/downloadOwnership.js";
import {
  normalizeExistingFileMode,
  removeLibraryFileIfUnshared,
  reuseTrackForPlaylist,
} from "../downloadJobs/fileReuse.js";
import { withPlaylistMutation, withPlaylistMutationLock } from "../downloadJobs/mutationGuards.js";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  orderJobsByPlaylistTracks,
  tracksShareMembership,
} from "./flowPlaylistConfig.js";
import { playlistManager } from "./playlistManager.js";

export const LIBRARY_OWNER = "library";
const ACTIVE_STATUSES = ["pending", "downloading", "blocked"];
const REMOVED_MEDIA_PREFIX = "playlistRemovedMedia:";

export function getStaticPlaylistJobIds(playlist) {
  return [...new Set((playlist?.tracks || []).map((track) => track?.jobId).filter(Boolean))];
}

export function getStaticPlaylistJobs(playlist) {
  const jobs = getStaticPlaylistJobIds(playlist).map((id) => downloadTracker.getJob(id)).filter(Boolean);
  return orderJobsByPlaylistTracks(jobs, playlist?.tracks);
}

export function getStaticPlaylistsReferencingJob(jobId, excludedPlaylistId = null) {
  return flowPlaylistConfig.getStaticPlaylists().filter((playlist) =>
    playlist.id !== excludedPlaylistId && playlist.tracks.some((track) => track.jobId === jobId));
}

export function staticPlaylistReferencesJob(playlist, jobId) {
  return Boolean(playlist?.tracks?.some((track) => track.jobId === jobId));
}

export function captureStaticPlaylistSelection(playlist, jobId) {
  const job = downloadTracker.getJob(jobId);
  const track = playlist?.tracks?.find((entry) => entry.jobId === jobId);
  if (!job || job.upgradeForJobId || !track) return null;
  return { jobId, membershipId: track.membershipId || null };
}

export function isStaticPlaylistSelectionCurrent(selection, playlist) {
  return Boolean(playlist?.tracks?.some((track) =>
    track.jobId === selection.jobId &&
    (!selection.membershipId || track.membershipId === selection.membershipId)));
}

export function getReleasedUnfinishedJobs(playlist, jobIds) {
  return [...new Set(jobIds)]
    .map((jobId) => downloadTracker.getJob(jobId))
    .filter((job) => job && job.queuedForPlaylist && !job.upgradeForJobId && job.status !== "done" &&
      staticPlaylistReferencesJob(playlist, job.id) && getStaticPlaylistsReferencingJob(job.id, playlist.id).length === 0);
}

export function findLibraryJob(track) {
  const jobs = downloadTracker.getByOwner(LIBRARY_OWNER).filter((job) => tracksShareMembership(job, track));
  return (
    jobs.find((job) => ACTIVE_STATUSES.includes(job.status)) ||
    jobs.find((job) => job.status === "done") ||
    jobs.find((job) => job.status === "failed") ||
    null
  );
}

async function linkTrack(track, { existingFileMode, downloadRoot }) {
  const existing = findLibraryJob(track);
  if (existing) {
    if (existing.status === "failed") {
      downloadTracker.setPending(existing.id, "Requested again", { asRetryCycle: true });
      return { jobId: existing.id, queued: true };
    }
    return { jobId: existing.id, queued: existing.status !== "done", reused: existing.status === "done" };
  }
  if (normalizeExistingFileMode(existingFileMode) !== "download") {
    try {
      const reuse = await reuseTrackForPlaylist(track, LIBRARY_OWNER, {
        existingFileMode,
        downloadRoot,
        targetOwnerId: LIBRARY_OWNER,
        skipHistory: true,
      });
      if (reuse.reused) return { jobId: reuse.jobId, reused: true };
    } catch (error) {
      logger.warn("playlists", "Could not reuse an existing file for a playlist track", {
        artistName: track.artistName,
        trackName: track.trackName,
        reason: error?.message || String(error),
      });
    }
  }
  const jobId = downloadTracker.addJob(track, LIBRARY_OWNER, { queuedForPlaylist: true });
  if (!jobId) return null;
  recordTrackJobQueued(downloadTracker.getJob(jobId));
  return { jobId, queued: true, created: true };
}

export async function linkStaticPlaylistTracks(tracks) {
  const { existingFileMode } = downloadWorker.getWorkerSettings();
  const linked = [];
  const createdJobIds = [];
  let tracksQueued = 0;
  let tracksReused = 0;
  for (const track of tracks) {
    const current = track.jobId ? downloadTracker.getJob(track.jobId) : null;
    if (current && tracksShareMembership(current, track)) {
      linked.push(track);
      continue;
    }
    const link = await linkTrack(track, { existingFileMode, downloadRoot: downloadWorker.downloadRoot });
    if (!link) {
      linked.push({ ...track, jobId: undefined });
      continue;
    }
    if (link.created) createdJobIds.push(link.jobId);
    if (link.queued) tracksQueued += 1;
    if (link.reused) tracksReused += 1;
    linked.push({ ...track, jobId: link.jobId });
  }
  return { tracks: linked, createdJobIds, tracksQueued, tracksReused };
}

export function discardCreatedJobs(jobIds) {
  for (const jobId of jobIds) downloadTracker.removeJob(jobId);
}

export function withStaticPlaylistRelease(playlistIds, operation) {
  return withPlaylistMutation([...playlistIds, LIBRARY_OWNER], operation, { clearPending: false });
}

function replacementPeer(job, releasingIds) {
  const row = listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.albumGrab === true && entry.payload.jobId === job.id);
  if (!row) return null;
  return (row.payload.albumGroupJobIds || []).map((id) => downloadTracker.getJob(id))
    .filter((peer) => peer && !releasingIds.has(peer.id) && peer.requestGroupId === job.requestGroupId &&
      peer.albumMbid === job.albumMbid && peer.status === "downloading" && !downloadTracker.isSlskdDispatched(peer.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function recoverCancelledJobs(jobs, reason) {
  restoreDownloadJobCancellations(jobs.map((job) => job.id));
  for (const job of jobs) {
    if (downloadTracker.getJob(job.id)?.status === "downloading") {
      downloadTracker.setFailed(job.id, reason);
    }
  }
}

async function planRelease(job, { playlistId, deleteFiles, releasingIds }) {
  if (!job.queuedForPlaylist || job.upgradeForJobId || getStaticPlaylistsReferencingJob(job.id, playlistId).length) {
    if (job.status !== "done") restoreDownloadJobCancellations([job.id]);
    return { job, action: "detach" };
  }
  const upgrades = downloadTracker.getAll().filter((entry) => entry.upgradeForJobId === job.id);
  if (job.status === "done") {
    if (!deleteFiles) return { job, action: "keep" };
    if (upgrades.length) await cancelDownloadWorkForJobs(upgrades, { lock: false });
    return { job, upgrades, action: "delete", cancelled: upgrades };
  }
  const peer = replacementPeer(job, releasingIds);
  if (peer) return { job, peer, action: "handover" };
  await cancelDownloadWorkForJobs([job, ...upgrades], { lock: false });
  return { job, upgrades, action: "cancel", cancelled: [job, ...upgrades] };
}

export async function commitStaticPlaylistTracks({
  playlistId,
  tracks,
  updates = {},
  deleteFiles = true,
  requireAll = false,
  onCommitted,
}) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist) throw new Error("Playlist no longer exists");
  const keptJobIds = new Set(tracks.map((track) => track.jobId).filter(Boolean));
  const releasingIds = new Set(getStaticPlaylistJobIds(playlist).filter((id) => !keptJobIds.has(id)));
  const plans = [];
  const outcomes = [];
  const failedJobIds = new Set();
  for (const jobId of releasingIds) {
    const job = downloadTracker.getJob(jobId);
    if (!job) {
      outcomes.push({ jobId, status: "alreadyAbsent" });
      continue;
    }
    try {
      plans.push(await planRelease(job, { playlistId, deleteFiles, releasingIds }));
      outcomes.push({ jobId, status: "removed" });
    } catch (error) {
      recoverCancelledJobs(
        [job, ...downloadTracker.getAll().filter((entry) => entry.upgradeForJobId === jobId)],
        "Provider cleanup failed. Retry removal or search again.",
      );
      failedJobIds.add(jobId);
      outcomes.push({ jobId, status: "failed", message: error.message });
    }
  }
  const recover = () => {
    for (const plan of plans) {
      if (plan.cancelled?.length) {
        recoverCancelledJobs(plan.cancelled, "Removal could not be saved after provider cleanup. Retry removal or search again.");
      }
    }
  };
  if (requireAll && failedJobIds.size) {
    recover();
    throw new Error(outcomes.find((outcome) => outcome.status === "failed").message);
  }
  const finalTracks = [
    ...tracks,
    ...playlist.tracks.filter((track) => failedJobIds.has(track.jobId)),
  ];
  const redirects = [];
  try {
    db.transaction(() => {
      for (const plan of plans) {
        if (plan.action === "keep") {
          db.prepare("UPDATE download_jobs SET queued_for_playlist = 0 WHERE id = ?").run(plan.job.id);
        } else if (plan.action === "handover") {
          redirects.push(replaceAlbumDownloadLeaderInTransaction(plan.job.id, plan.peer.id));
        } else if (plan.action === "delete" || plan.action === "cancel") {
          const { job } = plan;
          if (plan.action === "delete" && job.finalPath && !job.externalPath && job.managedBy === "aurral") {
            dbOps.setJSONSetting(`${REMOVED_MEDIA_PREFIX}${job.id}`, { playlistId, finalPath: job.finalPath });
          }
          for (const entry of [job, ...plan.upgrades]) {
            db.prepare("DELETE FROM download_jobs WHERE id = ?").run(entry.id);
          }
        }
      }
      const updated = flowPlaylistConfig.updateStaticPlaylist(playlistId, { ...updates, tracks: finalTracks });
      if (!updated) throw new Error("Could not save the playlist");
      onCommitted?.(outcomes);
    })();
  } catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    downloadTracker.reconcileCommittedJobs();
    recover();
    throw error;
  }
  downloadTracker.reconcileCommittedJobs(redirects);
  await cleanupRemovedLibraryFiles();
  return { outcomes, playlist: flowPlaylistConfig.getStaticPlaylist(playlistId) };
}

export async function cleanupRemovedLibraryFiles() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${REMOVED_MEDIA_PREFIX}%`);
  for (const row of rows) {
    const intent = JSON.parse(row.value);
    try {
      await removeLibraryFileIfUnshared(intent.finalPath, {
        downloadRoot: downloadWorker.downloadRoot,
        excludeEntityIds: [intent.playlistId],
      });
    } catch (error) {
      logger.warn("playlists", "Could not remove a file that a playlist downloaded", {
        playlistId: intent.playlistId,
        reason: error?.message || String(error),
      });
      continue;
    }
    db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
  }
}

function playlistsWithMissingDownloads() {
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
  const jobIds = new Set(downloadTracker.getAll().map((job) => job.id));
  return flowPlaylistConfig.getStaticPlaylists()
    .map((playlist) => ({
      playlist,
      tracks: playlist.tracks.filter((track) => !track.jobId || jobIds.has(track.jobId)),
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
  for (const playlistId of repairedIds) {
    await playlistManager.refreshPlaylist(playlistId).catch((error) => {
      logger.warn("playlists", "Could not republish a playlist after removing missing tracks", {
        playlistId,
        message: error?.message || String(error),
      });
    });
  }
  return repairedIds;
}
