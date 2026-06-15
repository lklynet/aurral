import { getPipelineQueue, getWorkerId } from "./honkerDb.js";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
} from "./slskdOrchestrator.js";
import { slskdClient } from "./slskdClient.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "slskd-pipeline";

let running = false;
let stopRequested = false;
let loopPromise = null;

async function runLoop() {
  if (!slskdClient.isConfigured()) {
    running = false;
    return;
  }
  const queue = getPipelineQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 2 })) {
      if (!running || stopRequested) break;
      try {
        const nextPayload = await withJobHeartbeat(job, queue, () =>
          processPipelinePayload(job.payload),
        );
        await continuePipeline(nextPayload);
        job.ack();
      } catch (error) {
        const message = error?.message || String(error);
        if (job.attempts >= 4) {
          job.fail(message);
          await failPipelineJob(job.payload, message);
        } else {
          job.retry(30, message);
        }
      }
    }
  } catch (error) {
    console.error("[slskdOrchestratorWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startSlskdOrchestratorWorker, {
      intentional,
      shouldRestart: () => slskdClient.isConfigured(),
    });
  }
}

export function startSlskdOrchestratorWorker() {
  if (running || isHonkerShuttingDown()) return;
  if (!slskdClient.isConfigured()) return;
  running = true;
  stopRequested = false;
  enqueuePendingJobsWithoutBatch();
  loopPromise = runLoop();
}

export function stopSlskdOrchestratorWorker() {
  stopRequested = true;
  running = false;
}

export function isSlskdOrchestratorRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startSlskdOrchestratorWorker,
  stop: stopSlskdOrchestratorWorker,
  isRunning: isSlskdOrchestratorRunning,
});
