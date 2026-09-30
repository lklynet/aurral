import createHonkerWorker from "./honkerWorkerFactory.js";
import { getPipelineQueue } from "./honkerDb.js";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
  ALBUM_GRAB_ENDED_REASON,
} from "./slskdOrchestrator.js";
import { releaseAlbumGrabJobs } from "./albumGrab.js";
import { isPipelinePayloadActive } from "./weeklyFlow/weeklyFlowDownloadCancellation.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { recordAlbumGrabQueued, recordAlbumGrabPhase } from "./albumGrabActivity.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { withDownloadPayloadMutation } from "./weeklyFlow/weeklyFlowMutationGuards.js";

async function processLockedOrchestratorJob(payload, dependencies = {}) {
  const processPayload = dependencies.processPipelinePayload || processPipelinePayload;
  const continuePayload = dependencies.continuePipeline || continuePipeline;
  const failPayload = dependencies.failPipelineJob || failPipelineJob;
  try {
    if (payload?.albumGrab === true && isPipelinePayloadActive(payload)) {
      recordAlbumGrabQueued(payload, downloadTracker.getAll());
      recordAlbumGrabPhase(payload);
    }
    const nextPayload = await processPayload(payload);
    if (nextPayload?.albumGrab === true) recordAlbumGrabPhase(nextPayload);
    if (payload?.albumGrab === true
      && !(nextPayload?.albumGrab === true && isPipelinePayloadActive(nextPayload))) {
      releaseAlbumGrabJobs(payload, ALBUM_GRAB_ENDED_REASON);
    }
    await continuePayload(nextPayload);
  } catch (error) {
    if (payload?.manualSelection !== true) throw error;
    const message = safeLogDiagnostic(error) || "Manual download failed";
    logger.error("manual-search", "Selected manual download failed", {
      jobId: payload?.jobId || null,
      source: payload?.source || null,
      reason: message,
    });
    await failPayload(payload, message);
  }
}

export function processOrchestratorJob(payload, dependencies = {}) {
  return withDownloadPayloadMutation(payload, (current) => processLockedOrchestratorJob(current, dependencies));
}

const {
  start: startSlskdOrchestratorWorker,
  stop: stopSlskdOrchestratorWorker,
  isRunning: isSlskdOrchestratorRunning,
} = createHonkerWorker({
  name: "slskd-pipeline",
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  shouldRestart: () => isAnyDownloadSourceConfigured(),
  onStart() {
    if (!isAnyDownloadSourceConfigured()) return false;
    console.log("[pipeline] worker starting");
    enqueuePendingJobsWithoutBatch();
    return true;
  },
  processJob: processOrchestratorJob,
  onFinalFailure(job, error) {
    const message = error?.message || String(error);
    console.error("[slskdOrchestratorWorker] pipeline job failed:", {
      jobId: job.payload?.jobId || null,
      phase: job.payload?.phase || null,
      candidateIndex: job.payload?.candidateIndex ?? null,
      message,
      stack: error?.stack || null,
    });
    return withDownloadPayloadMutation(job.payload, (payload) => failPipelineJob(payload, message));
  },
});

export {
  startSlskdOrchestratorWorker,
  stopSlskdOrchestratorWorker,
  isSlskdOrchestratorRunning,
};
