import path from "node:path";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { assignDownloadedAlbumFiles } from "./albumReleaseAssignment.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import {
  buildResolvedPlaylistTrack,
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
  writeAudioMetadata,
} from "./playlistDownloadUtils.js";
import { finalizePipelineJobSuccess } from "./pipelineHelpers.js";
import { isPipelinePayloadActive, withPipelineCommitLock } from "./weeklyFlow/weeklyFlowDownloadCancellation.js";

export function albumGrabJobs(payload) {
  const leader = downloadTracker.getJob(payload.jobId);
  if (!leader?.requestGroupId || payload.albumGrab !== true) return [];
  return (payload.albumGroupJobIds || []).map((id) => downloadTracker.getJob(id)).filter((job) =>
    job && job.requestGroupId === leader.requestGroupId && job.albumMbid === leader.albumMbid
    && ["pending", "downloading"].includes(job.status));
}

export function releaseAlbumGrabJobs(payload, reason = null) {
  let released = false;
  for (const job of albumGrabJobs(payload)) {
    if (job.id !== payload.jobId) released = downloadTracker.setPending(job.id, reason) || released;
  }
  if (released) {
    void import("./weeklyFlow/weeklyFlowWorker.js")
      .then(({ weeklyFlowWorker }) => weeklyFlowWorker.wake(0))
      .catch(() => {});
  }
}

export function fallbackAlbumGrabToTracks(payload, reason = null) {
  releaseAlbumGrabJobs(payload, reason);
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
  const assigned = await assignDownloadedAlbumFiles({ jobs, filePaths, source });
  const playlistRoot = resolvePlaylistRoot();
  for (const match of assigned.accepted) {
    const job = downloadTracker.getJob(match.jobId);
    if (!job || !["pending", "downloading"].includes(job.status)) continue;
    const peerPayload = { ...payload, jobId: job.id, playlistGeneration: job.playlistGeneration };
    if (!isPipelinePayloadActive(peerPayload)) continue;
    try {
      const ext = path.extname(match.filePath).toLowerCase() || ".flac";
      const destination = joinUnderRoot(playlistRoot, payload.destination);
      const finalPath = path.join(destination, `${sanitizePathPart(job.trackName, "Unknown Track")}${ext}`);
      const committed = await withPipelineCommitLock(peerPayload, async () => {
        await writeAudioMetadata(match.filePath, buildResolvedPlaylistTrack(job));
        const committedFinalPath = await commitImportToPlaylistLibrary(match.filePath, finalPath);
        return finalizePipelineJobSuccess({
          downloadTracker, job, committedFinalPath, album: album || job.albumName,
          quality: match.validation.quality,
        });
      });
      if (committed.cancelled) continue;
    } catch (error) {
      logger.warn(source, "Album file import failed", {
        jobId: job.id, reason: safeLogDiagnostic(error),
      });
    }
  }
  releaseAlbumGrabJobs(payload, "No verified file in the album grab");
  const leader = downloadTracker.getJob(payload.jobId);
  return leader?.status === "done" ? null
    : fallbackAlbumGrabToTracks(payload, "No verified file in the album grab");
}
