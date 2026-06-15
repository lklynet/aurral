import { getDiscoveryRefreshQueue, getWorkerId } from "./honkerDb.js";
import {
  clearDiscoveryUpdateProgress,
  getDiscoveryCache,
  recordDiscoveryUpdateProgress,
  updateDiscoveryCache,
} from "./discoveryService.js";
import {
  isDiscoveryRefreshConfigured,
  markDiscoveryRefreshDequeued,
  scheduleNextDiscoveryRefresh,
} from "./discoveryRefreshScheduler.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "discovery-refresh";

let running = false;
let stopRequested = false;
let loopPromise = null;

async function runDiscoveryRefresh(payload) {
  if (!(await isDiscoveryRefreshConfigured())) {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
    return;
  }

  const cache = getDiscoveryCache();
  if (!cache.isUpdating) {
    cache.isUpdating = true;
    recordDiscoveryUpdateProgress(
      "starting",
      "Starting discovery refresh",
      2,
      { reason: payload?.reason || "scheduled" },
    );
  }

  await updateDiscoveryCache();
}

async function runLoop() {
  const queue = getDiscoveryRefreshQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 5 })) {
      if (!running || stopRequested) break;
      markDiscoveryRefreshDequeued();
      try {
        await withJobHeartbeat(job, queue, () => runDiscoveryRefresh(job.payload));
        job.ack();
        scheduleNextDiscoveryRefresh();
      } catch (error) {
        const message = error?.message || String(error);
        getDiscoveryCache().isUpdating = false;
        clearDiscoveryUpdateProgress();
        if (job.attempts >= 3) {
          job.fail(message);
        } else {
          job.retry(300, message);
        }
      }
    }
  } catch (error) {
    console.error("[discoveryRefreshWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startDiscoveryRefreshWorker, {
      intentional,
    });
  }
}

export function startDiscoveryRefreshWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
}

export function stopDiscoveryRefreshWorker() {
  stopRequested = true;
  running = false;
}

export function isDiscoveryRefreshWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startDiscoveryRefreshWorker,
  stop: stopDiscoveryRefreshWorker,
  isRunning: isDiscoveryRefreshWorkerRunning,
});
