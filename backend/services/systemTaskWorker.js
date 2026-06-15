import { getSystemTaskQueue, getWorkerId } from "./honkerDb.js";
import { cleanExpiredSessions } from "../config/session-helpers.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "system-task";

let running = false;
let stopRequested = false;
let loopPromise = null;

async function processSystemTask(payload = {}) {
  const kind = String(payload?.kind || "").trim();
  switch (kind) {
    case "weekly-flow-refresh": {
      const { runScheduledRefresh } = await import("./weeklyFlowScheduler.js");
      await runScheduledRefresh();
      return;
    }
    case "session-cleanup":
      cleanExpiredSessions();
      return;
    case "weekly-flow-reuse-repair": {
      const { weeklyFlowWorker } = await import("./weeklyFlowWorker.js");
      weeklyFlowWorker.scheduleReuseLinkRepair(false);
      return;
    }
    case "weekly-flow-startup-reuse-repair": {
      const { weeklyFlowWorker } = await import("./weeklyFlowWorker.js");
      weeklyFlowWorker.scheduleReuseLinkRepair(true);
      return;
    }
    case "discovery-refresh-check": {
      const { enqueueDiscoveryRefreshIfNeeded } = await import(
        "./discoveryRefreshScheduler.js"
      );
      await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });
      return;
    }
    case "weekly-flow-startup-check": {
      const { startWorkerIfPending } = await import("./weeklyFlowScheduler.js");
      await startWorkerIfPending();
      return;
    }
    case "discovery-bootstrap": {
      const { bootstrapDiscoveryRefresh } = await import(
        "./discoveryRefreshScheduler.js"
      );
      await bootstrapDiscoveryRefresh();
      return;
    }
    case "playlist-startup-migration": {
      const [
        { migrateLegacyWeeklyFlowPaths, resolveWeeklyFlowRoot },
        trackerModule,
        { playlistManager },
      ] = await Promise.all([
        import("./weeklyFlowPaths.js"),
        import("./weeklyFlowDownloadTracker.js"),
        import("./weeklyFlowPlaylistManager.js"),
      ]);
      const result = await migrateLegacyWeeklyFlowPaths(
        resolveWeeklyFlowRoot(),
        trackerModule.downloadTracker,
      );
      if (result.migrated > 0) {
        console.log(
          `[Playlists] Migrated ${result.migrated} legacy track paths to ${resolveWeeklyFlowRoot()}`,
        );
      }
      playlistManager.updateConfig(false);
      await playlistManager.ensurePlaylists();
      await playlistManager.scheduleScanLibrary(true);
      return;
    }
    case "lidarr-retry": {
      const { libraryManager } = await import("./libraryManager.js");
      await libraryManager.getAllArtists();
      return;
    }
    default:
      throw new Error(`Unknown system task: ${kind || "unknown"}`);
  }
}

async function runLoop() {
  const queue = getSystemTaskQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 10 })) {
      if (!running || stopRequested) break;
      try {
        await withJobHeartbeat(job, queue, () => processSystemTask(job.payload));
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
    console.error("[systemTaskWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startSystemTaskWorker, {
      intentional,
    });
  }
}

export function startSystemTaskWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
}

export function stopSystemTaskWorker() {
  stopRequested = true;
  running = false;
}

export function isSystemTaskWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startSystemTaskWorker,
  stop: stopSystemTaskWorker,
  isRunning: isSystemTaskWorkerRunning,
});
