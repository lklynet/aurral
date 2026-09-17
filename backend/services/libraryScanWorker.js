import path from "node:path";
import createHonkerWorker from "./honkerWorkerFactory.js";
import { db } from "../config/db-sqlite.js";
import { dbOps } from "../db/helpers/index.js";
import { enqueueLibraryScanJob, getLibraryScanQueue } from "./honkerDb.js";
import { isHonkerDatabaseClosedError } from "./honkerWorkerRuntime.js";
import { resolveLibraryScanChangedPaths } from "./libraryScanRequest.js";
import { websocketService } from "./websocketService.js";

const WORKER_NAME = "library-scan";
const LIBRARY_SCAN_REGISTRY_KEY = "pendingLibraryScanJob";
const MAX_CHANGED_PATHS = 4096;

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

function normalizeChangedPaths(paths) {
  if (!Array.isArray(paths)) return null;
  const normalized = [...new Set(
    paths
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value)),
  )];
  return normalized.length > MAX_CHANGED_PATHS ? null : normalized;
}

function mergeChangedPaths(left, right) {
  return normalizeChangedPaths([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]);
}

function hasLiveScanJob(jobId) {
  const queue = getLibraryScanQueue();
  const job = queue.getJob(jobId);
  if (!job) return false;
  if (job.state !== "processing") return true;
  const claimExpiresAt = Number(job.claim_expires_at ?? job.claimExpiresAt);
  if (!Number.isFinite(claimExpiresAt) || claimExpiresAt > Math.floor(Date.now() / 1000)) {
    return true;
  }
  queue.cancel(jobId);
  return false;
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
  delete registry.force;
  delete registry.changedPaths;
  delete registry.inFlightActive;
  delete registry.inFlightPaths;
  delete registry.fullRescanPending;
  setScanRegistry(registry);
}

export function scheduleLibraryScan({
  force = false,
  includeLidarr = true,
  changedPaths = null,
} = {}) {
  const registry = getScanRegistry();
  const requestedPaths = normalizeChangedPaths(changedPaths);
  const fullScanRequested = force === true || requestedPaths === null;
  const existingJobId = normalizeJobId(registry.jobId);
  if (existingJobId != null && hasLiveScanJob(existingJobId)) {
    const nextRegistry = { ...registry };
    if (includeLidarr === true) nextRegistry.includeLidarr = true;
    if (force === true) nextRegistry.force = true;
    if (registry.inFlightActive === true) {
      if (fullScanRequested) {
        nextRegistry.changedPaths = [];
        nextRegistry.fullRescanPending = true;
      } else if (nextRegistry.fullRescanPending !== true) {
        const mergedPaths = mergeChangedPaths(nextRegistry.changedPaths, requestedPaths);
        if (mergedPaths === null) {
          nextRegistry.changedPaths = [];
          nextRegistry.fullRescanPending = true;
        } else {
          nextRegistry.changedPaths = mergedPaths;
        }
      }
    } else if (fullScanRequested) {
      delete nextRegistry.changedPaths;
    } else if (Array.isArray(nextRegistry.changedPaths)) {
      const mergedPaths = mergeChangedPaths(nextRegistry.changedPaths, requestedPaths);
      if (mergedPaths === null) delete nextRegistry.changedPaths;
      else nextRegistry.changedPaths = mergedPaths;
    }
    setScanRegistry(nextRegistry);
    return existingJobId;
  }
  const recoveredPaths = registry.inFlightActive === true && Array.isArray(registry.inFlightPaths)
    ? registry.inFlightPaths
    : null;
  const recoveredFullScan = registry.inFlightActive === true && !Array.isArray(registry.inFlightPaths);
  const recoveredForce = registry.force === true;
  if (existingJobId != null) clearScheduledLibraryScan(existingJobId);
  const mustRunFullScan = fullScanRequested ||
    recoveredFullScan ||
    registry.fullRescanPending === true;
  const effectiveForce = force === true || recoveredForce;
  const effectivePaths = mustRunFullScan
    ? null
    : normalizeChangedPaths([
        ...(Array.isArray(recoveredPaths) ? recoveredPaths : []),
        ...(Array.isArray(registry.changedPaths) ? registry.changedPaths : []),
        ...(Array.isArray(requestedPaths) ? requestedPaths : []),
      ]);
  const fullScan = mustRunFullScan || effectivePaths === null;
  const jobId = enqueueLibraryScanJob({
    force: effectiveForce,
    includeLidarr: includeLidarr === true,
  });
  const nextRegistry = { jobId, includeLidarr: includeLidarr === true };
  if (effectiveForce) nextRegistry.force = true;
  if (!fullScan) nextRegistry.changedPaths = effectivePaths;
  setScanRegistry(nextRegistry);
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
  const nextRegistry = {
    jobId: normalizedJobId,
    includeLidarr:
      Number(registry.jobId) === normalizedJobId && registry.includeLidarr === true,
  };
  if (Number(registry.jobId) === normalizedJobId) {
    for (const key of ["force", "changedPaths", "inFlightActive", "inFlightPaths", "fullRescanPending"]) {
      if (key in registry) nextRegistry[key] = registry[key];
    }
  }
  setScanRegistry(nextRegistry);
  return true;
}

