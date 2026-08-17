import { ensurePlaylistFilesystemLayout } from "./playlistFilesystemMigration.js";
import {
  enqueueHonkerStartupTasks,
  getHonkerQueueDepth,
  getHonkerQueueNextClaimAt,
  startHonkerScheduler,
} from "./honkerDb.js";
import { startSystemTaskWorker } from "./systemTaskWorker.js";
import { startLibraryScanWorker } from "./libraryScanWorker.js";
import { startNotificationOutboxWorker } from "./notificationOutboxWorker.js";
import { startPlayEventOutboxWorker } from "./playEventOutboxWorker.js";
import { startSlskdOrchestratorWorker } from "./slskdOrchestratorWorker.js";
import { startDiscoveryRefreshWorker } from "./discoveryRefreshWorker.js";
import { startDiscoveryPlaylistBuildWorker } from "./discoveryPlaylistBuildWorker.js";
import { startDiscoveryUserRefreshWorker } from "./discoveryUserRefreshWorker.js";
import { startWeeklyFlowOperationWorker } from "./weeklyFlow/weeklyFlowOperationWorker.js";
import { startWeeklyFlowPlaylistRetryWorker } from "./weeklyFlow/weeklyFlowPlaylistRetryWorker.js";
import { startWeeklyFlowPlaylistReserveBuildWorker } from "./weeklyFlow/weeklyFlowPlaylistReserveBuildWorker.js";
import { startPlaylistMbidEnrichmentWorker } from "./playlistMbidEnrichmentWorker.js";
import {
  startLibraryFileWatcher,
  stopLibraryFileWatcher,
} from "./libraryFileWatcher.js";
import { registerHonkerShutdownHandler } from "./honkerWorkerRuntime.js";
import { HONKER_QUEUE_NAMES } from "./honkerDb.js";

let backgroundWorkersStarted = false;
let workerSupervisorStarted = false;
let workerSupervisorInterval = null;
let workerSupervisorTimer = null;

const WORKER_SUPERVISOR_POLL_MS = Math.max(
  15000,
  Math.floor(Number(process.env.AURRAL_WORKER_SUPERVISOR_POLL_MS) || 60000),
);

const WORKER_STARTS = {
  "system-task": startSystemTaskWorker,
  "library-scan": startLibraryScanWorker,
  "_outbox:notifications": startNotificationOutboxWorker,
  "_outbox:play-events": startPlayEventOutboxWorker,
  "slskd-pipeline": startSlskdOrchestratorWorker,
  "discovery-refresh": startDiscoveryRefreshWorker,
  "discovery-playlist-build": startDiscoveryPlaylistBuildWorker,
  "discovery-user-refresh": startDiscoveryUserRefreshWorker,
  "weekly-flow-operation": startWeeklyFlowOperationWorker,
  "playlist-retry": startWeeklyFlowPlaylistRetryWorker,
  "playlist-reserve-build": startWeeklyFlowPlaylistReserveBuildWorker,
  "playlist-mbid-enrichment": startPlaylistMbidEnrichmentWorker,
};

const QUEUE_WORKERS = HONKER_QUEUE_NAMES.map((queue) => ({
  queue,
  start: WORKER_STARTS[queue],
})).filter((worker) => typeof worker.start === "function");

function clearSupervisorWakeTimer() {
  if (!workerSupervisorTimer) return;
  clearTimeout(workerSupervisorTimer);
  workerSupervisorTimer = null;
}

function scheduleSupervisorWake(nextClaimAt) {
  clearSupervisorWakeTimer();
  const timestamp = Number(nextClaimAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  const waitMs = timestamp * 1000 - Date.now();
  if (waitMs <= 0) return;
  workerSupervisorTimer = setTimeout(
    () => {
      workerSupervisorTimer = null;
      checkQueuedBackgroundWork();
    },
    Math.max(1000, Math.min(waitMs, WORKER_SUPERVISOR_POLL_MS)),
  );
  if (typeof workerSupervisorTimer.unref === "function") {
    workerSupervisorTimer.unref();
  }
}

function checkQueuedBackgroundWork() {
  if (process.env.AURRAL_TEST_SERVER === "1") return;
  let nextClaimAt = null;
  for (const worker of QUEUE_WORKERS) {
    try {
      if (getHonkerQueueDepth(worker.queue) > 0) {
        worker.start();
      }
      const queueNextClaimAt = getHonkerQueueNextClaimAt(worker.queue);
      if (queueNextClaimAt && (nextClaimAt == null || queueNextClaimAt < nextClaimAt)) {
        nextClaimAt = queueNextClaimAt;
      }
    } catch (error) {
      console.warn(
        `[AppRuntime] Failed to inspect ${worker.queue} queue:`,
        error?.message || error,
      );
    }
  }
  scheduleSupervisorWake(nextClaimAt);
}

function startWorkerSupervisor() {
  if (workerSupervisorStarted || process.env.AURRAL_TEST_SERVER === "1") {
    return;
  }
  workerSupervisorStarted = true;
  checkQueuedBackgroundWork();
  workerSupervisorInterval = setInterval(checkQueuedBackgroundWork, WORKER_SUPERVISOR_POLL_MS);
  if (typeof workerSupervisorInterval.unref === "function") {
    workerSupervisorInterval.unref();
  }
}

function stopWorkerSupervisor() {
  workerSupervisorStarted = false;
  clearSupervisorWakeTimer();
  if (workerSupervisorInterval) {
    clearInterval(workerSupervisorInterval);
    workerSupervisorInterval = null;
  }
}

registerHonkerShutdownHandler(() => {
  stopWorkerSupervisor();
  stopLibraryFileWatcher();
});

export function startBackgroundWorkers({ logger = console } = {}) {
  if (backgroundWorkersStarted || process.env.AURRAL_TEST_SERVER === "1") {
    return false;
  }
  backgroundWorkersStarted = true;
  ensurePlaylistFilesystemLayout({ logger });
  import("./honkerTaskStatus.js")
    .then(({ clearStaleHonkerJobs }) => clearStaleHonkerJobs())
    .then((result) => {
      if (Number(result?.cleared || 0) > 0) {
        logger.info?.(`[AppRuntime] Cleared ${result.cleared} stuck background job(s) on startup`);
      }
    })
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Failed to clear stuck background jobs on startup:",
        error?.message || error,
      );
    });
  import("./aurralHistoryService.js")
    .then(({ syncProcessingActivityHistory }) => syncProcessingActivityHistory())
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Failed to reconcile stuck activity history on startup:",
        error?.message || error,
      );
    });
  enqueueHonkerStartupTasks();
  startWorkerSupervisor();
  void startLibraryFileWatcher({ logger });
  return true;
}

export function initializeAppRuntime({ logger = console } = {}) {
  startHonkerScheduler();
  startBackgroundWorkers({ logger });
}
