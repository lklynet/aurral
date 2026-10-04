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
  sanitizePathPart,
  writeAudioMetadata,
} from "./downloadUtils.js";
import { finalizePipelineJobSuccess } from "./pipelineHelpers.js";
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
    history: null,
  };
}

export async function finishAlbumGrab(payload, { filePaths, source, album = null } = {}) {
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
      const finalPath = path.join(destination, `${sanitizePathPart(job.trackName, "Unknown Track")}${ext}`);
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
  const leader = downloadTracker.getJob(payload.jobId);
  if (leader?.status === "done") {
    releaseAlbumGrabJobs(payload, NOT_IN_ALBUM_REASON, reasons);
    return null;
  }
  return fallbackAlbumGrabToTracks(payload, NOT_IN_ALBUM_REASON, reasons);
}
