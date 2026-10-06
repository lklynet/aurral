import { ISOLATED_WORKER_GROUPS, isQueueOwnedByGroup } from "./backgroundWorkerQueues.js";
import { logger } from "./logger.js";

const group = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
if (!ISOLATED_WORKER_GROUPS.includes(group) || !process.send) {
  throw new Error("Background worker process requires a supervised queue group");
}

const { startWorkerSupervisor, wakeQueuedBackgroundWork, hasQueuedBackgroundWork } =
  await import("./appRuntime.js");
const { getHonkerWorkerStatuses, getWorkerIdleStopMs, shutdownHonkerInfrastructure } =
  await import("./honkerWorkerRuntime.js");
const { isHonkerScheduleDue } = await import("./honkerDb.js");
const downloadWorker = group === "downloads"
  ? (await import("./downloadJobs/downloadWorker.js")).downloadWorker
  : null;
const playlistOperationStatus = group === "downloads"
  ? (await import("./playlists/playlistOperationWorker.js")).getPlaylistOperationWorkerStatus
  : null;
const hasApprovalFollowUps = group === "downloads"
  ? (await import("./downloadJobs/blockedJobReview.js")).hasApprovalFollowUps
  : () => false;

let stopping = false;
let ownerCommandsInFlight = 0;
let lastOwnerCommandAt = 0;
const DOWNLOAD_OWNER_COMMANDS = new Set([
  "start", "stop", "stopAndDrain", "wake", "researchMissingJobs",
  "setRetryCyclePaused", "updateWorkerSettings",
  "checkPlaylistComplete", "blockPlaylist", "unblockPlaylist",
  "waitForPlaylistIdle", "waitForIdle",
  "pruneOrphanedJobState", "scheduleReuseLinkRepair",
  "runQualityUpgradeChecks", "queueQualityUpgradeForJob", "clearPendingByOwner",
  "wakeOrStart", "syncStaticPlaylistImport",
  "enqueueManualMissingSelection", "enqueueManualReplacementSelection",
  "approveBlockedJob", "denyBlockedJob",
]);

async function handleDownloadOwnerCommand(message) {
  const { requestId, method, args = [] } = message;
  try {
    if (group !== "downloads" || !DOWNLOAD_OWNER_COMMANDS.has(method) || !Array.isArray(args)) {
      throw new Error("Unsupported download worker command");
    }
    const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
      import("../db/helpers/index.js"),
      import("./playlists/flowPlaylistConfig.js"),
    ]);
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    let result;
    if (method === "enqueueManualMissingSelection") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.js");
      result = downloadTracker.enqueueManualSelection(args[0], args[1]);
    } else if (method === "enqueueManualReplacementSelection") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.js");
      result = downloadTracker.enqueueManualReplacementSelection(args[0], args[1]);
    } else if (method === "approveBlockedJob" || method === "denyBlockedJob") {
      const review = await import("./downloadJobs/blockedJobReview.js");
      result = await review[method](args[0]);
    } else if (method === "clearPendingByOwner") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.js");
      result = downloadTracker.clearPendingByOwner(args[0]);
    } else if (method === "wakeOrStart") {
      if (downloadWorker.running) downloadWorker.wake(args[0]);
      else await downloadWorker.start();
      result = true;
    } else if (method === "runQualityUpgradeChecks") {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.js");
      const [jobIds, limit = 500] = args;
      result = await runQualityUpgradeCheck({ force: true, jobIds, limit });
    } else if (method === "queueQualityUpgradeForJob") {
      const [{ queueQualityUpgrade }, { downloadTracker }] = await Promise.all([
        import("./qualityProfileService.js"),
        import("./downloadJobs/downloadTracker.js"),
      ]);
      result = await queueQualityUpgrade(downloadTracker.getJob(args[0]));
    } else if (method === "syncStaticPlaylistImport") {
      const { syncStaticPlaylistImport } = await import("./importLists/importListSync.js");
      try {
        result = { ok: true, result: await syncStaticPlaylistImport(args[0]) };
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
      result = await downloadWorker[method](...args);
    }
    if (process.connected) {
      process.send({ type: "cache-invalidate", cache: "playlists" });
      process.send({ type: "download-owner-response", requestId, result });
    }
  } catch (error) {
    logger.error("workers", "Download worker command failed", {
      group,
      method,
      requestId,
      reason: error?.message || String(error),
    });
    if (process.connected) {
      process.send({ type: "download-owner-response", requestId, error: error?.message || String(error) });
    }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await shutdownHonkerInfrastructure({ timeoutMs: 3000 });
  process.exit(0);
}

function isIdle() {
  const idleStopMs = getWorkerIdleStopMs();
  if (stopping || !idleStopMs) return false;
  if (ownerCommandsInFlight > 0 || Date.now() - lastOwnerCommandAt < idleStopMs) return false;
  if (downloadWorker?.hasWork() || hasApprovalFollowUps()) return false;
  try {
    if (group === "scheduler") return !isHonkerScheduleDue();
    return !hasQueuedBackgroundWork(group);
  } catch {
    return false;
  }
}

process.on("message", (message) => {
  if (message?.type === "shutdown") void stop();
  if (message?.type === "download-owner-command") {
    ownerCommandsInFlight += 1;
    void handleDownloadOwnerCommand(message).finally(() => {
      ownerCommandsInFlight -= 1;
      lastOwnerCommandAt = Date.now();
    });
  }
  if (message?.type === "queue-wake") wakeQueuedBackgroundWork(group);
  if (message?.type === "retire") {
    if (isIdle()) void stop();
    else if (process.connected) process.send({ type: "busy" });
  }
});
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.once("disconnect", () => { void stop(); });

if (group === "scheduler") {
  const { startHonkerScheduler } = await import("./honkerDb.js");
  startHonkerScheduler();
  const { startHonkerTaskCleanup } = await import("./honkerTaskStatus.js");
  await startHonkerTaskCleanup();
} else {
  startWorkerSupervisor({ group });
}
process.send({ type: "ready", group });
const heartbeat = setInterval(() => {
  if (process.connected) {
    const downloadOwnerStatus = downloadWorker
      ? { ...downloadWorker.getStatus(), operationWorker: playlistOperationStatus() }
      : null;
    process.send({
      type: "heartbeat",
      group,
      workers: getHonkerWorkerStatuses().filter((worker) =>
        isQueueOwnedByGroup(worker.name, group)),
      ...(downloadOwnerStatus ? { downloadOwnerStatus } : {}),
    });
    if (isIdle()) process.send({ type: "idle" });
  }
}, 5000);
heartbeat.unref?.();
