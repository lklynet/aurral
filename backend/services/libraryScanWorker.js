import path from "node:path";
import createHonkerWorker from "./honkerWorkerFactory.js";
import { db, dbHelpers } from "../config/db-sqlite.js";
import { dbOps } from "../db/helpers/index.js";
import { enqueueLibraryScanJob, getLibraryScanQueue } from "./honkerDb.js";
import { isHonkerDatabaseClosedError } from "./honkerWorkerRuntime.js";
import { resolveLibraryScanChangedPaths } from "./libraryScanRequest.js";
import { websocketService } from "./websocketService.js";

const WORKER_NAME = "library-scan";
const LIBRARY_SCAN_REGISTRY_KEY = "pendingLibraryScanJob";
const MAX_CHANGED_PATHS = 4096;
const scanRegistryValueStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const insertScanRegistryStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
);
const updateScanRegistryStmt = db.prepare(
  "UPDATE settings SET value = ? WHERE key = ? AND value = ?",
);

function getScanRegistrySnapshot() {
  const value = scanRegistryValueStmt.get(LIBRARY_SCAN_REGISTRY_KEY)?.value ?? null;
  const raw = dbHelpers.parseJSON(value);
  return {
    value,
    registry: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {},
  };
}

function getScanRegistry() {
  return getScanRegistrySnapshot().registry;
}

function setScanRegistry(registry) {
  dbOps.setJSONSetting(LIBRARY_SCAN_REGISTRY_KEY, registry);
}

function setScanRegistryIfUnchanged(snapshot, registry) {
  const value = dbHelpers.stringifyJSON(registry);
  return snapshot.value === null
    ? insertScanRegistryStmt.run(LIBRARY_SCAN_REGISTRY_KEY, value).changes === 1
    : updateScanRegistryStmt.run(value, LIBRARY_SCAN_REGISTRY_KEY, snapshot.value).changes === 1;
}

function withoutScheduledScan(registry) {
  const nextRegistry = { ...registry };
  for (const key of [
    "jobId", "includeLidarr", "force", "changedPaths", "inFlightActive",
    "inFlightPaths", "fullRescanPending",
  ]) {
    delete nextRegistry[key];
  }
  return nextRegistry;
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
  while (true) {
    const snapshot = getScanRegistrySnapshot();
    const registry = snapshot.registry;
    if (!("jobId" in registry)) return;
    if (jobId != null && Number(registry.jobId) !== Number(jobId)) return;
    if (setScanRegistryIfUnchanged(snapshot, withoutScheduledScan(registry))) return;
  }
}

export function scheduleLibraryScan({
  force = false,
  includeLidarr = true,
  changedPaths = null,
} = {}) {
  const snapshot = getScanRegistrySnapshot();
  const registry = snapshot.registry;
  const requestedPaths = normalizeChangedPaths(changedPaths);
  const fullScanRequested = force === true || requestedPaths === null;
  const existingJobId = normalizeJobId(registry.jobId);
  if (existingJobId != null && hasLiveScanJob(existingJobId)) {
    const updated = db.transaction(() => {
      const current = getScanRegistry();
      if (normalizeJobId(current.jobId) !== existingJobId) return false;
      const nextRegistry = { ...current };
      if (includeLidarr === true) nextRegistry.includeLidarr = true;
      if (force === true) nextRegistry.force = true;
      if (current.inFlightActive === true) {
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
      return true;
    }).immediate();
    if (updated) return existingJobId;
    return scheduleLibraryScan({ force, includeLidarr, changedPaths });
  }
  const recoveredPaths = registry.inFlightActive === true && Array.isArray(registry.inFlightPaths)
    ? registry.inFlightPaths
    : null;
  const recoveredFullScan = registry.inFlightActive === true && !Array.isArray(registry.inFlightPaths);
  const recoveredForce = registry.force === true;
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
  if (!setScanRegistryIfUnchanged(snapshot, nextRegistry)) {
    getLibraryScanQueue().cancel(jobId);
    return scheduleLibraryScan({ force, includeLidarr, changedPaths });
  }
  return jobId;
}

export function claimScheduledLibraryScanJob(jobId) {
  const normalizedJobId = normalizeJobId(jobId);
  if (normalizedJobId == null) return false;
  const scheduledJobId = normalizeJobId(getScanRegistry().jobId);
  if (scheduledJobId != null && scheduledJobId !== normalizedJobId) {
    if (hasLiveScanJob(scheduledJobId)) return false;
  }
  return db.transaction(() => {
    const registry = getScanRegistry();
    const currentJobId = normalizeJobId(registry.jobId);
    if (currentJobId !== scheduledJobId && currentJobId !== normalizedJobId) return false;
    const isCurrentJob = currentJobId === normalizedJobId;
    const nextRegistry = {
      jobId: normalizedJobId,
      includeLidarr: isCurrentJob && registry.includeLidarr === true,
    };
    if (isCurrentJob) {
      for (const key of ["force", "changedPaths", "inFlightActive", "inFlightPaths", "fullRescanPending"]) {
        if (key in registry) nextRegistry[key] = registry[key];
      }
    }
    setScanRegistry(nextRegistry);
    return true;
  }).immediate();
}

export function onLibraryScanSuccess(_payload, job) {
  const pending = db.transaction(() => {
    const registry = getScanRegistry();
    if (Number(registry.jobId) !== Number(job.id)) return null;
    const result = {
      fullScan: registry.fullRescanPending === true,
      paths: Array.isArray(registry.changedPaths) ? registry.changedPaths : [],
      includeLidarr: registry.includeLidarr === true,
      force: registry.force === true,
    };
    setScanRegistry(withoutScheduledScan(registry));
    return result;
  }).immediate();
  if (pending && (pending.fullScan || pending.paths.length > 0)) {
    scheduleLibraryScan({
      force: pending.force,
      includeLidarr: pending.includeLidarr,
      changedPaths: pending.fullScan ? null : pending.paths,
    });
  }
}

export function beginLibraryScanJob(jobId, payload) {
  return db.transaction(() => {
    const registry = getScanRegistry();
    const isCurrentJob = Number(registry.jobId) === Number(jobId);
    const includeLidarr = payload?.includeLidarr === true ||
      (isCurrentJob && registry.includeLidarr === true);
    const force = payload?.force === true ||
      (isCurrentJob && registry.force === true);
    const changedPaths = resolveLibraryScanChangedPaths(registry, force);
    if (isCurrentJob) {
      setScanRegistry({
        ...registry,
        changedPaths: [],
        inFlightActive: true,
        inFlightPaths: changedPaths,
        fullRescanPending: false,
      });
    }
    return { includeLidarr, force, changedPaths };
  }).immediate();
}

export function onLibraryScanFinalFailure(job) {
  clearScheduledLibraryScan(job.id);
}

export function restoreLibraryScanAfterWorkerExit(jobId) {
  db.transaction(() => {
    const registry = getScanRegistry();
    if (Number(registry.jobId) !== Number(jobId)) return;
    const active = registry.inFlightActive === true;
    const fullScan = registry.fullRescanPending === true ||
      (active && !Array.isArray(registry.inFlightPaths)) ||
      (!active && !("changedPaths" in registry));
    const nextRegistry = {
      jobId,
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
  }).immediate();
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
    const { includeLidarr, force, changedPaths } = beginLibraryScanJob(job.id, payload);
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
    restoreLibraryScanAfterWorkerExit(job.id);
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
