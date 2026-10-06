import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./downloadTracker.js";
import { startWorkerIfPending } from "./downloadWorker.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import {
  getActiveDownloadAttemptId,
  withPipelineCommitLock,
} from "./downloadCancellation.js";
import { buildAurralTrackDestination, resolveDownloadRoot } from "../downloadPaths.js";
import {
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  sanitizePathPart,
} from "../downloadUtils.js";
import {
  recordPipelineJobSuccess,
  refreshCompletedPipelinePlaylist,
} from "../pipelineHelpers.js";
import { classifyQualityJob } from "../qualityProfileService.js";
import { withDownloadStepLock } from "./mutationGuards.js";
import { discardReviewFile } from "./reviewFiles.js";
import { logger } from "../logger.js";

const approvalFollowUps = new Set();

async function removeReviewedDownload(job) {
  if (job.downloadSource !== "usenet") return;
  const { removeReviewedUsenetDownload } = await import("../usenetOrchestrator.js");
  await removeReviewedUsenetDownload(job);
}

export const hasApprovalFollowUps = () => approvalFollowUps.size > 0;

const getBlockedJob = (jobId) => {
  const job = downloadTracker.getJob(jobId);
  return job?.status === "blocked" ? job : null;
};

const logFollowUpFailure = (job, ownerId, error) => {
  logger.warn("downloads", "Approved track was imported but playlist follow-up failed", {
    jobId: job.id,
    ownerId,
    reason: error?.message || String(error),
  });
};

const publishApprovedImport = (job, ownerId) => {
  const followUp = withDownloadStepLock(ownerId, () => refreshCompletedPipelinePlaylist(job))
    .catch((error) => logFollowUpFailure(job, ownerId, error))
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
  const ownerId = job.ownerId;
  const destination = buildAurralTrackDestination(ownerId, artistDir, albumDir, {
    ephemeral: Boolean(flowPlaylistConfig.getFlow(ownerId)),
  });
  const finalDir = joinUnderRoot(resolveDownloadRoot(), destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const committed = await withPipelineCommitLock(
    {
      jobId: job.id,
      ownerId,
      ownerGeneration: job.ownerGeneration,
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
  await removeReviewedDownload(job);
  try {
    await classifyQualityJob(downloadTracker.getJob(job.id));
  } catch (error) {
    logFollowUpFailure(job, ownerId, error);
  }
  if (recorded) publishApprovedImport(job, ownerId);
  return { status: 200, path: committedPath };
}

export async function denyBlockedJob(jobId) {
  const job = getBlockedJob(jobId);
  if (!job) return { status: 404, error: "Blocked job not found" };
  await discardReviewFile(job);
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
  await startWorkerIfPending();
  return { status: 200 };
}
