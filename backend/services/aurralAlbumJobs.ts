import path from "node:path";
import {
  downloadTracker,
  type DownloadJob,
  type JobFields,
} from "./downloadJobs/downloadTracker.ts";
import {
  cancelDownloadJobs,
  restoreDownloadJobCancellations,
  setActiveDownloadAttemptId,
} from "./downloadJobs/downloadCancellation.ts";
import { cancelDownloadWorkForJobs } from "./downloadJobs/downloadCancellationService.ts";
import { logger } from "./logger.ts";
import type { LibraryTrack } from "./libraryQueryService.ts";
import type { HonkerPayload } from "./honkerDb.ts";
import { asAppError } from "../../lib/errors.ts";

export const ACTIVE_JOB_STATUSES = new Set(["pending", "downloading", "cancel_requested"]);
export const RETRYABLE_JOB_STATUSES = new Set([...ACTIVE_JOB_STATUSES, "failed", "cancelled"]);

type AlbumMbids = (string | null | undefined)[];
type AlbumTrackRef = Pick<LibraryTrack, "mbid" | "title">;

const payloadGroupJobIds = (payload: HonkerPayload | null) => {
  const ids = payload?.albumGroupJobIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

const normalizeKey = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const isAurralAlbumJob = (job: JobFields<"playlistType" | "managedBy">) =>
  job.playlistType === "library" && job.managedBy === "aurral";

// An album's jobs carry its release group or, from older versions, the
// release ID that a scan stored as the album's mbid.
const albumKeys = (albumMbids: AlbumMbids) =>
  new Set([albumMbids].flat().map(normalizeKey).filter(Boolean));

export function indexAurralAlbumJobs(albumMbids: AlbumMbids) {
  const requested = albumKeys(albumMbids);
  const jobsByAlbum = new Map<string, DownloadJob[]>();
  const position = new Map<DownloadJob, number>();
  if (requested.size > 0) {
    for (const job of downloadTracker.getByAlbumMbid((albumMbid) =>
      requested.has(normalizeKey(albumMbid)),
    )) {
      if (!isAurralAlbumJob(job)) continue;
      const albumKey = normalizeKey(job.albumMbid);
      const jobs = jobsByAlbum.get(albumKey) || [];
      jobs.push(job);
      jobsByAlbum.set(albumKey, jobs);
      position.set(job, position.size);
    }
  }
  return (mbids: AlbumMbids) =>
    [...albumKeys(mbids)]
      .flatMap((key) => jobsByAlbum.get(key) || [])
      .sort((left, right) => position.get(left)! - position.get(right)!);
}

export function findAurralAlbumJobs(albumMbids: AlbumMbids) {
  return indexAurralAlbumJobs(albumMbids)(albumMbids);
}

export function jobMatchesTrack(job: JobFields<"trackMbid" | "trackName">, track: AlbumTrackRef) {
  if (job.trackMbid && track.mbid) {
    return normalizeKey(job.trackMbid) === normalizeKey(track.mbid);
  }
  if (job.trackMbid) return false;
  return normalizeKey(job.trackName) === normalizeKey(track.title);
}

type AurralAlbumStatus =
  | "complete"
  | "downloading"
  | "queued"
  | "blocked"
  | "cancelled"
  | "failed"
  | "partial"
  | "missing";

type AurralAlbumRecovery = {
  code: "review_required" | "download_source_missing" | "source_failed";
  message: string;
  action: string;
};

type AlbumCounts = Record<DownloadJob["status"] | "total" | "available" | "missing", number>;

function selectStatus(
  counts: AlbumCounts,
  {
    sourceConfigured,
    sourceMessage,
    failedError,
  }: { sourceConfigured: boolean; sourceMessage: string | null; failedError: string | null },
): { status: AurralAlbumStatus; recovery?: AurralAlbumRecovery | null } {
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
        message: sourceMessage!,
        action: "configure-download-source",
      },
    };
  }
  const sourceFailed: AurralAlbumRecovery | null =
    counts.failed > 0
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

