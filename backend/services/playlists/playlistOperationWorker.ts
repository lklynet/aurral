import { createJobWorker, type TypedJob } from "../jobs/worker.ts";
import { flowRunQueue, playlistOperationQueue } from "../jobs/queues.ts";
import { playlistOperationSchema, processPlaylistOperation } from "./playlistOperations.ts";
import { setPlaylistOperationWorkerState } from "./playlistOperationQueue.ts";
import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { getBulkOperation, saveBulkOperation } from "./bulkOperationStore.ts";

type PlaylistOperation = Record<string, unknown>;

let currentLabel: string | null = null;
let flowRunLabel: string | null = null;

const isPlaylistImport = (payload: PlaylistOperation) =>
  payload.kind === "static-playlist-create" && payload.importSource != null;

const importProvider = ({ importSource }: PlaylistOperation) =>
  typeof importSource === "object" && importSource !== null && "provider" in importSource
    ? importSource.provider || null
    : null;

const importContext = (payload: PlaylistOperation, job: Pick<TypedJob<unknown>, "id">) => ({
  provider: importProvider(payload),
  playlistName: payload.name || null,
  playlistId: payload.playlistId || null,
  operationId: job.id,
});

const labelOf = (payload: { label?: unknown; kind: string }) =>
  typeof payload.label === "string" && payload.label ? payload.label : payload.kind;

function syncWorkerState() {
  setPlaylistOperationWorkerState({
    currentLabel: flowRunLabel ?? currentLabel,
  });
}

function retryDecision(error: unknown, job: Pick<TypedJob<unknown>, "attempts">) {
  const message = asAppError(error)?.message || String(error);
  if (job.attempts >= 3) {
    return { action: "fail" as const, message };
  }
  return { action: "retry" as const, delayMs: 60_000, message };
}

const worker = createJobWorker(playlistOperationQueue, {
  schema: playlistOperationSchema,
  async processJob(payload, job) {
    if (payload.kind !== "static-playlist-bulk") return processPlaylistOperation(payload);
    const record = getBulkOperation(job.id);
    if (!record || ["completed", "failed"].includes(record.state)) return;
    saveBulkOperation({ ...record, state: "running", updatedAt: Date.now() });
    await processPlaylistOperation({ ...payload, operationId: job.id });
    const applied = getBulkOperation(job.id);
    if (applied) saveBulkOperation({ ...applied, state: "completed", updatedAt: Date.now() });
  },
  shouldLogFailure: (job) => !isPlaylistImport(job.payload),
  onJobDequeue(payload, job) {
    currentLabel = labelOf(payload);
    syncWorkerState();
    if (isPlaylistImport(payload)) {
      logger.info("playlist-import", "Playlist import job started", {
        ...importContext(payload, job),
        attempt: job.attempts,
      });
    }
  },
  onJobSuccess(payload, job) {
    currentLabel = null;
    syncWorkerState();
    if (isPlaylistImport(payload)) {
      logger.info("playlist-import", "Playlist import job completed", {
        ...importContext(payload, job),
        trackCount: Array.isArray(payload.tracks) ? payload.tracks.length : 0,
      });
    }
  },
  onJobError(error, job) {
    currentLabel = null;
    syncWorkerState();
    if (job.payload.kind === "static-playlist-bulk") {
      const record = getBulkOperation(job.id);
      if (record && record.state !== "completed") {
        saveBulkOperation({
          ...record,
          state: "queued",
          message: asAppError(error)?.message,
          updatedAt: Date.now(),
        });
      }
    }
  },
  onFinalFailure(job, error) {
    if (job.payload.kind !== "static-playlist-bulk") return;
    const record = getBulkOperation(job.id);
    if (record && record.state !== "completed") {
      saveBulkOperation({
        ...record,
        state: "failed",
        message: asAppError(error)?.message,
        updatedAt: Date.now(),
      });
    }
  },
  resolveRetry(error, job) {
    const decision = retryDecision(error, job);
    if (isPlaylistImport(job.payload)) {
      const failed = decision.action === "fail";
      logger[failed ? "error" : "warn"](
        "playlist-import",
        failed ? "Playlist import failed" : "Playlist import attempt failed; retrying",
        {
          ...importContext(job.payload, job),
          attempt: job.attempts,
          reason: decision.message,
        },
      );
    }
    return decision;
  },
});

const flowRunWorker = createJobWorker(flowRunQueue, {
  schema: playlistOperationSchema,
  processJob: processPlaylistOperation,
  onJobDequeue(payload) {
    flowRunLabel = labelOf(payload);
    syncWorkerState();
  },
  onJobSuccess() {
    flowRunLabel = null;
    syncWorkerState();
  },
  onJobError() {
    flowRunLabel = null;
    syncWorkerState();
  },
  resolveRetry: retryDecision,
});

export const { start: startFlowRunWorker, stop: stopFlowRunWorker } = flowRunWorker;

export const { start: startPlaylistOperationWorker, stop: stopPlaylistOperationWorker } = worker;

export function getPlaylistOperationWorkerStatus() {
  return {
    running: worker.isRunning() || flowRunWorker.isRunning(),
    currentLabel: flowRunLabel ?? currentLabel,
  };
}
