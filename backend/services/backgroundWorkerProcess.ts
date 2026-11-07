import { WORKER_GROUPS } from "./jobs/groups.ts";
import { ownsQueueHere } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";

const group = WORKER_GROUPS.find((name) => name === process.env.AURRAL_BACKGROUND_WORKER_GROUP);
if (!group || !process.send) {
  throw new Error("Background worker process requires a supervised queue group");
}

(await import("./logs.ts")).startWorkerLogging();

const { startGroupWorkers, wakeQueuedBackgroundWork, hasQueuedBackgroundWork } =
  await import("./appRuntime.ts");
const { getWorkerStatuses, hasActiveJobs, shutdownJobWorkers } = await import("./jobs/worker.ts");
const IDLE_STOP_MS = (() => {
  const configured = Number(process.env.AURRAL_WORKER_IDLE_STOP_MS);
  if (!Number.isFinite(configured)) return 60_000;
  return configured <= 0 ? 0 : Math.max(5000, Math.floor(configured));
})();
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
let lastBusyAt = Date.now();
type SupervisorMessage =
  | { type: "shutdown" | "retire" | "queue-wake" }
  | { type: "download-owner-command"; requestId: number; method: unknown; args?: unknown };

async function handleDownloadOwnerCommand(
  message: Extract<SupervisorMessage, { type: "download-owner-command" }>,
) {
  const { requestId, method, args = [] } = message;
  try {
    const [{ dbOps }, { invalidateFlowPlaylistConfigCache }, { downloadOwnerCommands }] =
      await Promise.all([
        import("../db/helpers/index.ts"),
        import("./playlists/flowPlaylistConfig.ts"),
        import("./downloadJobs/downloadOwnerCommands.ts"),
      ]);
    if (
      !downloadWorker ||
      typeof method !== "string" ||
      !isOwnKey(downloadOwnerCommands, method) ||
      !Array.isArray(args)
    ) {
      throw new Error("Unsupported download worker command");
    }
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    const result: unknown = await Reflect.apply(downloadOwnerCommands[method], undefined, args);
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
  await shutdownJobWorkers({ timeoutMs: 3000 });
  process.exit(0);
}

function isBusy() {
  if (ownerCommandsInFlight > 0 || hasActiveJobs()) return true;
  if (downloadWorker?.hasWork() || hasApprovalFollowUps()) return true;
  try {
    return hasQueuedBackgroundWork();
  } catch {
    return true;
  }
}

function isIdle() {
  if (stopping || !IDLE_STOP_MS) return false;
  if (isBusy()) lastBusyAt = Date.now();
  return Date.now() - Math.max(lastBusyAt, lastOwnerCommandAt) >= IDLE_STOP_MS;
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
  if (message?.type === "queue-wake") wakeQueuedBackgroundWork();
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

startGroupWorkers();
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
      workers: getWorkerStatuses().filter((worker) => ownsQueueHere(worker.name)),
      ...(downloadOwnerStatus && { downloadOwnerStatus }),
    });
  }
}, 5000);
heartbeat.unref?.();
const idleCheck = setInterval(() => {
  if (process.connected && isIdle()) process.send!({ type: "idle" });
}, 1000);
idleCheck.unref?.();
