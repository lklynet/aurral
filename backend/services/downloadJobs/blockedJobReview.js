import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./downloadTracker.js";
import { downloadWorker } from "./downloadWorker.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import {
  getActiveDownloadAttemptId,
  withPipelineCommitLock,
} from "./downloadCancellation.js";
import { buildAurralTrackDestination, resolveDownloadRoot } from "../downloadPaths.js";
import {
  commitDownloadedFile,
  joinUnderRoot,
  sanitizePathPart,
} from "../downloadUtils.js";
import {
  recordPipelineJobSuccess,
  refreshCompletedPipelinePlaylist,
} from "../pipelineHelpers.js";
import { classifyQualityJob } from "../qualityProfileService.js";
import { logger } from "../logger.js";

const getBlockedJob = (jobId) => {
  const job = downloadTracker.getJob(jobId);
  return job?.status === "blocked" ? job : null;
};

export async function approveBlockedJob(jobId) {
  const job = getBlockedJob(jobId);
  if (!job) return { status: 404, error: "Blocked job not found" };
  const downloadAttemptId = getActiveDownloadAttemptId(job.id);
  const sourcePath = String(job.stagingPath || "").trim();
  if (!sourcePath) return { status: 400, error: "Staging file path missing" };
  try {
    await fs.access(sourcePath);
  } catch {
    return { status: 404, error: "Staging file no longer exists" };
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const playlistId = job.playlistId || job.playlistType;
  const destination = buildAurralTrackDestination(playlistId, artistDir, albumDir, {
    ephemeral: Boolean(flowPlaylistConfig.getFlow(playlistId)),
  });
  const finalDir = joinUnderRoot(resolveDownloadRoot(), destination);
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".mp3"}`;
  const committed = await withPipelineCommitLock(
    {
      jobId: job.id,
      playlistId,
      playlistGeneration: job.playlistGeneration,
      downloadAttemptId,
    },
    async () => {
      if (!getBlockedJob(job.id)) return null;
      const committedPath = await commitDownloadedFile(
        sourcePath,
        path.join(finalDir, finalName),
      );
      const recorded = await recordPipelineJobSuccess({
        downloadTracker,
        job,
        committedFinalPath: committedPath,
        album: job.albumName,
      });
      return { committedPath, recorded };
    },
  );
  if (committed.cancelled) return { status: 409, error: "Download job was removed" };
  if (!committed.result) return { status: 404, error: "Blocked job not found" };
  const { committedPath, recorded } = committed.result;
  try {
    if (recorded) await refreshCompletedPipelinePlaylist(job);
    await classifyQualityJob(downloadTracker.getJob(job.id));
  } catch (error) {
    logger.warn("weekly-flow", "Approved track was imported but playlist follow-up failed", {
      jobId: job.id,
      playlistId,
      reason: error?.message || String(error),
    });
  }
  return { status: 200, path: committedPath };
}

export async function denyBlockedJob(jobId) {
  const job = getBlockedJob(jobId);
  if (!job) return { status: 404, error: "Blocked job not found" };
  const sourcePath = String(job.stagingPath || "").trim();
  if (sourcePath) {
    await fs.rm(sourcePath, { force: true }).catch(() => {});
  }
  const deniedSourceKey = ["usenet", "ytdlp", "deemix"].includes(job.downloadSource)
    ? String(job.releaseGuid || "").trim()
    : `${String(job.remoteUsername || "").trim()}\0${String(job.remoteFilename || "").trim()}`;
  if (job.downloadSource && deniedSourceKey) {
    downloadTracker.recordDeniedSource(job.id, job.downloadSource, deniedSourceKey);
  }
  downloadTracker.setPending(job.id, "Denied by user", { asRetryCycle: false });
  import("../aurralHistoryService.js")
    .then(({ recordTrackJobFailed }) =>
      recordTrackJobFailed(job, "Denied by user — will retry"),
    )
    .catch(() => {});
  downloadWorker.wake();
  return { status: 200 };
}
