import createHonkerWorker from "../honkerWorkerFactory.js";
import { getWeeklyFlowOperationQueue } from "../honkerDb.js";
import { processWeeklyFlowOperation } from "./weeklyFlowOperations.js";
import { setWeeklyFlowOperationWorkerState } from "./weeklyFlowOperationQueue.js";
import { logger } from "../logger.js";

const PERMANENT_ERROR_CODES = new Set([
  "SHARED_PLAYLIST_NAME_CONFLICT",
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
  setWeeklyFlowOperationWorkerState({
    currentLabel,
  });
}

const worker = createHonkerWorker({
  name: "weekly-flow-operation",
  getQueue: getWeeklyFlowOperationQueue,
  processJob: processWeeklyFlowOperation,
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
  onJobError() {
    currentLabel = null;
    syncWorkerState();
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
  start: startWeeklyFlowOperationWorker,
  stop: stopWeeklyFlowOperationWorker,
  isRunning: isWeeklyFlowOperationWorkerRunning,
} = worker;

export function getWeeklyFlowOperationWorkerStatus() {
  return {
    running: worker.isRunning(),
    currentLabel,
  };
}
