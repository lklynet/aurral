import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { enqueuePlaylistOperationJob, getHonkerQueueDepth } from "../honkerDb.ts";
import type { HonkerEnqueueOptions, HonkerPayload } from "../honkerDb.ts";
import type { JsonValue } from "@russellthehippo/honker-node";
import { shouldStartQueueHere } from "../backgroundWorkerQueues.ts";
import { cleanupBulkOperations, enqueueBulkOperation } from "./bulkOperationStore.ts";
import type { BulkOperationInput } from "./bulkOperationStore.ts";

let workerCurrentLabel: string | null = null;

async function enqueuePayload(payload: HonkerPayload = {}, options: HonkerEnqueueOptions = {}) {
  const jobId = enqueuePlaylistOperationJob(payload, options);
  return { queued: true, operationId: jobId };
}

async function enqueueBulkPayload(record: BulkOperationInput) {
  cleanupBulkOperations();
  const result = enqueueBulkOperation(record);
  try {
    if (shouldStartQueueHere("weekly-flow-operation") && process.env.NODE_ENV !== "test") {
      const { startPlaylistOperationWorker } = await import("./playlistOperationWorker.ts");
      void startPlaylistOperationWorker();
    } else if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected) {
      process.send!({ type: "queue-wake", queue: "weekly-flow-operation" });
    }
  } catch (error) {
    logger.warn("playlists", "Accepted playlist operation could not wake its worker", {
      operationId: result.operationId,
      reason: asAppError(error)?.message,
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

export function setPlaylistOperationWorkerState({
  currentLabel = null,
}: { currentLabel?: JsonValue } = {}) {
  workerCurrentLabel = currentLabel == null ? null : String(currentLabel).trim() || null;
}

export const playlistOperationQueue = {
  enqueuePayload,
  enqueueBulkPayload,
  getStatus,
};
