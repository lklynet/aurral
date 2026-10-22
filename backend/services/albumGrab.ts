import path from "node:path";
import {
  recordAlbumGrabQueued,
  recordAlbumGrabPhase,
  recordAlbumTrackState,
} from "./albumGrabActivity.ts";
import {
  downloadTracker,
  NO_RELEASE_REASON,
  type DownloadJob,
  type JobFields,
} from "./downloadJobs/downloadTracker.ts";
import { assignDownloadedAlbumFiles } from "./albumReleaseAssignment.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import {
  buildResolvedJobTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeImportedFileMetadata,
} from "./downloadUtils.ts";
import {
  buildNextCandidatePayload,
  finalizePipelineJobSuccess,
  getPayloadCandidate,
  hasNextCandidate,
} from "./pipelineHelpers.ts";
import {
  getActiveDownloadAttemptId,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.ts";
import { downloadDestinationForJob } from "./downloadJobs/downloadOwnership.ts";
import { attemptRelease } from "./releaseResolver.ts";

type AlbumGrabPayload = Parameters<typeof recordAlbumGrabPhase>[0] & {
  downloadAttemptId?: string | null;
  heldForReview?: unknown;
};

const NOT_IN_ALBUM_REASON = "Track was not in the album download";
const NO_RELEASE_FILLED_REASON = "No release from this source filled the missing tracks";

const albumGroupJobIds = (payload: AlbumGrabPayload) =>
  payload?.albumGroupJobIds || [payload?.jobId];

const sameRequest = (job: DownloadJob, leader: DownloadJob) =>
  leader.upgradeForJobId
    ? Boolean(job.upgradeForJobId)
    : (job.requestGroupId || null) === (leader.requestGroupId || null);

export function albumGrabJobs(payload: AlbumGrabPayload): DownloadJob[] {
  const leader = downloadTracker.getJob(payload.jobId);
  if (!leader || payload.albumGrab !== true) return [];
  return albumGroupJobIds(payload)
    .map((id) => downloadTracker.getJob(id))
    .filter((job): job is DownloadJob =>
      Boolean(
        job &&
        sameRequest(job, leader) &&
        job.albumMbid === leader.albumMbid &&
        ["pending", "downloading"].includes(job.status),
      ),
    );
}

// The tracks an attempt still holds, its leading track included: live, and
// not given back or claimed by another attempt since.
export function heldAlbumGrabJobs(payload: AlbumGrabPayload): DownloadJob[] {
  return albumGroupJobIds(payload)
    .map((id) => downloadTracker.getJob(id))
    .filter((job): job is DownloadJob =>
      Boolean(
        job &&
        ["pending", "downloading"].includes(job.status) &&
        !isDownloadJobCancelled(job.id) &&
        getActiveDownloadAttemptId(job.id) === payload.downloadAttemptId,
      ),
    );
}

// The union of every album job's blocked sources, so one album attempt
// never offers a file or release that failed for any of its tracks.
export function deniedAlbumSources(jobs: JobFields<"deniedRemoteSources">[], source: string) {
  return new Set(
    jobs.flatMap((job) =>
      (job.deniedRemoteSources || [])
        .filter((entry) => Array.isArray(entry) && entry[0] === source)
        .map((entry) =>
          String(entry[1] || "")
            .trim()
            .toLowerCase(),
        ),
    ),
  );
}

// Blocks the attempted release for every track it did not fill, so neither
// the next album attempt nor a per-track search takes it again.
export function blockAlbumGrabSource(payload: AlbumGrabPayload, jobs: DownloadJob[]) {
  const candidate = getPayloadCandidate(payload);
  for (const job of jobs) {
    if (payload.source === "slskd") {
      const file = (candidate?.raw?.files || []).find(
        (entry: { jobId?: string }) => entry.jobId === job.id,
      );
      if (file) {
        downloadTracker.recordDeniedSource(job.id, "slskd", `${candidate.raw.user}\0${file.file}`);
      }
    } else if (payload.source === "usenet" && candidate?.raw?.release?.guid) {
      downloadTracker.recordDeniedSource(job.id, "usenet", candidate.raw.release.guid);
    } else if (payload.source === "deemix" && candidate?.raw?.albumId) {
      downloadTracker.recordDeniedSource(job.id, "deemix", `album:${candidate.raw.albumId}`);
    }
  }
}

// When the leading track was filled, another unfilled track leads, with the
// file it holds for review instead of the filled track's.
function regroupAlbumGrab<Payload extends AlbumGrabPayload>(
  payload: Payload,
  remaining: DownloadJob[],
) {
  const leaderId = remaining.some((job) => job.id === payload.jobId)
    ? payload.jobId
    : remaining[0].id;
  downloadTracker.markSlskdDispatched(leaderId);
  return {
    ...payload,
    jobId: leaderId,
    albumGroupJobIds: [leaderId, ...remaining.map((job) => job.id).filter((id) => id !== leaderId)],
    heldForReview:
      leaderId === payload.jobId
        ? payload.heldForReview
        : downloadTracker.getJob(leaderId)?.heldForReview || null,
  };
}

// Tries the next ranked folder or release for the tracks an attempt left
// unfilled.
export function continueAlbumGrab(payload: AlbumGrabPayload, resetFields = {}) {
  const remaining = albumGrabJobs(payload);
  if (remaining.length === 0 || !hasNextCandidate(payload)) return null;
  return buildNextCandidatePayload(regroupAlbumGrab(payload, remaining), resetFields);
}

// After the last release of a source, the next album source in configured
// order searches for the tracks still unfilled before any track search.
export async function nextAlbumSource<Payload extends AlbumGrabPayload>(
  payload: Payload,
  reason = NO_RELEASE_FILLED_REASON,
) {
  const remaining = albumGrabJobs(payload);
  if (remaining.length === 0) return null;
  const { buildNextSourcePayload } = await import("./downloadPipeline.ts");
  const next = buildNextSourcePayload(payload, payload.source, reason);
  return next ? regroupAlbumGrab(next, remaining) : null;
}

// The worker stops when it runs out of work while an album holds its
// tracks, so the tracks an album gives back need it started again.
function giveBack(
  payload: AlbumGrabPayload,
  jobs: DownloadJob[],
  reason: string | null,
  reasons = new Map<string, string>(),
  options: { asRetryCycle?: boolean } = {},
) {
  let released = false;
  for (const job of jobs) {
    released =
      downloadTracker.releaseFromAlbumGrab(job.id, reasons.get(job.id) || reason, options) ||
      released;
  }
  if (!released) return;
  recordAlbumGrabPhase(payload, reason || "Album attempt ended; searching for missing tracks");
  void import("./downloadJobs/mutationGuards.ts")
    .then(({ wakeDownloadWorker }) => wakeDownloadWorker())
    .catch(() => {});
}

// The attempt tried its release for these tracks, so each searches for
// itself from now on.
export function releaseAlbumGrabJobs(
  payload: AlbumGrabPayload,
  reason: string | null = null,
  reasons = new Map<string, string>(),
) {
  giveBack(
    payload,
    heldAlbumGrabJobs(payload).filter((job) => job.id !== payload.jobId),
    reason,
    reasons,
  );
}

// The attempt ended before its source judged the release, so these tracks
// can still start another attempt.
export function returnUntriedAlbumGrabJobs(
  payload: AlbumGrabPayload,
  jobs: DownloadJob[],
  reason: string,
  { retry = false } = {},
) {
  for (const job of jobs) downloadTracker.setAlbumGrabAttempted(job.id, false);
  giveBack(payload, jobs, reason, new Map(), { asRetryCycle: retry });
}

export function fallbackAlbumGrabToTracks<Payload extends AlbumGrabPayload>(
  payload: Payload,
  reason: string | null = null,
  reasons = new Map<string, string>(),
) {
  recordAlbumGrabPhase(payload, reason || "Album attempt ended; searching for missing tracks");
  downloadTracker.endUpgradeReleaseDownload(payload.downloadAttemptId);
  releaseAlbumGrabJobs(payload, reason, reasons);
  return {
    ...payload,
    albumGrab: false,
    albumGroupJobIds: null,
    source: null,
    phase: "search",
    candidates: [],
    candidate: null,
    candidateIndex: 0,
    triedSources: [...(downloadTracker.getJob(payload.jobId)?.quickSearchedSources || [])],
    sourceErrors: [],
    queueUuid: null,
    queueUuids: null,
    nzbId: null,
    batchId: null,
    downloadedPath: null,
    downloadedPaths: null,
    albumTransfers: null,
    searchId: null,
    searchIds: null,
    searchQueries: null,
    searchQueryIndex: 0,
    activeSearch: null,
    history: null,
  };
}

export async function finishAlbumGrab(
  payload: AlbumGrabPayload,
  {
    filePaths,
    source,
    album = null,
    resetFields = {},
  }: {
    filePaths?: string[];
    source: "deemix" | "soulseek" | "usenet";
    album?: string | null;
    resetFields?: Record<string, unknown>;
  },
) {
  const jobs = albumGrabJobs(payload);
  if (jobs.length === 0) return null;
  recordAlbumGrabQueued(payload, jobs);
  const manifest = await attemptRelease(payload, downloadTracker.getJob(payload.jobId));
  if (!manifest) return fallbackAlbumGrabToTracks(payload, NO_RELEASE_REASON);
  // Only a listing the release judge accepted proves the release. A Usenet
  // title never does, and a candidate queued before candidates said so is
  // judged by its files like one.
  const assigned = await assignDownloadedAlbumFiles({
    jobs,
    filePaths,
    source,
    manifest,
    verified: getPayloadCandidate(payload)?.releaseVerified === true,
  });
  const reasons = new Map(
    assigned.rejected.map(({ jobId, reason }) => [
      jobId,
      `Album file failed verification: ${reason}`,
    ]),
  );
  const playlistRoot = resolveDownloadRoot();
  for (const match of assigned.accepted) {
    const job = downloadTracker.getJob(match.jobId);
    if (!job || !["pending", "downloading"].includes(job.status)) continue;
    const peerPayload = {
      ...payload,
      jobId: job.id,
      playlistId: job.playlistId || job.playlistType,
      playlistGeneration: job.playlistGeneration,
      destination: downloadDestinationForJob(job),
    };
    if (!isPipelinePayloadActive(peerPayload)) continue;
    try {
      const ext = path.extname(match.filePath).toLowerCase() || ".flac";
      const destination = joinUnderRoot(playlistRoot, peerPayload.destination);
      const placed = match.trackNumber
        ? { ...job, trackNumber: match.trackNumber, discNumber: match.discNumber }
        : job;
      const finalPath = path.join(destination, buildTrackFileName(placed, ext));
      const committed = await withPipelineCommitLock(peerPayload, async () => {
        const committedFinalPath = await commitDownloadedFile(match.filePath, finalPath);
        await writeImportedFileMetadata(committedFinalPath, buildResolvedJobTrack(placed), {
          source,
          jobId: job.id,
        });
        return finalizePipelineJobSuccess({
          downloadTracker,
          job,
          committedFinalPath,
          album,
          quality: match.validation.quality,
        });
      });
      if (committed.cancelled) continue;
      if (job.status === "done")
        recordAlbumTrackState(job, source === "soulseek" ? "slskd" : source);
    } catch (error) {
      reasons.set(job.id, "Album file import failed");
      logger.warn(source, "Album file import failed", {
        jobId: job.id,
        reason: safeLogDiagnostic(error),
      });
    }
  }
  if (assigned.accepted.length === 0 || (filePaths || []).length > assigned.unreadableCount) {
    blockAlbumGrabSource(payload, albumGrabJobs(payload));
  }
  const next = continueAlbumGrab(payload, resetFields) || (await nextAlbumSource(payload));
  if (next) return next;
  const leader = downloadTracker.getJob(payload.jobId);
  if (leader?.status === "done") {
    releaseAlbumGrabJobs(payload, NOT_IN_ALBUM_REASON, reasons);
    return null;
  }
  return fallbackAlbumGrabToTracks(payload, NOT_IN_ALBUM_REASON, reasons);
}