export function onLibraryScanSuccess(_payload, job) {
  const registry = getScanRegistry();
  if (Number(registry.jobId) !== Number(job.id)) return;
  const pendingFullScan = registry.fullRescanPending === true;
  const pendingPaths = Array.isArray(registry.changedPaths) ? registry.changedPaths : [];
  const includeLidarr = registry.includeLidarr === true;
  const force = registry.force === true;
  clearScheduledLibraryScan(job.id);
  if (pendingFullScan || pendingPaths.length > 0) {
    scheduleLibraryScan({
      force,
      includeLidarr,
      changedPaths: pendingFullScan ? null : pendingPaths,
    });
  }
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
    const { retryPlaybackRetainedFiles } = await import("./playback/playbackFileRetention.js");
    await retryPlaybackRetainedFiles();
    const registry = getScanRegistry();
    const includeLidarr =
      payload?.includeLidarr === true ||
      (Number(registry.jobId) === Number(job.id) && registry.includeLidarr === true);
    const force = payload?.force === true ||
      (Number(registry.jobId) === Number(job.id) && registry.force === true);
    const changedPaths = resolveLibraryScanChangedPaths(registry, force);
    if (Number(registry.jobId) === Number(job.id)) {
      setScanRegistry({
        ...registry,
        changedPaths: [],
        inFlightActive: true,
        inFlightPaths: changedPaths,
        fullRescanPending: false,
      });
    }
    const scanResult = await scanConfiguredLibrary({
      lidarrClient,
      includeLidarr,
      changedPaths,
      force,
    });
    if (scanResult?.lidarr?.error) {
      throw new Error(`Lidarr library indexing failed: ${scanResult.lidarr.error}`);
    }
    const { playlistManager } = await import("./weeklyFlow/weeklyFlowPlaylistManager.js");
    await playlistManager.scanLibrary();
    websocketService.broadcast("library", { type: "library_scan_completed" });
  },
  resolveRetry(error, job) {
    const message = error?.message || String(error);
    if (job.attempts >= 3) {
      return { action: "fail", message };
    }
    const registry = getScanRegistry();
    const active = registry.inFlightActive === true;
    const fullScan = registry.fullRescanPending === true ||
      (active && !Array.isArray(registry.inFlightPaths)) ||
      (!active && !("changedPaths" in registry));
    const nextRegistry = {
      jobId: job.id,
      includeLidarr: registry.includeLidarr === true,
    };
    if (registry.force === true) nextRegistry.force = true;
    if (!fullScan) {
      nextRegistry.changedPaths = mergeChangedPaths(
        registry.changedPaths,
        registry.inFlightPaths,
      );
    }
    setScanRegistry(nextRegistry);
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
