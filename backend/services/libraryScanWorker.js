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

// A job that has started already read its registry entry, so later requests
// must not merge into it (they would be dropped when it finishes).
function isScanJobRunning(jobId) {
  return getLibraryScanQueue().getJob(jobId)?.state === "processing";
}

export function getScheduledLibraryScanJobId() {
  return normalizeJobId(getScanRegistry().jobId);
}

export function hasCompletedLibraryScan() {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM library_scan_runs WHERE status = 'complete' AND source != 'lidarr-artist' LIMIT 1",
      )
      .get(),
  );
}

export function clearScheduledLibraryScan(jobId = null) {
  const registry = getScanRegistry();
  if (!("jobId" in registry)) return;
  if (jobId != null && Number(registry.jobId) !== Number(jobId)) return;
  delete registry.jobId;
  delete registry.includeLidarr;
  delete registry.artistIds;
  delete registry.force;
  setScanRegistry(registry);
}

const normalizeArtistIds = (value) => [
  ...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => Number(entry))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0),
  ),
];

const registryEntry = (jobId, includeLidarr, artistIds = null, force = false) => {
  const entry = { jobId, includeLidarr: includeLidarr === true };
  const scoped = normalizeArtistIds(artistIds);
  if (scoped.length) entry.artistIds = scoped;
  if (force === true) entry.force = true;
  return entry;
};

// One pending scan job at a time. `artistIds` requests a Lidarr re-index
// scoped to those artists; scoped requests merge into a queued scoped job, and
// any unscoped request upgrades a queued scoped job to a full scan. A request
// that arrives while the pending job is already running gets a fresh job, so
// nothing asked for after the running scan captured its options is lost.
export function scheduleLibraryScan({ force = false, includeLidarr = true, artistIds = null } = {}) {
  const registry = getScanRegistry();
  const existingJobId = normalizeJobId(registry.jobId);
  const scoped = normalizeArtistIds(artistIds);
  const pendingScope = normalizeArtistIds(registry.artistIds);
  if (existingJobId != null && hasLiveScanJob(existingJobId) && !isScanJobRunning(existingJobId)) {
    // A forced request (manual refresh) turns the pending job into a forced
    // full scan, which disables the unchanged-artist skip.
    const pendingForce = registry.force === true || force === true;
    if (force === true && registry.force !== true) {
      setScanRegistry(registryEntry(existingJobId, true, null, true));
    } else if (scoped.length && pendingScope.length) {
      const merged = [...new Set([...pendingScope, ...scoped])];
      if (merged.length !== pendingScope.length) {
        setScanRegistry(registryEntry(existingJobId, true, merged, pendingForce));
      }
    } else if (pendingScope.length) {
      setScanRegistry(registryEntry(existingJobId, true, null, pendingForce));
    } else if ((includeLidarr === true || scoped.length) && registry.includeLidarr !== true) {
      setScanRegistry(registryEntry(existingJobId, true, null, pendingForce));
    }
    return existingJobId;
  }
  if (existingJobId != null) clearScheduledLibraryScan(existingJobId);
  const payload = { force: force === true, includeLidarr: includeLidarr === true || scoped.length > 0 };
  if (scoped.length) payload.artistIds = scoped;
  const jobId = enqueueLibraryScanJob(payload);
  setScanRegistry(registryEntry(jobId, payload.includeLidarr, scoped, force));
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
  const owned = Number(registry.jobId) === normalizedJobId;
  setScanRegistry(registryEntry(
    normalizedJobId,
    owned && registry.includeLidarr === true,
    owned ? registry.artistIds : null,
    owned && registry.force === true,
  ));
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
    const { runLibraryScanInWorker } = await import("./libraryScanRunner.js");
    const registry = getScanRegistry();
    const owned = Number(registry.jobId) === Number(job.id);
    const includeLidarr =
      payload?.includeLidarr === true || (owned && registry.includeLidarr === true);
    // The registry is the merged, upgradable view of this job; the payload is
    // only the fallback when the registry no longer points at it.
    const artistIds = owned
      ? normalizeArtistIds(registry.artistIds)
      : normalizeArtistIds(payload?.artistIds);
    const force = payload?.force === true || (owned && registry.force === true);
    await runLibraryScanInWorker({ includeLidarr, artistIds, force });
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
    // A newer job may own the registry by now; its entry must survive.
    if (Number(registry.jobId) === Number(job.id)) {
      setScanRegistry(registryEntry(
        job.id,
        registry.includeLidarr === true,
        registry.artistIds,
        registry.force === true,
      ));
    }
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
