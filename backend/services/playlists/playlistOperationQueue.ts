import { logger } from "../logger.ts";
import { enqueuePlaylistOperationJob, getHonkerQueueDepth } from "../honkerDb.ts";
import { shouldStartQueueHere } from "../backgroundWorkerQueues.ts";
import { cleanupBulkOperations, enqueueBulkOperation } from "./bulkOperationStore.ts";

let workerCurrentLabel = null;

async function enqueuePayload(payload = {}, options = {}) {
  const jobId = enqueuePlaylistOperationJob(payload, options);
  return { queued: true, operationId: jobId };
}

async function enqueueBulkPayload(record) {
  cleanupBulkOperations();
  const result = enqueueBulkOperation(record);
  try {
    if (shouldStartQueueHere("weekly-flow-operation") && process.env.NODE_ENV !== "test") {
      const { startPlaylistOperationWorker } = await import("./playlistOperationWorker.ts");
      void startPlaylistOperationWorker();
    } else if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected) {
      process.send({ type: "queue-wake", queue: "weekly-flow-operation" });
    }
  } catch (error) {
    logger.warn("playlists", "Accepted playlist operation could not wake its worker", {
      operationId: result.operationId,
      reason: error.message,
    });
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

export function setPlaylistOperationWorkerState({ currentLabel = null } = {}) {
  workerCurrentLabel = currentLabel == null ? null : String(currentLabel).trim() || null;
}

export const playlistOperationQueue = {
  enqueuePayload,
  enqueueBulkPayload,
  getStatus,
};
