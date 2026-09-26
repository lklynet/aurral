import createHonkerWorker from "./honkerWorkerFactory.js";
import { getPipelineQueue } from "./honkerDb.js";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
} from "./slskdOrchestrator.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { logger, safeLogDiagnostic } from "./logger.js";

export async function processOrchestratorJob(payload, dependencies = {}) {
  const processPayload = dependencies.processPipelinePayload || processPipelinePayload;
  const continuePayload = dependencies.continuePipeline || continuePipeline;
  const failPayload = dependencies.failPipelineJob || failPipelineJob;
  try {
    const nextPayload = await processPayload(payload);
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
    return failPipelineJob(job.payload, message);
  },
});

export {
  startSlskdOrchestratorWorker,
  stopSlskdOrchestratorWorker,
  isSlskdOrchestratorRunning,
};
