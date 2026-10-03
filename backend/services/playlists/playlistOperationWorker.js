import createHonkerWorker from "../honkerWorkerFactory.js";
import { getPlaylistOperationQueue } from "../honkerDb.js";
import { processPlaylistOperation } from "./playlistOperations.js";
import { setPlaylistOperationWorkerState } from "./playlistOperationQueue.js";
import { logger } from "../logger.js";
import { getBulkOperation, saveBulkOperation } from "./bulkOperationStore.js";

const PERMANENT_ERROR_CODES = new Set([
  "STATIC_PLAYLIST_NAME_CONFLICT",
  "FLOW_NAME_CONFLICT",
  "NO_DOWNLOAD_SOURCE",
]);

let currentLabel = null;

const isPlaylistImport = (payload) =>
  payload?.kind === "shared-playlist-create" &&
  payload?.importSource != null;

const importContext = (payload, job) => ({
  provider: payload?.importSource?.provider || null,
  playlistName: payload?.name || null,
  playlistId: payload?.playlistId || null,
  operationId: job?.id || null,
});

function syncWorkerState() {
  setPlaylistOperationWorkerState({
    currentLabel,
  });
}

const worker = createHonkerWorker({
  name: "weekly-flow-operation",
  getQueue: getPlaylistOperationQueue,
  async processJob(payload, job) {
    if (payload.kind !== "shared-playlist-bulk") return processPlaylistOperation(payload);
    const record = getBulkOperation(job.id);
    if (!record || ["completed", "failed"].includes(record.state)) return;
    saveBulkOperation({ ...record, state: "running", updatedAt: Date.now() });
    await processPlaylistOperation({ ...payload, operationId: job.id });
    const applied = getBulkOperation(job.id);
    saveBulkOperation({ ...applied, state: "completed", updatedAt: Date.now() });
  },
  idlePollS: 5,
  retryDelayS: 60,
  shouldLogFailure: (job) => !isPlaylistImport(job.payload),
  onJobDequeue(payload, job) {
    currentLabel = payload?.label || payload?.kind || null;
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
    if (job.payload.kind === "shared-playlist-bulk") {
      const record = getBulkOperation(job.id);
      if (record && record.state !== "completed") {
        saveBulkOperation({ ...record, state: "queued", message: error.message, updatedAt: Date.now() });
      }
    }
  },
  onFinalFailure(job, error) {
    if (job.payload.kind !== "shared-playlist-bulk") return;
    const record = getBulkOperation(job.id);
    if (record && record.state !== "completed") {
      saveBulkOperation({ ...record, state: "failed", message: error.message, updatedAt: Date.now() });
    }
  },
  resolveRetry(error, job) {
    const message = error?.message || String(error);
    const permanent = PERMANENT_ERROR_CODES.has(String(error?.code || ""));
    if (isPlaylistImport(job.payload)) {
      logger[permanent || job.attempts >= 3 ? "error" : "warn"](
        "playlist-import",
        permanent || job.attempts >= 3
          ? "Playlist import failed"
          : "Playlist import attempt failed; retrying",
        {
          ...importContext(job.payload, job),
          attempt: job.attempts,
          reason: message,
        },
      );
    }
    if (permanent || job.attempts >= 3) {
      return { action: "fail", message };
    }
    return { action: "retry", delayS: 60, message };
  },
});

export const {
  start: startPlaylistOperationWorker,
  stop: stopPlaylistOperationWorker,
  isRunning: isPlaylistOperationWorkerRunning,
} = worker;

export function getPlaylistOperationWorkerStatus() {
  return {
    running: worker.isRunning(),
    currentLabel,
  };
}
