import fs from "fs/promises";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger } from "./logger.js";
import { enqueuePipelineJob, listHonkerJobs } from "./honkerDb.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { processSlskdPipelinePayload, SLSKD_NOT_CONFIGURED_MESSAGE } from "./slskdOrchestrator.js";
import { processUsenetPipelinePayload } from "./usenetOrchestrator.js";
import { processYtdlpPipelinePayload } from "./ytdlpOrchestrator.js";
import { processDeemixPipelinePayload } from "./deemixOrchestrator.js";
import { fallbackAlbumGrabToTracks, releaseAlbumGrabJobs } from "./albumGrab.js";
import {
  getDownloadSourceNotConfiguredMessage,
  getEnabledDownloadSources,
  ALBUM_GRAB_SOURCE_IDS,
  getSourceLabel,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.js";
import { blockPipelineJobForReview, SEARCH_RESET } from "./pipelineHelpers.js";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.js";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.js";
import { discardReviewFile } from "./downloadJobs/reviewFiles.js";

// Runs one step of a download job: it picks the next enabled source in
// priority order and hands the step to that source's adapter. Every source
// shares the Honker queue still named slskd-pipeline.
const slskdClient = getDownloadClient("slskd");

export function enqueuePendingJobsWithoutBatch() {
  if (!isAnyDownloadSourceConfigured()) return 0;
  const activePipelineJobIds = new Set(
    listHonkerJobs("slskd-pipeline")
      .map((entry) => String(entry.payload?.jobId || "").trim())
      .filter(Boolean),
  );
  let count = 0;
  for (const job of downloadTracker.getByStatus("pending")) {
    const hasProviderSearch = job.slskdBatchId || job.slskdSearchId;
    if (!hasProviderSearch && job.manualReplacementSearch !== true) continue;
    if (activePipelineJobIds.has(job.id)) continue;
    downloadTracker.clearSlskdPipelineState(job.id);
    if (downloadTracker.enqueueDownloadPipeline(job.id)) count += 1;
  }
  return count;
}

async function failJob(job, message) {
  if (job.upgradeForJobId) {
    const { finalizeQualityUpgradeFailure } = await import("./qualityProfileService.js");
    await finalizeQualityUpgradeFailure(job, message);
    return;
  }
  downloadTracker.setFailed(job.id, message);
  try {
    const { recordTrackJobFailed } = await import("./aurralHistoryService.js");
    recordTrackJobFailed(job, message);
  } catch {}
  try {
    const { downloadWorker } = await import("./downloadJobs/downloadWorker.js");
    downloadWorker.wake(0);
    await downloadWorker.checkPlaylistComplete(job.playlistId || job.playlistType);
  } catch (error) {
    logger.warn("downloads", "Failed to run post-failure playlist checks", {
      jobId: job.id,
      error: error?.message || String(error),
    });
  }
}

// A held file goes to review only when no source verifies a file. It is
// removed when another file is imported or the job ends another way.
async function parkHeldForReview(payload, job) {
  const held = payload?.heldForReview;
  if (!job || !held?.sourcePath) return false;
  if (!(await fs.stat(held.sourcePath).catch(() => null))?.isFile()) return false;
  downloadTracker.updateDownloadMetadata(job.id, held.metadata || {});
  return blockPipelineJobForReview({
    downloadTracker,
    job,
    validation: { blocked: true, reason: held.reason },
    sourcePath: held.sourcePath,
  });
}

async function discardHeldForReview(payload) {
  const held = payload?.heldForReview;
  if (!held?.sourcePath) return;
  if (downloadTracker.getJob(payload.jobId)?.stagingPath === held.sourcePath) return;
  await discardReviewFile({
    id: payload.jobId,
    stagingPath: held.sourcePath,
    downloadSource: held.source,
    downloadClientId: held.transferId,
    remoteUsername: held.username,
  });
}

function isSourceConfigured(sourceId) {
  return getEnabledDownloadSources().some((source) => source.id === sourceId);
}

export function buildNextSourcePayload(payload, failedSource = null, reason = null) {
  if (payload?.manualSelection === true) return null;
  const allowedSources = Array.isArray(payload?.allowedSources)
    ? new Set(payload.allowedSources)
    : null;
  const sources = getEnabledDownloadSources().filter(
    (source) => (!allowedSources || allowedSources.has(source.id))
      && (payload?.albumGrab !== true || ALBUM_GRAB_SOURCE_IDS.includes(source.id)),
  );
  if (sources.length === 0) return null;
  const tried = new Set(Array.isArray(payload?.triedSources) ? payload.triedSources : []);
  const sourceErrors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  if (failedSource) {
    tried.add(failedSource);
    if (reason) {
      sourceErrors.push({
        source: failedSource,
        message: String(reason || "").trim(),
      });
    }
  }
  const next = sources.find((source) => !tried.has(source.id));
  if (!next) return null;
  return {
    ...payload,
    source: next.id,
    ...SEARCH_RESET,
    phase: "search",
    searchId: null,
    searchIds: [],
    candidates: [],
    candidate: null,
    candidateIndex: 0,
    candidateRetryCounts: {},
    pollAttempts: 0,
    batchId: null,
    legacyTransfer: null,
    nzbId: null,
    history: null,
    downloadedPath: null,
    triedSources: [...tried],
    sourceErrors,
  };
}

function summarizeSourceErrors(payload, message) {
  const errors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  const source = String(payload?.source || "").trim();
  if (source && message) {
    errors.push({ source, message: String(message || "").trim() });
  }
  const summary = errors
    .map((entry) => {
      const label = getSourceLabel(entry.source);
      const entryMessage = String(entry.message || "").trim();
      return entryMessage ? `${label}: ${entryMessage}` : label;
    })
    .filter(Boolean)
    .join("; ");
  return summary || message;
}

async function failOrTryNextSource(payload, job, message, logDetails = {}) {
  const nextPayload = buildNextSourcePayload(payload, payload?.source || "slskd", message);
  if (nextPayload) {
    logger.info("downloads", "Trying next download source", {
      jobId: job?.id,
      failedSource: payload?.source || "slskd",
      nextSource: nextPayload.source,
      reason: message,
      ...logDetails,
    });
    downloadTracker.clearSlskdDispatched(job.id);
    return nextPayload;
  }
  if (payload?.albumGrab === true) {
    return fallbackAlbumGrabToTracks(payload, summarizeSourceErrors(payload, message));
  }
  if (await parkHeldForReview(payload, job)) return null;
  await failJob(job, summarizeSourceErrors(payload, message));
  return null;
}

export async function failPipelineJob(payload, message) {
  const jobId = payload?.jobId;
  if (!jobId) return;
  if (payload.albumGrab === true) releaseAlbumGrabJobs(payload, ALBUM_GRAB_ENDED_REASON);
  const job = isPipelinePayloadActive(payload) ? downloadTracker.getJob(jobId) : null;
  if ((job?.status === "downloading" || job?.status === "pending")
    && !(await parkHeldForReview(payload, job))) {
    await failJob(job, message);
  }
  await discardHeldForReview(payload);
}

export const ALBUM_GRAB_ENDED_REASON = "The album download ended before this track was imported";

export async function processPipelinePayload(payload) {
  if (!payload || !payload.phase || !payload.jobId) {
    throw new Error("Invalid pipeline payload");
  }
  const nextPayload = await processSourcePayload(payload);
  if (nextPayload == null) await discardHeldForReview(payload);
  return nextPayload;
}

async function processSourcePayload(payload) {
  if (!isPipelinePayloadActive(payload)) return null;
  const currentJob = downloadTracker.getJob(payload.jobId);
  const inactiveOwner = deferForInactiveOwner(payload, currentJob);
  if (inactiveOwner) return inactiveOwner;
  if (!isAnyDownloadSourceConfigured()) {
    const job = downloadTracker.getJob(payload.jobId);
    if (job) {
      await failJob(job, getDownloadSourceNotConfiguredMessage());
    }
    return null;
  }
  if (!payload.source) {
    const nextPayload = buildNextSourcePayload(payload, null, null);
    if (!nextPayload) {
      const job = downloadTracker.getJob(payload.jobId);
      if (job) await failJob(job, getDownloadSourceNotConfiguredMessage());
      return null;
    }
    return processSourcePayload(nextPayload);
  }
  if (payload.source === "usenet") {
    if (!isSourceConfigured("usenet")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "Usenet is not configured") : null;
    }
    return processUsenetPipelinePayload(payload, { failOrTryNextSource });
  }
  if (payload.source === "deemix") {
    if (!isSourceConfigured("deemix")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "deemix is not configured") : null;
    }
    return processDeemixPipelinePayload(payload, { failOrTryNextSource });
  }
  if (payload.source === "ytdlp") {
    if (!isSourceConfigured("ytdlp")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "yt-dlp is not configured") : null;
    }
    return processYtdlpPipelinePayload(payload, { failOrTryNextSource });
  }
  if (payload.source !== "slskd") {
    const job = downloadTracker.getJob(payload.jobId);
    return job
      ? failOrTryNextSource(payload, job, `Unknown download source: ${payload.source}`)
      : null;
  }
  if (!slskdClient.isConfigured() || !isSourceConfigured("slskd")) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? failOrTryNextSource(payload, job, SLSKD_NOT_CONFIGURED_MESSAGE) : null;
  }
  return processSlskdPipelinePayload(payload, { failOrTryNextSource });
}

export async function continuePipeline(payload) {
  if (!payload) return;
  if (!isPipelinePayloadActive(payload)) return;
  if (payload.delaySeconds) {
    enqueuePipelineJob(payload, {
      delaySeconds: Number(payload.delaySeconds),
    });
    return;
  }
  enqueuePipelineJob(payload, {});
}
