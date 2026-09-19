import {
  enqueueHonkerStartupTasks,
  getHonkerDb,
  getHonkerQueueByName,
  getHonkerQueueDepth,
  getHonkerQueueNextClaimAt,
  startHonkerScheduler,
} from "./honkerDb.js";
import { createBackgroundProcessSupervisor } from "./backgroundProcessSupervisor.js";
import { ISOLATED_QUEUE_GROUPS, isQueueOwnedByGroup } from "./backgroundWorkerQueues.js";
import { isHonkerShuttingDown, registerHonkerShutdownHandler } from "./honkerWorkerRuntime.js";
import { HONKER_QUEUE_NAMES } from "./honkerDb.js";
import { configureFlowOwnerClient } from "./weeklyFlow/weeklyFlowOwnerClient.js";

let backgroundWorkersStarted = false;
let workerSupervisorStarted = false;
let workerSupervisorInterval = null;
let workerSupervisorTimer = null;
let supervisedGroup = null;
let backgroundProcessSupervisor = null;
let lastExpiredSweepAt = 0;
let stopLibraryFileWatcher = null;

export function getIsolatedWorkerStatuses() {
  return backgroundProcessSupervisor?.getWorkerStatuses() || [];
}

const WORKER_SUPERVISOR_POLL_MS = Math.max(
  process.env.AURRAL_BACKGROUND_WORKER_GROUP ? 1000 : 15000,
  Math.floor(Number(process.env.AURRAL_WORKER_SUPERVISOR_POLL_MS) ||
    (process.env.AURRAL_BACKGROUND_WORKER_GROUP ? 2000 : 60000)),
);

const WORKER_STARTS = {
  "system-task": ["./systemTaskWorker.js", "startSystemTaskWorker"],
  "system-task-maintenance": ["./systemTaskWorker.js", "startMaintenanceTaskWorker"],
  "system-task-inbox": ["./systemTaskWorker.js", "startInboxTaskWorker"],
  "library-scan": ["./libraryScanWorker.js", "startLibraryScanWorker"],
  "_outbox:notifications": ["./notificationOutboxWorker.js", "startNotificationOutboxWorker"],
  "_outbox:play-events": ["./playEventOutboxWorker.js", "startPlayEventOutboxWorker"],
  "slskd-pipeline": ["./slskdOrchestratorWorker.js", "startSlskdOrchestratorWorker"],
  "discovery-refresh": ["./discoveryRefreshWorker.js", "startDiscoveryRefreshWorker"],
  "discovery-playlist-build": ["./discoveryPlaylistBuildWorker.js", "startDiscoveryPlaylistBuildWorker"],
  "discovery-user-refresh": ["./discoveryUserRefreshWorker.js", "startDiscoveryUserRefreshWorker"],
  "weekly-flow-operation": ["./weeklyFlow/weeklyFlowOperationWorker.js", "startWeeklyFlowOperationWorker"],
  "playlist-retry": ["./weeklyFlow/weeklyFlowPlaylistRetryWorker.js", "startWeeklyFlowPlaylistRetryWorker"],
  "playlist-reserve-build": ["./weeklyFlow/weeklyFlowPlaylistReserveBuildWorker.js", "startWeeklyFlowPlaylistReserveBuildWorker"],
  "playlist-mbid-enrichment": ["./playlistMbidEnrichmentWorker.js", "startPlaylistMbidEnrichmentWorker"],
};

const QUEUE_WORKERS = HONKER_QUEUE_NAMES.map((queue) => ({
  queue,
  start: WORKER_STARTS[queue],
})).filter((worker) => Array.isArray(worker.start));

function startQueueWorker([modulePath, startName], queueName) {
  import(modulePath)
    .then((module) => module[startName]())
    .catch((error) => {
      console.warn(`[AppRuntime] Failed to start ${queueName}:`, error?.message || error);
    });
}

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
      checkQueuedBackgroundWork(supervisedGroup);
    },
    Math.max(1000, Math.min(waitMs, WORKER_SUPERVISOR_POLL_MS)),
  );
  if (typeof workerSupervisorTimer.unref === "function") {
    workerSupervisorTimer.unref();
  }
}

