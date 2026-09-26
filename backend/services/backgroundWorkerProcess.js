import { ISOLATED_WORKER_GROUPS, isQueueOwnedByGroup } from "./backgroundWorkerQueues.js";
import { logger } from "./logger.js";

const group = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
if (!ISOLATED_WORKER_GROUPS.includes(group) || !process.send) {
  throw new Error("Background worker process requires a supervised queue group");
}

const { startWorkerSupervisor, wakeQueuedBackgroundWork } = await import("./appRuntime.js");
const { getHonkerWorkerStatuses, shutdownHonkerInfrastructure } =
  await import("./honkerWorkerRuntime.js");
const flowWorker = group === "flow"
  ? (await import("./weeklyFlow/weeklyFlowWorker.js")).weeklyFlowWorker
  : null;
const flowOperationStatus = group === "flow"
  ? (await import("./weeklyFlow/weeklyFlowOperationWorker.js")).getWeeklyFlowOperationWorkerStatus
  : null;

let stopping = false;
const FLOW_COMMANDS = new Set([
  "start", "stop", "stopAndDrain", "wake", "researchMissingTracks",
  "retryIncompletePlaylist", "setRetryCyclePaused", "updateWorkerSettings",
  "checkPlaylistComplete", "blockPlaylist", "unblockPlaylist",
  "waitForPlaylistIdle", "waitForIdle", "clearIncompleteRetry",
  "clearPlaylistRunState", "pruneOrphanedJobState", "scheduleReuseLinkRepair",
  "runQualityUpgradeChecks", "queueQualityUpgradeForJob", "clearPendingByPlaylist",
  "wakeOrStart", "syncSharedPlaylistImport",
  "enqueueManualMissingSelection",
]);

async function handleFlowCommand(message) {
  const { requestId, method, args = [] } = message;
  try {
    if (group !== "flow" || !FLOW_COMMANDS.has(method) || !Array.isArray(args)) {
      throw new Error("Unsupported flow worker command");
    }
    const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
      import("../db/helpers/index.js"),
      import("./weeklyFlow/weeklyFlowPlaylistConfig.js"),
    ]);
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    let result;
    if (method === "enqueueManualMissingSelection") {
      const { downloadTracker } = await import("./weeklyFlow/weeklyFlowDownloadTracker.js");
      result = downloadTracker.enqueueManualSelection(args[0], args[1]);
    } else if (method === "clearPendingByPlaylist") {
      const { downloadTracker } = await import("./weeklyFlow/weeklyFlowDownloadTracker.js");
      result = downloadTracker.clearPendingByPlaylistType(args[0]);
    } else if (method === "wakeOrStart") {
      if (flowWorker.running) flowWorker.wake(args[0]);
      else await flowWorker.start();
      result = true;
    } else if (method === "runQualityUpgradeChecks") {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.js");
      const [playlistIds, limit = 500] = args;
      result = 0;
      for (const playlistId of playlistIds) {
        result += await runQualityUpgradeCheck({ force: true, playlistId, limit });
      }
    } else if (method === "queueQualityUpgradeForJob") {
      const [{ queueQualityUpgrade }, { downloadTracker }] = await Promise.all([
        import("./qualityProfileService.js"),
        import("./weeklyFlow/weeklyFlowDownloadTracker.js"),
      ]);
      result = await queueQualityUpgrade(downloadTracker.getJob(args[0]));
    } else if (method === "syncSharedPlaylistImport") {
      const { syncSharedPlaylistImport } = await import("./importLists/importListSync.js");
      try {
        result = { ok: true, result: await syncSharedPlaylistImport(args[0]) };
      } catch (error) {
        result = {
          ok: false,
          error: {
            message: error?.message || "Playlist sync failed",
            code: error?.code || null,
            statusCode: error?.statusCode || null,
          },
        };
      }
    } else {
      result = await flowWorker[method](...args);
    }
    if (process.connected) {
      process.send({ type: "cache-invalidate", cache: "flow" });
      process.send({ type: "flow-response", requestId, result });
    }
  } catch (error) {
    logger.error("workers", "Flow worker command failed", {
      group,
      method,
      requestId,
      reason: error?.message || String(error),
    });
    if (process.connected) {
      process.send({ type: "flow-response", requestId, error: error?.message || String(error) });
    }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await shutdownHonkerInfrastructure({ timeoutMs: 3000 });
  process.exit(0);
}

process.on("message", (message) => {
  if (message?.type === "shutdown") void stop();
  if (message?.type === "flow-command") void handleFlowCommand(message);
  if (message?.type === "queue-wake") wakeQueuedBackgroundWork(group);
});
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.once("disconnect", () => { void stop(); });

if (group === "scheduler") {
  const { startHonkerScheduler } = await import("./honkerDb.js");
  startHonkerScheduler();
} else {
  startWorkerSupervisor({ group });
}
process.send({ type: "ready", group });
const heartbeat = setInterval(() => {
  if (process.connected) {
    const flowStatus = flowWorker
      ? { ...flowWorker.getStatus(), operationWorker: flowOperationStatus() }
      : null;
    process.send({
      type: "heartbeat",
      group,
      workers: getHonkerWorkerStatuses().filter((worker) =>
        isQueueOwnedByGroup(worker.name, group)),
      ...(flowStatus ? { flowStatus } : {}),
    });
  }
}, 5000);
heartbeat.unref?.();
