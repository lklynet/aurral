import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import createHonkerWorker from "./honkerWorkerFactory.ts";
import { getPipelineQueue } from "./honkerDb.ts";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
  type PipelinePayload,
} from "./downloadPipeline.ts";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.ts";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { recordAlbumGrabQueued, recordAlbumGrabPhase } from "./albumGrabActivity.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import { hasShareDownloads } from "./shareLinks/downloadStore.ts";
import { withDownloadPayloadMutation } from "./downloadJobs/mutationGuards.ts";

const pipelineStepSchema = v.looseObject({
  jobId: v.string(),
  phase: v.string(),
  downloadAttemptId: v.nullish(v.string()),
  playlistId: v.nullish(v.string()),
  albumGroupJobIds: v.nullish(v.array(v.string())),
});

// Each source writes the rest of its step state and reads it back in its next step.
const pipelinePayloadSchema = v.custom<PipelinePayload>((input) => v.is(pipelineStepSchema, input));

interface PipelineDependencies {
  processPipelinePayload?: typeof processPipelinePayload;
  continuePipeline?: typeof continuePipeline;
  failPipelineJob?: typeof failPipelineJob;
}

async function processLockedPipelineJob(
  payload: PipelinePayload,
  dependencies: PipelineDependencies = {},
) {
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

export function processPipelineJob(
  payload: PipelinePayload,
  dependencies: PipelineDependencies = {},
) {
  return withDownloadPayloadMutation(payload, (current) =>
    processLockedPipelineJob(current, dependencies),
  );
}

const {
  start: startDownloadPipelineWorker,
  stop: stopDownloadPipelineWorker,
  isRunning: isDownloadPipelineWorkerRunning,
} = createHonkerWorker({
  name: "slskd-pipeline",
  schema: pipelinePayloadSchema,
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  shouldRestart: () => isAnyDownloadSourceConfigured() || hasShareDownloads(),
  onStart() {
    if (!isAnyDownloadSourceConfigured() && !hasShareDownloads()) return false;
    console.log("[pipeline] worker starting");
    enqueuePendingJobsWithoutBatch();
    return true;
  },
  processJob: (payload) => processPipelineJob(payload),
  onFinalFailure(job, error) {
    const failure = asAppError(error);
    const message = failure?.message || String(error);
    console.error("[downloadPipelineWorker] pipeline job failed:", {
      jobId: job.payload?.jobId || null,
      phase: job.payload?.phase || null,
      candidateIndex: job.payload?.candidateIndex ?? null,
      message,
      stack: failure?.stack || null,
    });
    const failed: PipelinePayload = job.payload;
    return withDownloadPayloadMutation(failed, async (current) =>
      continuePipeline(await failPipelineJob(current, message)),
    );
  },
});

export { startDownloadPipelineWorker, stopDownloadPipelineWorker, isDownloadPipelineWorkerRunning };
