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

function normalizeJobId(value) {
  const jobId = Number(value);
  return Number.isSafeInteger(jobId) && jobId > 0 ? jobId : null;
}

function hasLiveScanJob(jobId) {
  return Boolean(getLibraryScanQueue().getJob(jobId));
}

export function getScheduledLibraryScanJobId() {
  return normalizeJobId(getScanRegistry().jobId);
}

export function hasCompletedLibraryScan() {
  return Boolean(
    db
      .prepare("SELECT 1 FROM library_scan_runs WHERE status = 'complete' LIMIT 1")
      .get(),
  );
}

export function clearScheduledLibraryScan(jobId = null) {
  const registry = getScanRegistry();
  if (!("jobId" in registry)) return;
  if (jobId != null && Number(registry.jobId) !== Number(jobId)) return;
  delete registry.jobId;
  delete registry.includeLidarr;
  setScanRegistry(registry);
}

export function scheduleLibraryScan({ force = false, includeLidarr = true } = {}) {
  const registry = getScanRegistry();
  const existingJobId = normalizeJobId(registry.jobId);
  if (existingJobId != null && hasLiveScanJob(existingJobId)) {
    if (includeLidarr === true && registry.includeLidarr !== true) {
      setScanRegistry({ jobId: existingJobId, includeLidarr: true });
    }
    return existingJobId;
  }
  if (existingJobId != null) clearScheduledLibraryScan(existingJobId);
  const jobId = enqueueLibraryScanJob({
    force: force === true,
    includeLidarr: includeLidarr === true,
  });
  setScanRegistry({ jobId, includeLidarr: includeLidarr === true });
  return jobId;
}

export function claimScheduledLibraryScanJob(jobId) {
  const normalizedJobId = normalizeJobId(jobId);
  if (normalizedJobId == null) return false;
  const registry = getScanRegistry();
  const scheduledJobId = getScheduledLibraryScanJobId();
  if (scheduledJobId != null && scheduledJobId !== normalizedJobId) {
    if (hasLiveScanJob(scheduledJobId)) return false;
    clearScheduledLibraryScan(scheduledJobId);
  }
  setScanRegistry({
    jobId: normalizedJobId,
    includeLidarr:
      Number(registry.jobId) === normalizedJobId && registry.includeLidarr === true,
  });
  return true;
}

export function onLibraryScanSuccess(_payload, job) {
  clearScheduledLibraryScan(job.id);
}

export function onLibraryScanFinalFailure(job) {
  clearScheduledLibraryScan(job.id);
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
    return claimScheduledLibraryScanJob(job.id);
  },
  processJob: async (payload, job) => {
    const { lidarrClient } = await import("./lidarrClient.js");
    const { scanConfiguredLibrary } = await import("./libraryIndexService.js");
    const registry = getScanRegistry();
    const includeLidarr =
      payload?.includeLidarr === true ||
      (Number(registry.jobId) === Number(job.id) && registry.includeLidarr === true);
    await scanConfiguredLibrary({ lidarrClient, includeLidarr });
    const { playlistManager } = await import("./weeklyFlow/weeklyFlowPlaylistManager.js");
    await playlistManager.scanLibrary();
    websocketService.broadcast("library", { type: "library_scan_completed" });
  },
  resolveRetry(error, job) {
    const message = error?.message || String(error);
    if (job.attempts >= 3) {
      return { action: "fail", message };
    }
    setScanRegistry({
      jobId: job.id,
      includeLidarr: getScanRegistry().includeLidarr === true,
    });
    return { action: "retry", delayS: 60, message };
  },
  onJobSuccess: onLibraryScanSuccess,
  onFinalFailure: onLibraryScanFinalFailure,
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
