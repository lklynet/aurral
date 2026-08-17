import createHonkerWorker from "./honkerWorkerFactory.js";
import { db } from "../config/db-sqlite.js";
import { dbOps } from "../db/helpers/index.js";
import { enqueueLibraryScanJob, getLibraryScanQueue } from "./honkerDb.js";
import { isHonkerDatabaseClosedError } from "./honkerWorkerRuntime.js";
import { websocketService } from "./websocketService.js";

const WORKER_NAME = "library-scan";
const LIBRARY_SCAN_REGISTRY_KEY = "pendingLibraryScanJob";

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

export function scheduleLibraryScan({ force = false } = {}) {
  const registry = getScanRegistry();
  const existingJobId = Number(registry.jobId);
  if (Number.isFinite(existingJobId)) {
    return existingJobId;
  }
  const jobId = enqueueLibraryScanJob({ force: force === true });
  setScanRegistry({ jobId });
  return jobId;
}

export function getLibraryScanStatus(jobId) {
  const normalizedJobId = Number(jobId);
  if (!Number.isSafeInteger(normalizedJobId) || normalizedJobId <= 0) return null;

  const job = getLibraryScanQueue().getJob(normalizedJobId);
  if (job) {
    return {
      jobId: normalizedJobId,
      status: job.state === "processing" ? "running" : "queued",
      error: null,
    };
  }

  const run = db
    .prepare(
      `SELECT status, error
       FROM honker_task_runs
       WHERE queue = 'library-scan' AND job_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(normalizedJobId);
  if (!run) return { jobId: normalizedJobId, status: "unknown", error: null };
  return {
    jobId: normalizedJobId,
    status: run.status === "failed" ? "failed" : "completed",
    error: run.error || null,
  };
}

let databaseClosed = false;

const {
  start: startLibraryScanWorker,
  stop: stopLibraryScanWorker,
  isRunning: isLibraryScanWorkerRunning,
} = createHonkerWorker({
  name: WORKER_NAME,
  getQueue: getLibraryScanQueue,
  idlePollS: 10,
  retryDelayS: 60,
  filterJob(job) {
    const scheduledJobId = getScheduledLibraryScanJobId();
    if (scheduledJobId != null && scheduledJobId !== job.id) {
      return false;
    }
    clearScheduledLibraryScan(job.id);
    return true;
  },
  processJob: async () => {
    const { lidarrClient } = await import("./lidarrClient.js");
    const { scanConfiguredLibrary } = await import("./libraryIndexService.js");
    await scanConfiguredLibrary({ lidarrClient });
    const { playlistManager } = await import("./weeklyFlow/weeklyFlowPlaylistManager.js");
    await playlistManager.scanLibrary();
    websocketService.broadcast("library", { type: "library_scan_completed" });
  },
  resolveRetry(error, job) {
    const message = error?.message || String(error);
    if (job.attempts >= 3) {
      return { action: "fail", message };
    }
    setScanRegistry({ jobId: job.id });
    return { action: "retry", delayS: 60, message };
  },
  onLoopError(error) {
    databaseClosed = isHonkerDatabaseClosedError(error);
    if (!databaseClosed) {
      console.error("[libraryScanWorker] loop error:", error);
    }
  },
});

export {
  startLibraryScanWorker,
  stopLibraryScanWorker,
  isLibraryScanWorkerRunning,
};
