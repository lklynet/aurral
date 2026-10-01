import { logger } from "../logger.js";
import { enqueueWeeklyFlowOperationJob, getHonkerQueueDepth } from "../honkerDb.js";
import { shouldStartQueueHere } from "../backgroundWorkerQueues.js";
import { cleanupBulkOperations, enqueueBulkOperation } from "./weeklyFlowBulkOperationStore.js";

let workerCurrentLabel = null;

async function enqueuePayload(payload = {}, options = {}) {
  const jobId = enqueueWeeklyFlowOperationJob(payload, options);
  return { queued: true, operationId: jobId };
}

async function enqueueBulkPayload(record) {
  cleanupBulkOperations();
  const result = enqueueBulkOperation(record);
  try {
    if (shouldStartQueueHere("weekly-flow-operation") && process.env.NODE_ENV !== "test") {
      const { startWeeklyFlowOperationWorker } = await import("./weeklyFlowOperationWorker.js");
      startWeeklyFlowOperationWorker();
    } else if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected) {
      process.send({ type: "queue-wake", queue: "weekly-flow-operation" });
    }
  } catch (error) {
    logger.warn("playlists", "Accepted playlist operation could not wake its worker", { operationId: result.operationId, reason: error.message });
  }
  return result;
}

function getStatus() {
  let pending = 0;
  try {
    pending = getHonkerQueueDepth("weekly-flow-operation");
  } catch {}
  return {
    processing: Boolean(workerCurrentLabel) || pending > 0,
    pending,
    currentLabel: workerCurrentLabel,
  };
}

export function setWeeklyFlowOperationWorkerState({
  currentLabel = null,
} = {}) {
  workerCurrentLabel =
    currentLabel == null ? null : String(currentLabel).trim() || null;
}

export const weeklyFlowOperationQueue = {
  enqueuePayload,
  enqueueBulkPayload,
  getStatus,
};
