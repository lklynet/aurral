import { ISOLATED_WORKER_GROUPS, isQueueOwnedByGroup } from "./backgroundWorkerQueues.ts";
import { logger } from "./logger.ts";
import { asAppError } from "../../lib/errors.ts";

const group = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
if (!group || !ISOLATED_WORKER_GROUPS.includes(group) || !process.send) {
  throw new Error("Background worker process requires a supervised queue group");
}

const { startWorkerSupervisor, wakeQueuedBackgroundWork, hasQueuedBackgroundWork } =
  await import("./appRuntime.ts");
const { getHonkerWorkerStatuses, getWorkerIdleStopMs, shutdownHonkerInfrastructure } =
  await import("./honkerWorkerRuntime.ts");
const { isHonkerScheduleDue } = await import("./honkerDb.ts");
async function loadDownloadOwner() {
  const { DownloadWorker, downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
  if (!(downloadWorker instanceof DownloadWorker)) {
    throw new Error("Download worker process requires the download owner");
  }
  return downloadWorker;
}

const downloadWorker = group === "downloads" ? await loadDownloadOwner() : null;
const playlistOperationStatus =
  group === "downloads"
    ? (await import("./playlists/playlistOperationWorker.ts")).getPlaylistOperationWorkerStatus
    : null;
const hasApprovalFollowUps =
  group === "downloads"
    ? (await import("./downloadJobs/blockedJobReview.ts")).hasApprovalFollowUps
    : () => false;

let stopping = false;
let ownerCommandsInFlight = 0;
let lastOwnerCommandAt = 0;
const DOWNLOAD_OWNER_COMMAND_NAMES = [
  "start",
  "stop",
  "stopAndDrain",
  "wake",
  "researchMissingTracks",
  "setRetryCyclePaused",
  "updateWorkerSettings",
  "checkPlaylistComplete",
  "blockPlaylist",
  "unblockPlaylist",
  "waitForPlaylistIdle",
  "waitForIdle",
  "pruneOrphanedJobState",
  "scheduleReuseLinkRepair",
  "runQualityUpgradeChecks",
  "queueQualityUpgradeForJob",
  "clearPendingByPlaylist",
  "wakeOrStart",
  "syncStaticPlaylistImport",
  "enqueueManualMissingSelection",
  "enqueueManualReplacementSelection",
  "approveBlockedJob",
  "denyBlockedJob",
  "cancelTrackDownload",
  "retryTrackDownload",
] as const;

type DownloadOwnerCommand = (typeof DOWNLOAD_OWNER_COMMAND_NAMES)[number];

const DOWNLOAD_OWNER_COMMANDS: ReadonlySet<unknown> = new Set(DOWNLOAD_OWNER_COMMAND_NAMES);

const isDownloadOwnerCommand = (method: unknown): method is DownloadOwnerCommand =>
  DOWNLOAD_OWNER_COMMANDS.has(method);

type SupervisorMessage =
  | { type: "shutdown" | "retire" | "queue-wake" }
  | { type: "download-owner-command"; requestId: number; method: unknown; args?: unknown };

async function handleDownloadOwnerCommand(
  message: Extract<SupervisorMessage, { type: "download-owner-command" }>,
) {
  const { requestId, method, args = [] } = message;
  try {
    if (group !== "downloads" || !isDownloadOwnerCommand(method) || !Array.isArray(args)) {
      throw new Error("Unsupported download worker command");
    }
    const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
      import("../db/helpers/index.ts"),
      import("./playlists/flowPlaylistConfig.ts"),
    ]);
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    let result;
    if (method === "cancelTrackDownload" || method === "retryTrackDownload") {
      const albumJobs = await import("./aurralAlbumJobs.ts");
      result = await albumJobs[method](args[0]);
    } else if (method === "enqueueManualMissingSelection") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
      result = downloadTracker.enqueueManualSelection(args[0], args[1]);
    } else if (method === "enqueueManualReplacementSelection") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
      result = downloadTracker.enqueueManualReplacementSelection(args[0], args[1]);
    } else if (method === "approveBlockedJob" || method === "denyBlockedJob") {
      const review = await import("./downloadJobs/blockedJobReview.ts");
      result = await review[method](args[0]);
    } else if (method === "clearPendingByPlaylist") {
      const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
      result = downloadTracker.clearPendingByPlaylistType(args[0]);
    } else if (method === "wakeOrStart") {
      if (downloadWorker!.running) downloadWorker!.wake(args[0]);
      else await downloadWorker!.start();
      result = true;
    } else if (method === "runQualityUpgradeChecks") {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.ts");
      const [playlistIds, limit = 500] = args;
      result = await runQualityUpgradeCheck({ force: true, playlistIds, limit });
    } else if (method === "queueQualityUpgradeForJob") {
      const [{ queueQualityUpgrade }, { downloadTracker }] = await Promise.all([
        import("./qualityProfileService.ts"),
        import("./downloadJobs/downloadTracker.ts"),
      ]);
      result = await queueQualityUpgrade(downloadTracker.getJob(args[0]));
    } else if (method === "syncStaticPlaylistImport") {
      const { syncStaticPlaylistImport } = await import("./importLists/importListSync.ts");
      try {
        result = { ok: true, result: await syncStaticPlaylistImport(args[0]) };
      } catch (error) {
        const failure = asAppError(error);
        result = {
          ok: false,
          error: {
            message: failure?.message || "Playlist sync failed",
            code: failure?.code || null,
            statusCode: failure?.statusCode || null,
          },
        };
      }
    } else {
      result = await Reflect.apply(downloadWorker![method], downloadWorker, args);
    }
    if (process.connected) {
      process.send!({ type: "cache-invalidate", cache: "playlists" });
      process.send!({ type: "download-owner-response", requestId, result });
    }
  } catch (error) {
    const failure = asAppError(error);
    logger.error("workers", "Download worker command failed", {
      group,
      method,
      requestId,
      reason: failure?.message || String(error),
    });
    if (process.connected) {
      process.send!({
        type: "download-owner-response",
        requestId,
        error: failure?.message || String(error),
      });
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

process.on("message", (received) => {
  const message = received as SupervisorMessage;
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
    else if (process.connected) process.send!({ type: "busy" });
  }
});
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
process.once("disconnect", () => {
  void stop();
});

if (group === "scheduler") {
  const { startHonkerScheduler } = await import("./honkerDb.ts");
  startHonkerScheduler();
  const { startHonkerTaskCleanup } = await import("./honkerTaskStatus.ts");
  await startHonkerTaskCleanup();
} else {
  startWorkerSupervisor({ group });
}
process.send({ type: "ready", group });
const heartbeat = setInterval(() => {
  if (process.connected) {
    const downloadOwnerStatus = downloadWorker
      ? { ...downloadWorker.getStatus(), operationWorker: playlistOperationStatus!() }
      : null;
    const { rss, heapUsed } = process.memoryUsage();
    process.send!({
      type: "heartbeat",
      group,
      memory: { rss, heapUsed },
      workers: getHonkerWorkerStatuses().filter((worker) =>
        isQueueOwnedByGroup(worker.name, group),
      ),
      ...(downloadOwnerStatus ? { downloadOwnerStatus } : {}),
    });
  }
}, 5000);
heartbeat.unref?.();
const idleCheck = setInterval(() => {
  if (process.connected && isIdle()) process.send!({ type: "idle" });
}, 1000);
idleCheck.unref?.();
