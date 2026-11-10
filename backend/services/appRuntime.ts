import {
  configureQueueWake,
  getNextWorkAt,
  getQueue,
  listGroupsWithWork,
  listQueues,
  notifyLocalWaiters,
  ownsQueueHere,
  pruneFinishedJobs,
  recoverAbandonedJobs,
} from "./jobs/queue.ts";
import "./jobs/queues.ts";
import { runDueSchedules } from "./jobs/schedules.ts";
import { enqueueStartupTasks } from "./jobs/startup.ts";
import { getWorkerStatuses, isShuttingDown, registerShutdownHandler } from "./jobs/worker.ts";
import { createBackgroundProcessSupervisor } from "./backgroundProcessSupervisor.ts";
import { configureDownloadOwnerClient } from "./downloadJobs/downloadOwnerClient.ts";
import type { WorkerMessage } from "./backgroundProcessSupervisor.ts";
import { writeLogEntry, type RuntimeLogger } from "./logger.ts";
import { asAppError } from "../../lib/errors.ts";

const JOB_HISTORY_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;

let backgroundWorkersStarted = false;
let groupWorkersStarted = false;
let groupWakeTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundProcessSupervisor: ReturnType<typeof createBackgroundProcessSupervisor> | null = null;
let stopLibraryFileWatcher: (() => void) | null = null;
let lastPrunedAt = 0;

export function getIsolatedWorkerStatuses() {
  return backgroundProcessSupervisor?.getWorkerStatuses() || [];
}

function ownedQueues() {
  return listQueues().filter((queue) => ownsQueueHere(queue.name));
}

function scheduleGroupWake(at: number | null) {
  if (groupWakeTimer) clearTimeout(groupWakeTimer);
  groupWakeTimer = null;
  if (at == null) return;
  groupWakeTimer = setTimeout(
    wakeQueuedBackgroundWork,
    Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()) + 5),
  );
  groupWakeTimer.unref?.();
}

export function wakeQueuedBackgroundWork() {
  if (!groupWorkersStarted || isShuttingDown()) return;
  const running = new Set(
    getWorkerStatuses()
      .filter((worker) => worker.running)
      .map((worker) => worker.name),
  );
  let nextDueAt: number | null = null;
  for (const queue of ownedQueues()) {
    try {
      if (running.has(queue.name)) {
        notifyLocalWaiters(queue.name);
        continue;
      }
      if (queue.hasClaimableJobs()) {
        queue.start().catch((error) => {
          console.warn(
            `[AppRuntime] Failed to start ${queue.name}:`,
            asAppError(error)?.message || error,
          );
        });
        continue;
      }
      const due = queue.nextDueAt();
      if (due != null && (nextDueAt == null || due < nextDueAt)) nextDueAt = due;
    } catch (error) {
      console.warn(
        `[AppRuntime] Failed to inspect ${queue.name} queue:`,
        asAppError(error)?.message || error,
      );
    }
  }
  scheduleGroupWake(nextDueAt);
}

export function hasQueuedBackgroundWork() {
  return ownedQueues().some((queue) => queue.hasClaimableJobs());
}

export function startGroupWorkers() {
  if (groupWorkersStarted || process.env.AURRAL_TEST_SERVER === "1") return;
  groupWorkersStarted = true;
  wakeQueuedBackgroundWork();
}

registerShutdownHandler(() => {
  groupWorkersStarted = false;
  scheduleGroupWake(null);
  stopLibraryFileWatcher?.();
  return backgroundProcessSupervisor?.stop();
});

export async function forwardWorkerBroadcast(message: WorkerMessage) {
  if (message?.type !== "websocket-broadcast" || typeof message.channel !== "string") return;
  const { websocketService } = await import("./websocketService.ts");
  const userId = message.userId ?? null;
  if (message.channel === "discovery" && userId != null) {
    const [{ dbOps }, { getUserDiscoveryNamespace }] = await Promise.all([
      import("../db/helpers/index.ts"),
      import("./discovery/userRefreshRequests.ts"),
    ]);
    dbOps.invalidateDiscoveryCache(getUserDiscoveryNamespace(userId));
  } else if (message.channel === "discovery") {
    try {
      const { synchronizeDiscoveryCacheFromWorker } = await import("./discovery/persistence.ts");
      synchronizeDiscoveryCacheFromWorker(message.data);
    } catch (error) {
      console.warn(
        "[AppRuntime] Could not refresh discovery state:",
        asAppError(error)?.message || error,
      );
    }
  }
  if (message.channel === "library" && message.data?.type === "library_scan_completed") {
    const { invalidateLibraryQueryCache } = await import("./libraryQueryService.ts");
    invalidateLibraryQueryCache({ persistedGenres: false });
  }
  websocketService.broadcast(message.channel, message.data, { userId });
}

function findGroupsWithWork(now: number, logger: RuntimeLogger) {
  if (isShuttingDown()) return [];
  try {
    runDueSchedules(now);
  } catch (error) {
    logger.warn?.(
      "[AppRuntime] Could not run scheduled tasks:",
      asAppError(error)?.message || error,
    );
  }
  if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
    lastPrunedAt = now;
    pruneFinishedJobs(now - JOB_HISTORY_MS);
  }
  return listGroupsWithWork(now);
}

