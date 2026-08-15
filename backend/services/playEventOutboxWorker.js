import { getPlayEventOutbox, getWorkerId } from "./honkerDb.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "play-event-outbox";
let running = false;
let stopRequested = false;
let loopPromise = null;
let abortController = null;

async function runLoop() {
  abortController = new AbortController();
  try {
    await getPlayEventOutbox().runWorker(getWorkerId(), {
      idlePollS: 5,
      signal: abortController.signal,
    });
  } catch (error) {
    if (!stopRequested && !isHonkerShuttingDown()) {
      console.error("[playEventOutboxWorker] loop error:", error);
    }
  } finally {
    abortController = null;
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startPlayEventOutboxWorker, { intentional });
  }
}

export function startPlayEventOutboxWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
  return loopPromise;
}

export function stopPlayEventOutboxWorker() {
  stopRequested = true;
  abortController?.abort();
  return loopPromise || Promise.resolve();
}

export function isPlayEventOutboxWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startPlayEventOutboxWorker,
  stop: stopPlayEventOutboxWorker,
  isRunning: isPlayEventOutboxWorkerRunning,
});
