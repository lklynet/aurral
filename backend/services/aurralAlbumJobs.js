import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { cancelDownloadJobs } from "./weeklyFlow/weeklyFlowDownloadCancellation.js";
import { cancelDownloadWorkForJobs } from "./weeklyFlow/weeklyFlowDownloadCancellationService.js";
import { logger } from "./logger.js";

const ACTIVE_JOB_STATUSES = new Set(["pending", "downloading", "cancel_requested"]);

const normalizeKey = (value) => String(value || "").trim().toLowerCase();

export function findAurralAlbumJobs(albumMbid) {
  const albumKey = normalizeKey(albumMbid);
  if (!albumKey) return [];
  return downloadTracker.getAll().filter(
    (job) =>
      job.playlistType === "library" &&
      job.managedBy === "aurral" &&
      normalizeKey(job.albumMbid) === albumKey,
  );
}

export async function cancelAurralAlbumJobs(albumMbid) {
  const activeJobs = findAurralAlbumJobs(albumMbid).filter((job) =>
    ACTIVE_JOB_STATUSES.has(job.status),
  );
  if (activeJobs.length === 0) {
    return { cancelledJobIds: [], cleanupFailed: false };
  }

  const jobIds = activeJobs.map((job) => job.id);
  cancelDownloadJobs(jobIds);
  for (const job of activeJobs) {
    if (job.status === "pending") {
      downloadTracker.setCancelled(job.id);
    } else {
      downloadTracker.setCancelRequested(job.id);
    }
  }

  try {
    await cancelDownloadWorkForJobs(activeJobs);
  } catch (error) {
    logger.warn("library", "Aurral album cancellation is waiting on download provider cleanup", {
      albumMbid,
      jobCount: jobIds.length,
      message: error?.message || String(error),
    });
    return { cancelledJobIds: jobIds, cleanupFailed: true };
  }

  for (const jobId of jobIds) {
    downloadTracker.setCancelled(jobId);
  }
  return { cancelledJobIds: jobIds, cleanupFailed: false };
}