export function startBackgroundWorkers({ logger = console }: { logger?: RuntimeLogger } = {}) {
  if (backgroundWorkersStarted || process.env.AURRAL_TEST_SERVER === "1") {
    return false;
  }
  backgroundWorkersStarted = true;
  import("./aurralHistoryRequests.ts")
    .then(({ syncProcessingActivityHistory }) => syncProcessingActivityHistory())
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Failed to reconcile stuck activity history on startup:",
        asAppError(error)?.message || error,
      );
    });
  backgroundProcessSupervisor = createBackgroundProcessSupervisor({
    logger,
    getNextWorkAt,
    jobTimeoutsMs: Object.fromEntries(listQueues().map((queue) => [queue.name, queue.timeoutMs])),
    findGroupsWithWork: (now) => findGroupsWithWork(now, logger),
    onMessage(message, _group, child) {
      if (message?.type === "log") {
        writeLogEntry(message.entry);
        return;
      }
      if (message?.type === "queue-wake") {
        const group = getQueue(message.queue)?.group;
        if (group) backgroundProcessSupervisor!.wake(group);
        return;
      }
      if (message?.type === "download-owner-client-request") {
        void backgroundProcessSupervisor!
          .request("downloads", message.method, message.args, {
            timeoutMs: Math.min(30 * 60 * 1000, Number(message.timeoutMs) || 30000),
          })
          .then((result) => {
            if (child.connected)
              child.send({
                type: "download-owner-client-response",
                requestId: message.requestId,
                result,
              });
          })
          .catch((error) => {
            if (child.connected)
              child.send({
                type: "download-owner-client-response",
                requestId: message.requestId,
                error: asAppError(error)?.message || String(error),
              });
          });
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "playlists") {
        void import("./playlists/flowPlaylistConfig.ts")
          .then(({ invalidateFlowPlaylistConfigCache }) => {
            invalidateFlowPlaylistConfigCache();
          })
          .catch((error) => {
            logger.warn?.(
              "[AppRuntime] Could not refresh flow cache:",
              asAppError(error)?.message || error,
            );
          });
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "lidarr-artists") {
        void import("./libraryManager.ts")
          .then(({ invalidateLidarrArtistCache }) => {
            invalidateLidarrArtistCache();
          })
          .catch((error) => {
            logger.warn?.(
              "[AppRuntime] Could not refresh Lidarr artist cache:",
              asAppError(error)?.message || error,
            );
          });
        return;
      }
      if (message?.type === "job-finished" && _group === "downloads") {
        void import("./playlists/flowPlaylistConfig.ts").then(
          ({ invalidateFlowPlaylistConfigCache }) => {
            invalidateFlowPlaylistConfigCache();
          },
        );
        return;
      }
      if (message?.type === "cache-invalidate" && message.cache === "news") {
        void import("./newsService.ts")
          .then(({ invalidateNewsResponseCache }) => {
            invalidateNewsResponseCache();
          })
          .catch((error) => {
            logger.warn?.(
              "[AppRuntime] Could not refresh news cache:",
              asAppError(error)?.message || error,
            );
          });
        return;
      }
      void forwardWorkerBroadcast(message).catch((error) => {
        logger.warn?.(
          "[AppRuntime] Failed to forward worker update:",
          asAppError(error)?.message || error,
        );
      });
    },
    onExit(group, _code, _signal, _pid, reason, retired) {
      const recovery = recoverAbandonedJobs(reason || "Background worker process exited", group)
        .then(async () => {
          if (group !== "downloads") return;
          const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
          downloadTracker.resetDownloadingToPending();
        })
        .catch((error) => {
          logger.warn?.(
            `[AppRuntime] Could not recover ${group} jobs:`,
            asAppError(error)?.message || error,
          );
        });
      if (retired || group !== "discovery-refresh") return recovery;
      void import("./discovery/persistence.ts")
        .then(({ markInterruptedDiscoveryRefresh }) => {
          markInterruptedDiscoveryRefresh("Discovery refresh stopped unexpectedly");
          return forwardWorkerBroadcast({
            type: "websocket-broadcast",
            channel: "discovery",
            data: {
              type: "discovery_update",
              isUpdating: false,
              phase: "error",
              progressMessage: "Discovery refresh stopped; queued jobs will retry",
            },
          });
        })
        .catch((error) => {
          logger.warn?.(
            "[AppRuntime] Failed to report discovery restart:",
            asAppError(error)?.message || error,
          );
        });
      return recovery;
    },
  });
  configureDownloadOwnerClient({
    request: (method, args, options) =>
      backgroundProcessSupervisor!.request("downloads", method, args, options),
    getStatus: () => backgroundProcessSupervisor!.getDownloadOwnerStatus(),
  });
  configureQueueWake((name) => {
    const group = getQueue(name)?.group;
    if (group && !isShuttingDown()) backgroundProcessSupervisor?.wake(group);
  });
  void recoverAbandonedJobs("Aurral restarted")
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Could not recover jobs from before the restart:",
        asAppError(error)?.message || error,
      );
    })
    .finally(() => {
      if (isShuttingDown()) return;
      enqueueStartupTasks();
      backgroundProcessSupervisor?.start();
    });
  void import("./libraryFileWatcher.ts")
    .then((module) => {
      stopLibraryFileWatcher = module.stopLibraryFileWatcher;
      if (isShuttingDown()) return;
      return module.startLibraryFileWatcher({ logger });
    })
    .catch((error) => {
      logger.warn?.(
        "[AppRuntime] Failed to start library file watcher:",
        asAppError(error)?.message || error,
      );
    });
  return true;
}

export function initializeAppRuntime({ logger = console }: { logger?: RuntimeLogger } = {}) {
  startBackgroundWorkers({ logger });
}
