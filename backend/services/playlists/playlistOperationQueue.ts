import { flowRunQueue, playlistOperationQueue as operationQueue } from "../jobs/queues.ts";
import type * as v from "valibot";
import type { EnqueueOptions } from "../jobs/queue.ts";
import type { playlistOperationSchema } from "./playlistOperations.ts";
import { cleanupBulkOperations, enqueueBulkOperation } from "./bulkOperationStore.ts";
import type { BulkOperationInput } from "./bulkOperationStore.ts";

type PlaylistOperation = v.InferOutput<typeof playlistOperationSchema>;

let workerCurrentLabel: string | null = null;

const FLOW_RUN_KINDS: ReadonlySet<unknown> = new Set([
  "manual-start-flow",
  "scheduled-flow-refresh",
  "enable-flow-refresh",
]);

async function enqueuePayload(
  payload: PlaylistOperation,
  options: EnqueueOptions<PlaylistOperation> = {},
) {
  const queue = FLOW_RUN_KINDS.has(payload.kind) ? flowRunQueue : operationQueue;
  return { queued: true, operationId: queue.enqueue(payload, options) };
}

async function enqueueBulkPayload(record: BulkOperationInput) {
  cleanupBulkOperations();
  return enqueueBulkOperation(record);
}

function getStatus() {
  const pending = operationQueue.readyCount() + flowRunQueue.readyCount();
  return {
    processing: Boolean(workerCurrentLabel) || pending > 0,
    pending,
    currentLabel: workerCurrentLabel,
  };
}

export function setPlaylistOperationWorkerState({
  currentLabel = null,
}: { currentLabel?: string | null } = {}) {
  workerCurrentLabel = currentLabel?.trim() || null;
}

export const playlistOperationQueue = {
  enqueuePayload,
  enqueueBulkPayload,
  getStatus,
};