function checkQueuedBackgroundWork(group = null) {
  if (process.env.AURRAL_TEST_SERVER === "1") return;
  let nextClaimAt = null;
  const sweepExpired = Date.now() - lastExpiredSweepAt >= 30000;
  if (sweepExpired) lastExpiredSweepAt = Date.now();
  for (const worker of QUEUE_WORKERS) {
    if (!isQueueOwnedByGroup(worker.queue, group)) continue;
    try {
      if (sweepExpired) getHonkerQueueByName(worker.queue)?.sweepExpired();
      if (getHonkerQueueDepth(worker.queue) > 0) {
        startQueueWorker(worker.start, worker.queue);
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

export function startWorkerSupervisor({ group = null } = {}) {
  if (workerSupervisorStarted || process.env.AURRAL_TEST_SERVER === "1") {
    return;
  }
  workerSupervisorStarted = true;
  supervisedGroup = group;
  checkQueuedBackgroundWork(group);
  workerSupervisorInterval = setInterval(() => checkQueuedBackgroundWork(group), WORKER_SUPERVISOR_POLL_MS);
  if (typeof workerSupervisorInterval.unref === "function") {
    workerSupervisorInterval.unref();
  }
}

function stopWorkerSupervisor() {
  workerSupervisorStarted = false;
  supervisedGroup = null;
  clearSupervisorWakeTimer();
  if (workerSupervisorInterval) {
    clearInterval(workerSupervisorInterval);
    workerSupervisorInterval = null;
  }
}

registerHonkerShutdownHandler(() => {
  stopWorkerSupervisor();
  stopLibraryFileWatcher?.();
  return backgroundProcessSupervisor?.stop();
});

export async function forwardWorkerBroadcast(message) {
  if (message?.type !== "websocket-broadcast" || typeof message.channel !== "string") return;
  const { websocketService } = await import("./websocketService.js");
  if (message.channel === "discovery") {
    try {
      const { synchronizeDiscoveryCacheFromWorker } = await import("./discovery/persistence.js");
      synchronizeDiscoveryCacheFromWorker(message.data);
    } catch (error) {
      console.warn("[AppRuntime] Could not refresh discovery state:", error?.message || error);
    }
  }
  if (message.channel === "library" && message.data?.type === "library_scan_completed") {
    const { invalidateCanonicalLibraryCache } = await import("./libraryQueryService.js");
    invalidateCanonicalLibraryCache({ persistedGenres: false });
    const { clearSearchContextCache } = await import("./unifiedSearchService.js");
    clearSearchContextCache();
  }
  websocketService.broadcast(message.channel, message.data);
}

export async function recoverExitedWorkerJobs(group, pid, logger = console, reason = null) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const workerId = `aurral-${pid}`;
  const database = getHonkerDb();
  const rows = database.query(
    "SELECT id, queue FROM _honker_live WHERE worker_id = ? AND state = 'processing'",
    [workerId],
  );
  for (const row of rows) {
    if (ISOLATED_QUEUE_GROUPS[row.queue] !== group) continue;
    try {
      if (row.queue === "library-scan") {
        const { restoreLibraryScanAfterWorkerExit } = await import("./libraryScanWorker.js");
        restoreLibraryScanAfterWorkerExit(row.id);
      }
      try {
        const { recordHonkerTaskRunFinished } = await import("./honkerTaskStatus.js");
        const runs = database.query(
          "SELECT id FROM honker_task_runs WHERE job_id = ? AND worker_id = ? AND status = 'running'",
          [row.id, workerId],
        );
        for (const run of runs) {
          recordHonkerTaskRunFinished(run.id, "failed", reason || "Background worker process exited");
        }
      } catch (error) {
        logger.warn?.(`[AppRuntime] Could not update ${row.queue} task history:`, error?.message || error);
      }
      // Honker registers retry on its queue connection, not on the raw query connection.
      getHonkerQueueByName(row.queue)._retry(
        row.id, workerId, 1, reason || "Background worker process exited",
      );
    } catch (error) {
      logger.warn?.(`[AppRuntime] Could not requeue ${row.queue} job ${row.id}:`, error?.message || error);
    }
  }
  if (group === "flow") {
    const { downloadTracker } = await import("./weeklyFlow/weeklyFlowDownloadTracker.js");
    downloadTracker.resetDownloadingToPending();
  }
}

export function startBackgroundWorkers({ logger = console } = {}) {
  if (backgroundWorkersStarted || process.env.AURRAL_TEST_SERVER === "1") {
    return false;
  }
  backgroundWorkersStarted = true;
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
  if (HONKER_QUEUE_NAMES.some((queue) => isQueueOwnedByGroup(queue))) {
    startWorkerSupervisor();
  }
  backgroundProcessSupervisor = createBackgroundProcessSupervisor({
    logger,
    onMessage(message, _group, child) {
      if (message?.type === "queue-wake") {
        if (isQueueOwnedByGroup(message.queue)) checkQueuedBackgroundWork();
        return;
      }
      if (message?.type === "flow-client-request") {
        void backgroundProcessSupervisor.request("flow", message.method, message.args, {
          timeoutMs: Math.min(30 * 60 * 1000, Number(message.timeoutMs) || 30000),
        }).then((result) => {
          if (child.connected) child.send({
            type: "flow-client-response", requestId: message.requestId, result,
          });
        }).catch((error) => {
          if (child.connected) child.send({
            type: "flow-client-response", requestId: message.requestId,
            error: error?.message || String(error),
          });
        });
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "flow") {
        void Promise.all([
          import("../db/helpers/index.js"),
          import("./weeklyFlow/weeklyFlowPlaylistConfig.js"),
        ]).then(([{ dbOps }, { invalidateFlowPlaylistConfigCache }]) => {
          dbOps.invalidateSettingsCache();
          invalidateFlowPlaylistConfigCache();
        }).catch((error) => {
          logger.warn?.("[AppRuntime] Could not refresh flow cache:", error?.message || error);
        });
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "lidarr-artists") {
        void import("./libraryManager.js").then(({ invalidateLidarrArtistCache }) => {
          invalidateLidarrArtistCache();
        }).catch((error) => {
          logger.warn?.("[AppRuntime] Could not refresh Lidarr artist cache:", error?.message || error);
        });
        return;
      }
      if (message?.type === "job-finished" && _group === "flow") {
        void Promise.all([
          import("../db/helpers/index.js"),
          import("./weeklyFlow/weeklyFlowPlaylistConfig.js"),
        ]).then(([{ dbOps }, { invalidateFlowPlaylistConfigCache }]) => {
          dbOps.invalidateSettingsCache();
          invalidateFlowPlaylistConfigCache();
        });
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "news") {
        void import("./newsService.js").then(({ invalidateNewsResponseCache }) => {
          invalidateNewsResponseCache();
        }).catch((error) => {
          logger.warn?.("[AppRuntime] Could not refresh news cache:", error?.message || error);
        });
        return;
      }
      void forwardWorkerBroadcast(message).catch((error) => {
        logger.warn?.("[AppRuntime] Failed to forward worker update:", error?.message || error);
      });
    },
    onExit(group, _code, _signal, pid, reason) {
      const recovery = recoverExitedWorkerJobs(group, pid, logger, reason).catch((error) => {
        logger.warn?.(`[AppRuntime] Could not recover ${group} jobs:`, error?.message || error);
      });
      if (group !== "discovery-refresh" && group !== "discovery-playlist-build") return recovery;
      void forwardWorkerBroadcast({
        type: "websocket-broadcast",
        channel: "discovery",
        data: group === "discovery-refresh" ? {
          type: "discovery_update",
          isUpdating: false,
          phase: "error",
          progressMessage: "Discovery refresh stopped; queued jobs will retry",
        } : {
          type: "discovery_update",
          playlistsUpdating: false,
          playlistsUpdateMessage: "Playlist build stopped; queued jobs will retry",
        },
      }).catch((error) => {
        logger.warn?.("[AppRuntime] Failed to report discovery restart:", error?.message || error);
      });
      return recovery;
    },
  });
  configureFlowOwnerClient({
    request: (method, args, options) =>
      backgroundProcessSupervisor.request("flow", method, args, options),
    getStatus: () => backgroundProcessSupervisor.getFlowStatus(),
  });
  backgroundProcessSupervisor.start();
  void import("./libraryFileWatcher.js")
    .then((module) => {
      stopLibraryFileWatcher = module.stopLibraryFileWatcher;
      if (isHonkerShuttingDown()) return;
      return module.startLibraryFileWatcher({ logger });
    })
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Failed to start library file watcher:",
        error?.message || error,
      );
    });
  return true;
}

export function initializeAppRuntime({ logger = console } = {}) {
  if (process.env.AURRAL_TEST_SERVER === "1") startHonkerScheduler();
  startBackgroundWorkers({ logger });
  // The bundled beets matcher is production-critical for downloads; a broken
  // Python/beets installation must be obvious at startup.
  void import("./trackMatching/index.js")
    .then(({ verifyMatcherRuntime }) => verifyMatcherRuntime())
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Track matcher self-test crashed:",
        error?.message || error,
      );
    });
}
