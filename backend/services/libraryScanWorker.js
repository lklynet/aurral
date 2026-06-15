import { dbOps } from "../config/db-helpers.js";
import { enqueueLibraryScanJob, getLibraryScanQueue, getWorkerId } from "./honkerDb.js";
import {
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";

const WORKER_NAME = "library-scan";
const LIBRARY_SCAN_REGISTRY_KEY = "pendingLibraryScanJob";
const SCAN_DEBOUNCE_SECONDS = 30;

function getScanRegistry() {
  const raw = dbOps.getJSONSetting(LIBRARY_SCAN_REGISTRY_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function setScanRegistry(registry) {
  dbOps.setJSONSetting(LIBRARY_SCAN_REGISTRY_KEY, registry);
}

export function getScheduledLibraryScanJobId() {
  const jobId = Number(getScanRegistry().jobId);
  return Number.isFinite(jobId) ? jobId : null;
}

export function clearScheduledLibraryScan(jobId = null) {
  const registry = getScanRegistry();
  if (!("jobId" in registry)) return;
  if (jobId != null && Number(registry.jobId) !== Number(jobId)) return;
  delete registry.jobId;
  setScanRegistry(registry);
}

export function scheduleLibraryScan(force = false) {
  if (force) {
    clearScheduledLibraryScan();
    const jobId = enqueueLibraryScanJob(
      { force: true, requestedAt: Date.now() },
      { priority: 10 },
    );
    setScanRegistry({ jobId });
    return jobId;
  }
  if (getScheduledLibraryScanJobId() != null) {
    return getScheduledLibraryScanJobId();
  }
  const jobId = enqueueLibraryScanJob(
    { force: false, requestedAt: Date.now() },
    { delaySeconds: SCAN_DEBOUNCE_SECONDS },
  );
  setScanRegistry({ jobId });
  return jobId;
}

let running = false;
let stopRequested = false;
let loopPromise = null;

async function runLoop() {
  const queue = getLibraryScanQueue();
  const workerId = getWorkerId();
  try {
    for await (const job of queue.claim(workerId, { idlePollS: 10 })) {
      if (!running || stopRequested) break;
      const scheduledJobId = getScheduledLibraryScanJobId();
      if (scheduledJobId != null && scheduledJobId !== job.id) {
        job.ack();
        continue;
      }
      clearScheduledLibraryScan(job.id);
      try {
        await withJobHeartbeat(job, queue, async () => {
          const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
          await playlistManager.scanLibrary();
        });
        job.ack();
      } catch (error) {
        const message = error?.message || String(error);
        if (job.attempts >= 3) {
          job.fail(message);
        } else {
          setScanRegistry({ jobId: job.id });
          job.retry(60, message);
        }
      }
    }
  } catch (error) {
    console.error("[libraryScanWorker] loop error:", error);
  } finally {
    running = false;
    loopPromise = null;
    const intentional = stopRequested;
    stopRequested = false;
    markHonkerWorkerLoopEnded(WORKER_NAME, startLibraryScanWorker, {
      intentional,
    });
  }
}

export function startLibraryScanWorker() {
  if (running || isHonkerShuttingDown()) return;
  running = true;
  stopRequested = false;
  loopPromise = runLoop();
}

export function stopLibraryScanWorker() {
  stopRequested = true;
  running = false;
}

export function isLibraryScanWorkerRunning() {
  return running;
}

registerHonkerWorker(WORKER_NAME, {
  start: startLibraryScanWorker,
  stop: stopLibraryScanWorker,
  isRunning: isLibraryScanWorkerRunning,
});
