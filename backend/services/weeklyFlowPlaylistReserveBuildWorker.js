import { getPlaylistReserveBuildQueue, getWorkerId } from "./honkerDb.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "playlist-reserve-build";

let running = false;
let stopRequested = false;
let loopPromise = null;

async function runLoop() {
  const queue = getPlaylistReserveBuildQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 10 })) {
      if (!running || stopRequested) break;
      try {
        await withJobHeartbeat(job, queue, () =>
          weeklyFlowWorker.runQueuedReserveBuild(job.payload),
        );
        job.ack();
      } catch (error) {
        const message = error?.message || String(error);
        if (job.attempts >= 3) {
          job.fail(message);
        } else {
          job.retry(120, message);
        }
      }
    }
  } catch (error) {
    console.error("[weeklyFlowPlaylistReserveBuildWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(
      WORKER_NAME,
      startWeeklyFlowPlaylistReserveBuildWorker,
      { intentional },
    );
  }
}

export function startWeeklyFlowPlaylistReserveBuildWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
}

export function stopWeeklyFlowPlaylistReserveBuildWorker() {
  stopRequested = true;
  running = false;
}

export function isWeeklyFlowPlaylistReserveBuildWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startWeeklyFlowPlaylistReserveBuildWorker,
  stop: stopWeeklyFlowPlaylistReserveBuildWorker,
  isRunning: isWeeklyFlowPlaylistReserveBuildWorkerRunning,
});
