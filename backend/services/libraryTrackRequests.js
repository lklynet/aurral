import { db } from "../config/db-sqlite.js";
import { recordTrackJobQueued } from "./aurralHistoryService.js";
import { clearTrackMonitoringExclusion } from "./aurralMonitoringStore.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { getLibraryTrackOwnership } from "./libraryQueryService.js";
import { logger } from "./logger.js";

const libraryTrackStmt = db.prepare("SELECT 1 FROM library_tracks WHERE mbid = ? LIMIT 1");

const sameText = (left, right) =>
  String(left || "").toLocaleLowerCase() === String(right || "").toLocaleLowerCase();

export function findQueuedLibraryTrackJob({ artistName, trackName, trackMbid = null }) {
  return downloadTracker.getAll().find((job) => {
    if (job.playlistType !== "library" || ["failed", "done"].includes(job.status)) return false;
    if (trackMbid) return job.trackMbid === trackMbid;
    return sameText(job.artistName, artistName) && sameText(job.trackName, trackName);
  }) || null;
}

// Asking for a track is the user's way to want it again, so it also clears an
// exclusion left by deleting it. An automatic request from artist monitoring
// leaves exclusions and tracks the Library already lists alone.
export async function requestLibraryTrack(track, { canonicalTrackId = null, user = null, automatic = false } = {}) {
  if (!automatic) {
    clearTrackMonitoringExclusion({
      mbid: track.trackMbid,
      artistMbid: track.artistMbid,
      artistName: track.artistName,
      title: track.trackName,
    });
  }
  const alreadyOwned = getLibraryTrackOwnership({
    trackMbid: track.trackMbid,
    artistName: track.artistName,
    trackName: track.trackName,
  });
  if (alreadyOwned) return { alreadyOwned: true, queued: false };

  if (automatic && track.trackMbid && libraryTrackStmt.get(track.trackMbid)) {
    return { queued: false, skipped: true };
  }
  const monitoredTrack = automatic ? null : await (await import("./libraryManager.js"))
    .libraryManager.monitorAurralTrack({ canonicalTrackId, trackMbid: track.trackMbid, albumMbid: track.albumMbid });
  if (monitoredTrack) {
    for (const jobId of monitoredTrack.queuedJobIds) {
      recordTrackJobQueued(downloadTracker.getJob(jobId), user);
    }
    return {
      queued: monitoredTrack.queuedJobIds.length > 0,
      jobId: monitoredTrack.queuedJobIds[0] || null,
      monitored: true,
    };
  }

  const existingJob = findQueuedLibraryTrackJob(track);
  if (existingJob) {
    if (!automatic) recordTrackJobQueued(existingJob);
    return { queued: true, jobId: existingJob.id, alreadyQueued: true };
  }

  const jobId = downloadTracker.addJob(track, "library");
  if (!jobId) return { error: "Track details are incomplete", statusCode: 400 };

  const { downloadWorker } = await import("./downloadJobs/downloadWorker.js");
  try {
    const { normalizeExistingFileMode, reuseTrackForPlaylist } = await import("./downloadJobs/fileReuse.js");
    const reuse = await reuseTrackForPlaylist(track, "library", {
      existingFileMode: normalizeExistingFileMode(downloadWorker.getWorkerSettings().existingFileMode),
      downloadRoot: downloadWorker.downloadRoot,
      existingJobId: jobId,
      targetPlaylistType: "library",
      skipHistory: true,
    });
    if (reuse.reused) return { queued: false, reused: true, jobId };
  } catch (error) {
    logger.warn("library", "Track reuse failed; leaving acquisition queued", {
      error: error.message,
    });
  }

  recordTrackJobQueued(downloadTracker.getJob(jobId), user);
  await downloadWorker.start();
  return { queued: true, jobId };
}
