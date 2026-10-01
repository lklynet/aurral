import { getNotificationOutbox, getWorkerId, hasClaimableHonkerJobs } from "./honkerDb.js";
import {
  createIdleAbortController,
  getWorkerIdleStopMs,
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "notification-outbox";

let running = false;
let stopRequested = false;
let _loopPromise = null;
let abortController = null;

async function runLoop() {
  abortController = createIdleAbortController({
    idleStopMs: getWorkerIdleStopMs(),
    isBusy: () => hasClaimableHonkerJobs(getNotificationOutbox().queue.name),
  });
  abortController.arm();
  try {
    await getNotificationOutbox().runWorker(getWorkerId(), {
      idlePollS: 5,
      signal: abortController.signal,
    });
  } catch (error) {
    if (!stopRequested && !abortController.idleStopped && !isHonkerShuttingDown()) {
      console.error("[notificationOutboxWorker] loop error:", error);
    }
  } finally {
    const intentional = stopRequested || abortController.idleStopped;
    abortController.dispose();
    abortController = null;
    running = false;
    _loopPromise = null;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startNotificationOutboxWorker, {
      intentional,
    });
  }
}

export function startNotificationOutboxWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  _loopPromise = runLoop();
  return _loopPromise;
}

export function stopNotificationOutboxWorker() {
  stopRequested = true;
  abortController?.abort();
  return _loopPromise || Promise.resolve();
}

export function isNotificationOutboxWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startNotificationOutboxWorker,
  stop: stopNotificationOutboxWorker,
  isRunning: isNotificationOutboxWorkerRunning,
});
