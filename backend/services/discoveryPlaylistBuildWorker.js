import {
  getDiscoveryPlaylistBuildQueue,
  getWorkerId,
} from "./honkerDb.js";
import {
  emitDiscoverPlaylistBuildFailure,
  runQueuedDiscoverPlaylistBuild,
} from "./discoveryService.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "discovery-playlist-build";

let running = false;
let stopRequested = false;
let loopPromise = null;

async function runLoop() {
  const queue = getDiscoveryPlaylistBuildQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 5 })) {
      if (!running || stopRequested) break;
      try {
        await withJobHeartbeat(job, queue, () =>
          runQueuedDiscoverPlaylistBuild(job.payload),
        );
        job.ack();
      } catch (error) {
        const message = error?.message || String(error);
        if (job.attempts >= 3) {
          job.fail(message);
          emitDiscoverPlaylistBuildFailure(job.payload, error);
        } else {
          job.retry(120, message);
        }
      }
    }
  } catch (error) {
    console.error("[discoveryPlaylistBuildWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startDiscoveryPlaylistBuildWorker, {
      intentional,
    });
  }
}

export function startDiscoveryPlaylistBuildWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
}

export function stopDiscoveryPlaylistBuildWorker() {
  stopRequested = true;
  running = false;
}

export function isDiscoveryPlaylistBuildWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startDiscoveryPlaylistBuildWorker,
  stop: stopDiscoveryPlaylistBuildWorker,
  isRunning: isDiscoveryPlaylistBuildWorkerRunning,
});
