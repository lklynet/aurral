import path from "node:path";
import { recordAlbumGrabQueued, recordAlbumGrabPhase, recordAlbumTrackState } from "./albumGrabActivity.js";
import { downloadTracker, NO_RELEASE_REASON } from "./downloadJobs/downloadTracker.js";
import { assignDownloadedAlbumFiles } from "./albumReleaseAssignment.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import {
  buildResolvedJobTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeImportedFileMetadata,
} from "./downloadUtils.js";
import {
  buildNextCandidatePayload,
  finalizePipelineJobSuccess,
  getPayloadCandidate,
  hasNextCandidate,
} from "./pipelineHelpers.js";
import {
  getActiveDownloadAttemptId,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.js";
import { downloadDestinationForJob } from "./downloadJobs/downloadOwnership.js";
import { attemptRelease } from "./releaseResolver.js";

const NOT_IN_ALBUM_REASON = "Track was not in the album download";
const NO_RELEASE_FILLED_REASON = "No release from this source filled the missing tracks";

const albumGroupJobIds = (payload) => payload?.albumGroupJobIds || [payload?.jobId];

const sameRequest = (job, leader) => (leader.upgradeForJobId
  ? Boolean(job.upgradeForJobId)
  : (job.requestGroupId || null) === (leader.requestGroupId || null));

export function albumGrabJobs(payload) {
  const leader = downloadTracker.getJob(payload.jobId);
  if (!leader || payload.albumGrab !== true) return [];
  return albumGroupJobIds(payload).map((id) => downloadTracker.getJob(id)).filter((job) =>
    job && sameRequest(job, leader) && job.albumMbid === leader.albumMbid
    && ["pending", "downloading"].includes(job.status));
}

// The tracks an attempt still holds, its leading track included: live, and
// not given back or claimed by another attempt since.
export function heldAlbumGrabJobs(payload) {
  return albumGroupJobIds(payload).map((id) => downloadTracker.getJob(id))
    .filter((job) => job && ["pending", "downloading"].includes(job.status) && !isDownloadJobCancelled(job.id)
      && getActiveDownloadAttemptId(job.id) === payload.downloadAttemptId);
}

// The union of every album job's blocked sources, so one album attempt
// never offers a file or release that failed for any of its tracks.
export function deniedAlbumSources(jobs, source) {
  return new Set(jobs.flatMap((job) => (job.deniedRemoteSources || [])
    .filter((entry) => Array.isArray(entry) && entry[0] === source)
    .map((entry) => String(entry[1] || "").trim().toLowerCase())));
}

// Blocks the attempted release for every track it did not fill, so neither
// the next album attempt nor a per-track search takes it again.
export function blockAlbumGrabSource(payload, jobs) {
  const candidate = getPayloadCandidate(payload);
  for (const job of jobs) {
    if (payload.source === "slskd") {
      const file = (candidate?.raw?.files || []).find((entry) => entry.jobId === job.id);
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
function regroupAlbumGrab(payload, remaining) {
  const leaderId = remaining.some((job) => job.id === payload.jobId)
    ? payload.jobId
    : remaining[0].id;
  downloadTracker.markSlskdDispatched(leaderId);
  return {
    ...payload,
    jobId: leaderId,
    albumGroupJobIds: [leaderId, ...remaining.map((job) => job.id).filter((id) => id !== leaderId)],
    heldForReview: leaderId === payload.jobId
      ? payload.heldForReview
      : downloadTracker.getJob(leaderId)?.heldForReview || null,
  };
}

// Tries the next ranked folder or release for the tracks an attempt left
// unfilled.
export function continueAlbumGrab(payload, resetFields = {}) {
  const remaining = albumGrabJobs(payload);
  if (remaining.length === 0 || !hasNextCandidate(payload)) return null;
  return buildNextCandidatePayload(regroupAlbumGrab(payload, remaining), resetFields);
}

// After the last release of a source, the next album source in configured
// order searches for the tracks still unfilled before any track search.
export async function nextAlbumSource(payload, reason = NO_RELEASE_FILLED_REASON) {
  const remaining = albumGrabJobs(payload);
  if (remaining.length === 0) return null;
  const { buildNextSourcePayload } = await import("./downloadPipeline.js");
  const next = buildNextSourcePayload(payload, payload.source, reason);
  return next ? regroupAlbumGrab(next, remaining) : null;
}

// The worker stops when it runs out of work while an album holds its
// tracks, so the tracks an album gives back need it started again.
function giveBack(payload, jobs, reason, reasons = new Map(), options = {}) {
  let released = false;
  for (const job of jobs) {
    released = downloadTracker.releaseFromAlbumGrab(job.id, reasons.get(job.id) || reason, options) || released;
  }
  if (!released) return;
  recordAlbumGrabPhase(payload, reason || "Album attempt ended; searching for missing tracks");
  void import("./downloadJobs/mutationGuards.js")
    .then(({ wakeDownloadWorker }) => wakeDownloadWorker())
    .catch(() => {});
}

// The attempt tried its release for these tracks, so each searches for
// itself from now on.
export function releaseAlbumGrabJobs(payload, reason = null, reasons = new Map()) {
  giveBack(payload, heldAlbumGrabJobs(payload).filter((job) => job.id !== payload.jobId), reason, reasons);
}

// The attempt ended before its source judged the release, so these tracks
// can still start another attempt.
export function returnUntriedAlbumGrabJobs(payload, jobs, reason, { retry = false } = {}) {
  for (const job of jobs) downloadTracker.setAlbumGrabAttempted(job.id, false);
  giveBack(payload, jobs, reason, new Map(), { asRetryCycle: retry });
}

export function fallbackAlbumGrabToTracks(payload, reason = null, reasons = new Map()) {
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

export async function finishAlbumGrab(payload, {
  filePaths,
  source,
  album = null,
  resetFields = {},
} = {}) {
  const jobs = albumGrabJobs(payload);
  if (jobs.length === 0) return null;
  recordAlbumGrabQueued(payload, jobs);
  const manifest = await attemptRelease(payload, downloadTracker.getJob(payload.jobId));
  if (!manifest) return fallbackAlbumGrabToTracks(payload, NO_RELEASE_REASON);
  // Only a listing the release judge accepted proves the release. A Usenet
  // title never does, and a candidate queued before candidates said so is
  // judged by its files like one.
  const assigned = await assignDownloadedAlbumFiles({
    jobs, filePaths, source, manifest,
    verified: getPayloadCandidate(payload)?.releaseVerified === true,
  });
  const reasons = new Map(assigned.rejected.map(({ jobId, reason }) =>
    [jobId, `Album file failed verification: ${reason}`]));
  const playlistRoot = resolveDownloadRoot();
  for (const match of assigned.accepted) {
    const job = downloadTracker.getJob(match.jobId);
    if (!job || !["pending", "downloading"].includes(job.status)) continue;
    const peerPayload = { ...payload, jobId: job.id, playlistId: job.playlistId || job.playlistType,
      playlistGeneration: job.playlistGeneration, destination: downloadDestinationForJob(job) };
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
          downloadTracker, job, committedFinalPath, album: album || job.albumName,
          quality: match.validation.quality,
        });
      });
      if (committed.cancelled) continue;
      if (job.status === "done") recordAlbumTrackState(job, source === "soulseek" ? "slskd" : source);
    } catch (error) {
      reasons.set(job.id, "Album file import failed");
      logger.warn(source, "Album file import failed", {
        jobId: job.id, reason: safeLogDiagnostic(error),
      });
    }
  }
  if (assigned.accepted.length === 0 || (filePaths || []).length > assigned.unreadableCount) {
    blockAlbumGrabSource(payload, albumGrabJobs(payload));
  }
  const next = continueAlbumGrab(payload, resetFields) || await nextAlbumSource(payload);
  if (next) return next;
  const leader = downloadTracker.getJob(payload.jobId);
  if (leader?.status === "done") {
    releaseAlbumGrabJobs(payload, NOT_IN_ALBUM_REASON, reasons);
    return null;
  }
  return fallbackAlbumGrabToTracks(payload, NOT_IN_ALBUM_REASON, reasons);
}
