import { getNotificationOutbox, getWorkerId } from "./honkerDb.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "notification-outbox";

let running = false;
let stopRequested = false;
let loopPromise = null;
let abortController = null;

async function runLoop() {
  abortController = new AbortController();
  try {
    await getNotificationOutbox().runWorker(getWorkerId(), {
      idlePollS: 5,
      signal: abortController.signal,
    });
  } catch (error) {
    if (!stopRequested && !isHonkerShuttingDown()) {
      console.error("[notificationOutboxWorker] loop error:", error);
    }
  } finally {
    abortController = null;
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
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
  loopPromise = runLoop();
}

export function stopNotificationOutboxWorker() {
  stopRequested = true;
  running = false;
  abortController?.abort();
}

export function isNotificationOutboxWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startNotificationOutboxWorker,
  stop: stopNotificationOutboxWorker,
  isRunning: isNotificationOutboxWorkerRunning,
});
