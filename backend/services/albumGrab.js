import path from "node:path";
import { recordAlbumGrabQueued, recordAlbumGrabPhase, recordAlbumTrackState } from "./albumGrabActivity.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { assignDownloadedAlbumFiles } from "./albumReleaseAssignment.js";
import { loadAlbumReleases } from "./albumReleases.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import {
  buildResolvedJobTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeAudioMetadata,
} from "./downloadUtils.js";
import {
  buildNextCandidatePayload,
  finalizePipelineJobSuccess,
  getPayloadCandidate,
  hasNextCandidate,
} from "./pipelineHelpers.js";
import { isPipelinePayloadActive, withPipelineCommitLock } from "./downloadJobs/downloadCancellation.js";
import { downloadDestinationForJob } from "./downloadJobs/downloadOwnership.js";

const NOT_IN_ALBUM_REASON = "Track was not in the album download";

export function albumGrabJobs(payload) {
  const leader = downloadTracker.getJob(payload.jobId);
  if (!leader?.requestGroupId || payload.albumGrab !== true) return [];
  return (payload.albumGroupJobIds || []).map((id) => downloadTracker.getJob(id)).filter((job) =>
    job && job.requestGroupId === leader.requestGroupId && job.albumMbid === leader.albumMbid
    && ["pending", "downloading"].includes(job.status));
}

function heldAlbumGrabJobs(payload) {
  return (payload?.albumGroupJobIds || []).filter((id) => id !== payload.jobId)
    .map((id) => downloadTracker.getJob(id))
    .filter((job) => job?.status === "downloading" && !downloadTracker.isSlskdDispatched(job.id));
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
function blockAlbumGrabSource(payload, jobs) {
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

// Tries the next ranked folder or release for the tracks an attempt left
// unfilled. When the leading track was filled, another unfilled track leads.
export function continueAlbumGrab(payload, resetFields = {}) {
  const remaining = albumGrabJobs(payload);
  if (remaining.length < 2 || !hasNextCandidate(payload)) return null;
  const leaderId = remaining.some((job) => job.id === payload.jobId)
    ? payload.jobId
    : remaining[0].id;
  downloadTracker.markSlskdDispatched(leaderId);
  return buildNextCandidatePayload({
    ...payload,
    jobId: leaderId,
    albumGroupJobIds: [leaderId, ...remaining.map((job) => job.id).filter((id) => id !== leaderId)],
  }, resetFields);
}

export function releaseAlbumGrabJobs(payload, reason = null, reasons = new Map()) {
  let released = false;
  for (const job of heldAlbumGrabJobs(payload)) {
    released = downloadTracker.setPending(job.id, reasons.get(job.id) || reason) || released;
  }
  if (released) {
    recordAlbumGrabPhase(payload, reason || "Album attempt ended; searching for missing tracks");
    void import("./downloadJobs/downloadWorker.js")
      .then(({ downloadWorker }) => downloadWorker.wake(0))
      .catch(() => {});
  }
}

export function fallbackAlbumGrabToTracks(payload, reason = null, reasons = new Map()) {
  recordAlbumGrabPhase(payload, reason || "Album attempt ended; searching for missing tracks");
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
    triedSources: [],
    sourceErrors: [],
    queueUuid: null,
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
  const releases = await loadAlbumReleases(jobs[0].albumMbid);
  const assigned = await assignDownloadedAlbumFiles({ jobs, filePaths, source, releases });
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
      const finalPath = path.join(destination, buildTrackFileName(job, ext));
      const committed = await withPipelineCommitLock(peerPayload, async () => {
        await writeAudioMetadata(match.filePath, buildResolvedJobTrack(job));
        const committedFinalPath = await commitDownloadedFile(match.filePath, finalPath);
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
  if ((filePaths || []).length > assigned.unreadableCount) {
    blockAlbumGrabSource(payload, albumGrabJobs(payload));
  }
  const next = continueAlbumGrab(payload, resetFields);
  if (next) return next;
  const leader = downloadTracker.getJob(payload.jobId);
  if (leader?.status === "done") {
    releaseAlbumGrabJobs(payload, NOT_IN_ALBUM_REASON, reasons);
    return null;
  }
  return fallbackAlbumGrabToTracks(payload, NOT_IN_ALBUM_REASON, reasons);
}