export function summarizeAurralAlbum({
  tracks = [],
  jobs = [],
  sourceConfigured,
  sourceMessage,
}: {
  tracks?: Pick<LibraryTrack, "mbid" | "title" | "available" | "monitored">[];
  jobs?: DownloadJob[];
  sourceConfigured: boolean;
  sourceMessage: string | null;
}) {
  const counts = {
    total: tracks.length,
    available: 0,
    missing: 0,
    pending: 0,
    downloading: 0,
    done: 0,
    cancel_requested: 0,
    cancelled: 0,
    saved: 0,
    blocked: 0,
    failed: 0,
  };
  let latestJob: DownloadJob | null = null;
  let failedError: string | null = null;
  for (const track of tracks) {
    if (track.available === true) {
      counts.available += 1;
      continue;
    }
    if (track.monitored === false) {
      counts.total -= 1;
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

async function cancelActiveAurralJobs(
  activeJobs: DownloadJob[],
  albumMbid: AlbumMbids | null,
  { lock = true } = {},
) {
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
    await cancelDownloadWorkForJobs(activeJobs, { lock });
  } catch (error) {
    logger.warn("library", "Aurral album cancellation is waiting on download provider cleanup", {
      albumMbid,
      jobCount: jobIds.length,
      message: asAppError(error)?.message || String(error),
    });
    return { cancelledJobIds: jobIds, cleanupFailed: true };
  }

  for (const jobId of jobIds) {
    downloadTracker.setCancelled(jobId);
  }
  return { cancelledJobIds: jobIds, cleanupFailed: false };
}

export async function cancelAurralAlbumJobs(albumMbid: AlbumMbids) {
  return cancelActiveAurralJobs(
    findAurralAlbumJobs(albumMbid).filter((job) => ACTIVE_JOB_STATUSES.has(job.status)),
    albumMbid,
  );
}

export async function cancelTrackDownload(jobId: string) {
  const { withPlaylistMutationLock } = await import("./downloadJobs/mutationGuards.ts");
  const job = downloadTracker.getJob(jobId);
  if (!job) return { statusCode: 404, error: "Track not found" };
  return withPlaylistMutationLock(job.playlistId || job.playlistType, async () => {
    const current = downloadTracker.getJob(jobId);
    if (!current) return { statusCode: 404, error: "Track not found" };
    if (!ACTIVE_JOB_STATUSES.has(current.status)) {
      return {
        statusCode: 409,
        error: "Track download is already finished",
        status: current.status,
      };
    }
    const { listHonkerJobs } = await import("./honkerDb.ts");
    const grab = listHonkerJobs("slskd-pipeline")
      .map(({ payload }) => payload)
      .find(
        (payload): payload is HonkerPayload =>
          payload?.albumGrab === true && payloadGroupJobIds(payload).includes(jobId),
      );
    const peers = payloadGroupJobIds(grab ?? null)
      .filter((id) => id !== jobId)
      .map((id) => downloadTracker.getJob(id))
      .filter(
        (peer): peer is DownloadJob =>
          peer?.status === "downloading" && !downloadTracker.isSlskdDispatched(peer.id),
      );
    if (grab && peers.length > 0) {
      if (grab.jobId === jobId) {
        const { db } = await import("../config/db-sqlite.ts");
        const { replaceAlbumDownloadLeaderInTransaction } =
          await import("./downloadJobs/downloadOwnership.ts");
        const redirect = db.transaction(() =>
          replaceAlbumDownloadLeaderInTransaction(jobId, peers[0].id, { retainCancelled: true }),
        )();
        downloadTracker.reconcileCommittedJobs([redirect]);
      }
      cancelDownloadJobs([jobId]);
      downloadTracker.setCancelled(jobId);
      downloadTracker.clearSlskdPipelineState(jobId);
      return { jobId, status: "cancelled", cleanupFailed: false };
    }
    const { cleanupFailed } = await cancelActiveAurralJobs([current], null, { lock: false });
    const cancelled = downloadTracker.getJob(jobId);
    if (!cancelled) return { statusCode: 404, error: "Track not found" };
    return { jobId, status: cancelled.status, cleanupFailed };
  });
}

export async function retryTrackDownload(jobId: string) {
  let job = downloadTracker.getJob(jobId);
  if (!job) return { statusCode: 404, error: "Track not found" };
  if (!RETRYABLE_JOB_STATUSES.has(job.status)) {
    return { statusCode: 409, error: "Track download cannot be retried", status: job.status };
  }

  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    const cancellation = await cancelTrackDownload(jobId);
    if (cancellation.statusCode) return cancellation;
    if (cancellation.cleanupFailed) {
      return {
        statusCode: 409,
        error: "The current download attempt could not be stopped",
        message:
          "Aurral kept the job in cancellation until its existing provider work can be cleaned up.",
        status: cancellation.status,
        cleanupFailed: true,
      };
    }
  }

  const { withPlaylistMutationLock, wakeDownloadWorker } =
    await import("./downloadJobs/mutationGuards.ts");
  job = downloadTracker.getJob(jobId);
  const result = await withPlaylistMutationLock(job?.playlistId || job?.playlistType, async () => {
    const current = downloadTracker.getJob(jobId);
    if (!current) return { statusCode: 404, error: "Track not found" };
    if (current.status !== "failed" && current.status !== "cancelled") {
      return { statusCode: 409, error: "Track download cannot be retried", status: current.status };
    }

    if (current.status === "cancelled" || current.status === "failed") {
      try {
        await cancelDownloadWorkForJobs([current], { lock: false });
      } catch {
        return {
          statusCode: 409,
          error: "The previous download attempt could not be stopped",
          message:
            "Aurral kept the job cancelled until its existing provider work can be cleaned up.",
          status: current.status,
          cleanupFailed: true,
        };
      }
    }

    setActiveDownloadAttemptId(jobId, null);
    restoreDownloadJobCancellations([jobId]);
    if (!downloadTracker.setPending(jobId, "Retry requested", { asRetryCycle: true })) {
      cancelDownloadJobs([jobId]);
      return { statusCode: 500, error: "Failed to queue track download" };
    }
    return { jobId, status: "pending", retried: true };
  });

  if (result.statusCode) return result;
  const { recordTrackJobSearching } = await import("./aurralHistoryService.ts");
  recordTrackJobSearching(downloadTracker.getJob(jobId));
  await wakeDownloadWorker();
  return result;
}

export async function cancelLibraryTrackJobs(
  track: Pick<LibraryTrack, "mbid" | "title" | "artistName">,
  ownerNames: string[] = [],
) {
  const artistNames = new Set([track.artistName, ...ownerNames].map(normalizeKey));
  return cancelActiveAurralJobs(
    downloadTracker
      .getAll()
      .filter(
        (job) =>
          job.playlistType === "library" &&
          ACTIVE_JOB_STATUSES.has(job.status) &&
          jobMatchesTrack(job, track) &&
          (Boolean(job.trackMbid) || artistNames.has(normalizeKey(job.artistName))),
      ),
    null,
  );
}

export async function cancelFileUpgradeJobs(filePaths: string[]) {
  const paths = new Set(filePaths.map((filePath) => path.resolve(filePath)));
  const upgradedPath = (job: DownloadJob) => downloadTracker.getJob(job.upgradeForJobId)?.finalPath;
  return cancelActiveAurralJobs(
    downloadTracker
      .getAll()
      .filter(
        (job) =>
          job.upgradeForJobId &&
          !job.manualReplacementSearch &&
          ACTIVE_JOB_STATUSES.has(job.status) &&
          upgradedPath(job) &&
          paths.has(path.resolve(upgradedPath(job)!)),
      ),
    null,
  );
}

export async function cancelAurralTrackJobs(albumMbid: AlbumMbids, track: AlbumTrackRef) {
  return cancelActiveAurralJobs(
    findAurralAlbumJobs(albumMbid).filter(
      (job) => ACTIVE_JOB_STATUSES.has(job.status) && jobMatchesTrack(job, track),
    ),
    albumMbid,
  );
}
