import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import {
  getActiveDownloadAttemptId,
  withPipelineCommitLock,
} from "./weeklyFlowDownloadCancellation.js";
import { buildAurralTrackDestination, resolvePlaylistRoot } from "../playlistPaths.js";
import {
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
} from "../playlistDownloadUtils.js";
import {
  recordPipelineJobSuccess,
  refreshCompletedPipelinePlaylist,
} from "../pipelineHelpers.js";
import { classifyQualityJob } from "../qualityProfileService.js";
import { logger } from "../logger.js";

const approvalFollowUps = new Set();

export const hasApprovalFollowUps = () => approvalFollowUps.size > 0;

const getBlockedJob = (jobId) => {
  const job = downloadTracker.getJob(jobId);
  return job?.status === "blocked" ? job : null;
};

const logFollowUpFailure = (job, playlistId, error) => {
  logger.warn("weekly-flow", "Approved track was imported but playlist follow-up failed", {
    jobId: job.id,
    playlistId,
    reason: error?.message || String(error),
  });
};

const publishApprovedImport = (job, playlistId) => {
  const followUp = refreshCompletedPipelinePlaylist(job)
    .catch((error) => logFollowUpFailure(job, playlistId, error))
    .finally(() => approvalFollowUps.delete(followUp));
  approvalFollowUps.add(followUp);
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
  const finalDir = joinUnderRoot(resolvePlaylistRoot(), destination);
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
      const committedPath = await commitImportToPlaylistLibrary(
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
    await classifyQualityJob(downloadTracker.getJob(job.id));
  } catch (error) {
    logFollowUpFailure(job, playlistId, error);
  }
  if (recorded) publishApprovedImport(job, playlistId);
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
  weeklyFlowWorker.wake();
  return { status: 200 };
}
