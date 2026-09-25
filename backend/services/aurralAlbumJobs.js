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

export function jobMatchesTrack(job, track) {
  if (job.trackMbid && track.mbid) {
    return normalizeKey(job.trackMbid) === normalizeKey(track.mbid);
  }
  return normalizeKey(job.trackName) === normalizeKey(track.title);
}

function selectStatus(counts, { sourceConfigured, sourceMessage, failedError }) {
  const unavailable = counts.total - counts.available;
  if (counts.total > 0 && unavailable === 0) return { status: "complete" };
  if (counts.downloading + counts.cancel_requested + counts.done > 0) {
    return { status: "downloading" };
  }
  if (counts.pending > 0) return { status: "queued" };
  if (counts.blocked > 0) {
    return {
      status: "blocked",
      recovery: {
        code: "review_required",
        message: "Some tracks need review before they can be added to the library.",
        action: "review-blocked-tracks",
      },
    };
  }
  if (counts.cancelled > 0) return { status: "cancelled" };
  if (!sourceConfigured && unavailable > 0) {
    return {
      status: "blocked",
      recovery: {
        code: "download_source_missing",
        message: sourceMessage,
        action: "configure-download-source",
      },
    };
  }
  const sourceFailed = counts.failed > 0
    ? {
      code: "source_failed",
      message: failedError || "No download source could provide the missing tracks.",
      action: "retry-album",
    }
    : null;
  if (counts.failed > 0 && counts.available === 0) {
    return { status: "failed", recovery: sourceFailed };
  }
  if (counts.available > 0) return { status: "partial", recovery: sourceFailed };
  return { status: "missing" };
}

export function summarizeAurralAlbum({ tracks = [], jobs = [], sourceConfigured, sourceMessage }) {
  const counts = {
    total: tracks.length,
    available: 0,
    missing: 0,
    pending: 0,
    downloading: 0,
    done: 0,
    cancel_requested: 0,
    cancelled: 0,
    blocked: 0,
    failed: 0,
  };
  let latestJob = null;
  let failedError = null;
  for (const track of tracks) {
    if (track.available === true) {
      counts.available += 1;
      continue;
    }
    const job = jobs.filter((entry) => jobMatchesTrack(entry, track)).at(-1);
    if (!job || !(job.status in counts)) {
      counts.missing += 1;
      continue;
    }
    counts[job.status] += 1;
    if (job.status === "failed" && !failedError) failedError = job.error || null;
    if (!latestJob || Number(job.createdAt) >= Number(latestJob.createdAt)) latestJob = job;
  }
  const { status, recovery = null } = selectStatus(counts, {
    sourceConfigured,
    sourceMessage,
    failedError,
  });
  return {
    status,
    counts,
    recovery,
    requestGroupId: latestJob?.requestGroupId || null,
  };
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
