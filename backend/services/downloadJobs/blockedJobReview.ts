import path from "path";
import fs from "fs/promises";
import { downloadTracker, type DownloadJob } from "./downloadTracker.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { getActiveDownloadAttemptId, withPipelineCommitLock } from "./downloadCancellation.ts";
import { buildTrackDestination, resolveDownloadRoot } from "../downloadPaths.ts";
import {
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  sanitizePathPart,
} from "../downloadUtils.ts";
import { recordPipelineJobSuccess, refreshCompletedPipelinePlaylist } from "../pipelineHelpers.ts";
import { classifyQualityJob } from "../qualityProfileService.ts";
import { withDownloadStepLock } from "./downloadLocks.ts";
import { discardReviewFile } from "./reviewFiles.ts";
import { logger } from "../logger.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { asAppError } from "../../../lib/errors.ts";
import { isNzbSource } from "../usenetClientCommon.ts";
import { shouldPreserveReviewedUsenetSource } from "../usenetOrchestrator.ts";
import { recordTrackJobFailed } from "../aurralHistoryService.ts";

const approvalFollowUps = new Set<Promise<void>>();

export const hasApprovalFollowUps = () => approvalFollowUps.size > 0;

const getBlockedJob = (jobId: string) => {
  const job = downloadTracker.getJob(jobId);
  return job?.status === "blocked" ? job : null;
};

const logFollowUpFailure = (job: DownloadJob, playlistId: string, error: unknown) => {
  const failure = asAppError(error);
  logger.warn("downloads", "Approved track was imported but playlist follow-up failed", {
    jobId: job.id,
    playlistId,
    reason: failure?.message || String(error),
  });
};

const publishApprovedImport = (job: DownloadJob, playlistId: string) => {
  const followUp = withDownloadStepLock(playlistId, () => refreshCompletedPipelinePlaylist(job))
    .catch((error) => logFollowUpFailure(job, playlistId, error))
    .finally(() => approvalFollowUps.delete(followUp));
  approvalFollowUps.add(followUp);
};

const reviewFileExists = async (job: DownloadJob) =>
  Boolean(job.stagingPath && (await fs.stat(job.stagingPath).catch(() => null))?.isFile());

export async function approveBlockedJob(jobId: string) {
  const job = getBlockedJob(jobId);
  if (!job) return { status: 404, error: "Blocked job not found" };
  const downloadAttemptId = getActiveDownloadAttemptId(job.id);
  if (!(await reviewFileExists(job))) {
    await denyBlockedJob(job.id, { reason: "Review file is gone", fileGone: true });
    return { status: 404, error: "The file to review is gone, so Aurral is searching again" };
  }
  const sourcePath = String(job.stagingPath).trim();
  const ext = path.extname(sourcePath).toLowerCase();
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const playlistId = job.playlistId || job.playlistType;
  const destination = buildTrackDestination(playlistId, artistDir, albumDir, {
    ephemeral: Boolean(flowPlaylistConfig.getFlow(playlistId)),
  });
  const finalDir = joinUnderRoot(resolveDownloadRoot(), destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const committed = await withPipelineCommitLock(
    {
      jobId: job.id,
      playlistId,
      playlistGeneration: job.playlistGeneration,
      downloadAttemptId,
    },
    async () => {
      if (!getBlockedJob(job.id)) return null;
      let preserveSource = false;
      if (isNzbSource(job.downloadSource)) {
        preserveSource = shouldPreserveReviewedUsenetSource(job);
      }
      const committedPath = await commitDownloadedFile(sourcePath, path.join(finalDir, finalName), {
        preserveSource,
      });
      const recorded = await recordPipelineJobSuccess({
        downloadTracker,
        job,
        committedFinalPath: committedPath,
      });
      return { committedPath, recorded };
    },
  );
  if (committed.cancelled) return { status: 409, error: "Download job was removed" };
  if (!committed.result) return { status: 404, error: "Blocked job not found" };
  const { committedPath, recorded } = committed.result;
  await discardReviewFile(job);
  try {
    await classifyQualityJob(downloadTracker.getJob(job.id));
  } catch (error) {
    logFollowUpFailure(job, playlistId, error);
  }
  if (recorded) publishApprovedImport(job, playlistId);
  return { status: 200, path: committedPath };
}

export async function denyBlockedJob(
  jobId: string,
  { reason = "Denied by user", fileGone = false }: { reason?: string; fileGone?: boolean } = {},
) {
  const job = getBlockedJob(jobId);
  if (!job) return { status: 404, error: "Blocked job not found" };
  // Approval imports under this lock. Re-check inside it, so a denial cannot
  // delete the file of an approval in progress or reopen an approved song.
  const committed = await withPipelineCommitLock(
    {
      jobId: job.id,
      playlistId: job.playlistId || job.playlistType,
      playlistGeneration: job.playlistGeneration,
      downloadAttemptId: getActiveDownloadAttemptId(job.id),
    },
    async () => {
      if (!getBlockedJob(job.id)) return false;
      if (!fileGone) {
        await discardReviewFile(job);
        const deniedSourceKey =
          job.downloadSource === "slskd"
            ? `${String(job.remoteUsername || "").trim()}\0${String(job.remoteFilename || "").trim()}`
            : String(job.releaseGuid || "").trim();
        if (job.downloadSource && deniedSourceKey) {
          downloadTracker.recordDeniedSource(job.id, job.downloadSource, deniedSourceKey);
        }
      }
      downloadTracker.setPending(job.id, reason, { asRetryCycle: false });
      return true;
    },
  );
  if (committed.cancelled) return { status: 409, error: "Download job was removed" };
  if (!committed.result) return { status: 404, error: "Blocked job not found" };
  recordTrackJobFailed(job, `${reason} — will retry`);
  return { status: 200 };
}

// A song held for review longer than the configured wait, or whose file is
// gone, is searched again instead of waiting for a decision indefinitely.
export async function retryStaleReviews(now = Date.now()) {
  const hours = dbOps.getSettings().reviewTimeoutHours;
  const cutoff = hours ? now - hours * 60 * 60 * 1000 : null;
  let retried = 0;
  for (const job of downloadTracker.getByStatus("blocked")) {
    const expired = cutoff !== null && job.completedAt != null && job.completedAt <= cutoff;
    const options = !(await reviewFileExists(job))
      ? { reason: "Review file is gone", fileGone: true }
      : expired
        ? { reason: "Review timed out" }
        : null;
    if (!options) continue;
    const outcome = await denyBlockedJob(job.id, options);
    if (outcome.status === 200) retried += 1;
  }
  return retried;
}
