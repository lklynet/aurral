import path from "node:path";
import * as v from "valibot";
import type { JsonValue } from "@russellthehippo/honker-node";
import { asAppError } from "../../lib/errors.ts";
import createHonkerWorker from "./honkerWorkerFactory.ts";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { enqueueLibraryScanJob, getLibraryScanQueue } from "./honkerDb.ts";
import { isHonkerDatabaseClosedError } from "./honkerWorkerRuntime.ts";
import { resolveLibraryScanChangedPaths, type LibraryScanRequest } from "./libraryScanRequest.ts";
import type { HonkerTaskRunsRow, SettingsRow } from "../db/rows.ts";
import { scheduleReleaseMetadataRefresh } from "./releaseMetadataSync.ts";
import { websocketService } from "./websocketService.ts";

const WORKER_NAME = "library-scan";
const LIBRARY_SCAN_REGISTRY_KEY = "pendingLibraryScanJob";
const MAX_CHANGED_PATHS = 4096;
const scanRegistryValueStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);

export const scanRegistrySchema = v.looseObject({
  jobId: v.nullish(v.number()),
  includeLidarr: v.optional(v.boolean()),
  force: v.optional(v.boolean()),
  changedPaths: v.nullish(v.array(v.string())),
  inFlightActive: v.optional(v.boolean()),
  inFlightPaths: v.nullish(v.array(v.string())),
  fullRescanPending: v.optional(v.boolean()),
});

type ScanRegistry = v.InferOutput<typeof scanRegistrySchema>;
const insertScanRegistryStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
);
const updateScanRegistryStmt = db.prepare(
  "UPDATE settings SET value = ? WHERE key = ? AND value = ?",
);

function getScanRegistrySnapshot(): { value: string | null; registry: ScanRegistry } {
  const value = scanRegistryValueStmt.get(LIBRARY_SCAN_REGISTRY_KEY)?.value ?? null;
  return {
    value,
    registry: dbHelpers.readJSON(scanRegistrySchema, value, LIBRARY_SCAN_REGISTRY_KEY) ?? {},
  };
}

function getScanRegistry() {
  return getScanRegistrySnapshot().registry;
}

function setScanRegistry(registry: ScanRegistry) {
  dbOps.setJSONSetting(LIBRARY_SCAN_REGISTRY_KEY, registry);
}

function setScanRegistryIfUnchanged(
  snapshot: ReturnType<typeof getScanRegistrySnapshot>,
  registry: ScanRegistry,
) {
  const value = dbHelpers.stringifyJSON(registry);
  return snapshot.value === null
    ? insertScanRegistryStmt.run(LIBRARY_SCAN_REGISTRY_KEY, value).changes === 1
    : updateScanRegistryStmt.run(value, LIBRARY_SCAN_REGISTRY_KEY, snapshot.value).changes === 1;
}

function withoutScheduledScan(registry: ScanRegistry) {
  const nextRegistry: ScanRegistry = { ...registry };
  for (const key of [
    "jobId",
    "includeLidarr",
    "force",
    "changedPaths",
    "inFlightActive",
    "inFlightPaths",
    "fullRescanPending",
  ] as const) {
    delete nextRegistry[key];
  }
  return nextRegistry;
}

function normalizeJobId(value: unknown) {
  const jobId = Number(value);
  return Number.isSafeInteger(jobId) && jobId > 0 ? jobId : null;
}

function normalizeChangedPaths(paths: unknown) {
  if (!Array.isArray(paths)) return null;
  const normalized = [
    ...new Set(
      paths
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  ];
  return normalized.length > MAX_CHANGED_PATHS ? null : normalized;
}

const libraryScanSchema = v.looseObject({
  force: v.optional(v.boolean()),
  includeLidarr: v.optional(v.boolean()),
  changedPaths: v.nullish(v.array(v.string())),
});

function readScanRequest(payload: unknown) {
  const request = v.is(libraryScanSchema, payload) ? payload : {};
  return {
    includeLidarr: request.includeLidarr === true,
    force: request.force === true,
    changedPaths: request.changedPaths ?? undefined,
  };
}

function copyRegistryKey<K extends keyof ScanRegistry>(
  from: ScanRegistry,
  to: ScanRegistry,
  key: K,
) {
  if (key in from) to[key] = from[key];
}

function mergeChangedPaths(left: unknown, right: unknown) {
  return normalizeChangedPaths([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]);
}

function hasLiveScanJob(jobId: number) {
  const queue = getLibraryScanQueue();
  const job = queue.getJob(jobId);
  if (!job) return false;
  if (job.state !== "processing") return true;
  const claimExpiresAt = job.claim_expires_at == null ? Number.NaN : Number(job.claim_expires_at);
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
    db.prepare("SELECT 1 FROM library_scan_runs WHERE status = 'complete' LIMIT 1").get(),
  );
}

export function clearScheduledLibraryScan(jobId: number | null = null) {
  while (true) {
    const snapshot = getScanRegistrySnapshot();
    const registry = snapshot.registry;
    if (!("jobId" in registry)) return;
    if (jobId != null && Number(registry.jobId) !== Number(jobId)) return;
    if (setScanRegistryIfUnchanged(snapshot, withoutScheduledScan(registry))) return;
  }
}

export function scheduleLibraryScan(options: LibraryScanRequest = {}) {
  if (Array.isArray(options.changedPaths) && options.changedPaths.length > 0) {
    import("./playlists/playlistManager.ts")
      .then(({ playlistManager }) => playlistManager.schedulePlaybackScan(options.changedPaths!))
      .catch((error) =>
        console.error("[libraryScanWorker] Could not queue media server scan:", error),
      );
  }
  return registerLibraryScan(options);
}

function registerLibraryScan({
  force = false,
  includeLidarr = true,
  changedPaths = null,
}: LibraryScanRequest = {}) {
  const snapshot = getScanRegistrySnapshot();
  const registry = snapshot.registry;
  const requestedPaths = normalizeChangedPaths(changedPaths);
  const fullScanRequested = force === true || requestedPaths === null;
  const existingJobId = normalizeJobId(registry.jobId);
  if (existingJobId != null && hasLiveScanJob(existingJobId)) {
    const updated = db
      .transaction(() => {
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
      })
      .immediate();
    if (updated) return existingJobId;
    return registerLibraryScan({ force, includeLidarr, changedPaths });
  }
  const recoveredPaths =
    registry.inFlightActive === true && Array.isArray(registry.inFlightPaths)
      ? registry.inFlightPaths
      : null;
  const recoveredFullScan =
    registry.inFlightActive === true && !Array.isArray(registry.inFlightPaths);
  const recoveredForce = registry.force === true;
  const mustRunFullScan =
    fullScanRequested || recoveredFullScan || registry.fullRescanPending === true;
  const effectiveForce = force === true || recoveredForce;
  const effectivePaths = mustRunFullScan
    ? null
    : normalizeChangedPaths([
        ...(Array.isArray(recoveredPaths) ? recoveredPaths : []),
        ...(Array.isArray(registry.changedPaths) ? registry.changedPaths : []),
        ...(Array.isArray(requestedPaths) ? requestedPaths : []),
      ]);
  const fullScan = mustRunFullScan || effectivePaths === null;
  const effectiveIncludeLidarr =
    includeLidarr === true || (existingJobId != null && registry.includeLidarr === true);
  const jobId = enqueueLibraryScanJob({
    force: effectiveForce,
    includeLidarr: effectiveIncludeLidarr,
    changedPaths: fullScan ? null : effectivePaths,
  });
  const nextRegistry: ScanRegistry = { jobId, includeLidarr: effectiveIncludeLidarr };
  if (effectiveForce) nextRegistry.force = true;
  if (!fullScan) nextRegistry.changedPaths = effectivePaths;
  if (!setScanRegistryIfUnchanged(snapshot, nextRegistry)) {
    if (getScheduledLibraryScanJobId() === jobId && hasLiveScanJob(jobId)) {
      return registerLibraryScan({ force, includeLidarr, changedPaths });
    }
    getLibraryScanQueue().cancel(jobId);
    return registerLibraryScan({ force, includeLidarr, changedPaths });
  }
  return jobId;
}

export function claimScheduledLibraryScanJob(jobId: unknown, jobPayload: JsonValue = null) {
  const normalizedJobId = normalizeJobId(jobId);
  if (normalizedJobId == null) return false;
  const rawPayload = jobPayload ?? getLibraryScanQueue().getJob(normalizedJobId)?.payload;
  let payload: unknown = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  const request = readScanRequest(payload);
  const scheduledJobId = normalizeJobId(getScanRegistry().jobId);
  if (scheduledJobId != null && scheduledJobId !== normalizedJobId) {
    if (hasLiveScanJob(scheduledJobId)) return false;
  }
  return db
    .transaction(() => {
      const registry = getScanRegistry();
      const currentJobId = normalizeJobId(registry.jobId);
      if (currentJobId !== scheduledJobId && currentJobId !== normalizedJobId) return false;
      const isCurrentJob = currentJobId === normalizedJobId;
      const nextRegistry: ScanRegistry = { jobId: normalizedJobId, includeLidarr: false };
      if (isCurrentJob) {
        nextRegistry.includeLidarr = registry.includeLidarr === true;
        for (const key of [
          "force",
          "changedPaths",
          "inFlightActive",
          "inFlightPaths",
          "fullRescanPending",
        ] as const) {
          copyRegistryKey(registry, nextRegistry, key);
        }
      } else {
        const hasRecoveryState =
          currentJobId != null ||
          Array.isArray(registry.changedPaths) ||
          registry.inFlightActive === true ||
          registry.fullRescanPending === true ||
          registry.force === true;
        nextRegistry.includeLidarr =
          request.includeLidarr || (hasRecoveryState && registry.includeLidarr === true);
        if (request.force || (hasRecoveryState && registry.force === true)) {
          nextRegistry.force = true;
        }
        const oldFullScan =
          hasRecoveryState &&
          (registry.fullRescanPending === true ||
            (registry.inFlightActive === true && !Array.isArray(registry.inFlightPaths)) ||
            (currentJobId != null &&
              registry.inFlightActive !== true &&
              !Array.isArray(registry.changedPaths)));
        if (!oldFullScan && request.changedPaths) {
          nextRegistry.changedPaths = normalizeChangedPaths([
            ...(Array.isArray(registry.inFlightPaths) ? registry.inFlightPaths : []),
            ...(Array.isArray(registry.changedPaths) ? registry.changedPaths : []),
            ...request.changedPaths,
          ]);
        }
      }
      setScanRegistry(nextRegistry);
      return true;
    })
    .immediate();
}

export function onLibraryScanSuccess(_payload: unknown, job: { id: number }) {
  const pending = db
    .transaction(() => {
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
    })
    .immediate();
  if (pending && (pending.fullScan || pending.paths.length > 0)) {
    registerLibraryScan({
      force: pending.force,
      includeLidarr: pending.includeLidarr,
      changedPaths: pending.fullScan ? null : pending.paths,
    });
  }
  scheduleReleaseMetadataRefresh({ delaySeconds: 5 });
}

export function beginLibraryScanJob(jobId: number, payload: unknown) {
  const request = readScanRequest(payload);
  return db
    .transaction(() => {
      const registry = getScanRegistry();
      const isCurrentJob = Number(registry.jobId) === Number(jobId);
      const includeLidarr =
        request.includeLidarr || (isCurrentJob && registry.includeLidarr === true);
      const force = request.force || (isCurrentJob && registry.force === true);
      const interrupted = isCurrentJob && registry.inFlightActive === true;
      const changedPaths =
        interrupted && !force
          ? Array.isArray(registry.inFlightPaths) && Array.isArray(registry.changedPaths)
            ? mergeChangedPaths(registry.inFlightPaths, registry.changedPaths)
            : null
          : resolveLibraryScanChangedPaths(registry, force);
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
    })
    .immediate();
}

export function onLibraryScanFinalFailure(job: { id: number }) {
  clearScheduledLibraryScan(job.id);
}

export function restoreLibraryScanAfterWorkerExit(jobId: number) {
  db.transaction(() => {
    const registry = getScanRegistry();
    if (Number(registry.jobId) !== Number(jobId)) return;
    const active = registry.inFlightActive === true;
    const fullScan =
      registry.fullRescanPending === true ||
      (active && !Array.isArray(registry.inFlightPaths)) ||
      (!active && !("changedPaths" in registry));
    const nextRegistry: ScanRegistry = {
      jobId,
      includeLidarr: registry.includeLidarr === true,
    };
    if (registry.force === true) nextRegistry.force = true;
    if (!fullScan) {
      nextRegistry.changedPaths = mergeChangedPaths(registry.changedPaths, registry.inFlightPaths);
    }
    setScanRegistry(nextRegistry);
  }).immediate();
}

export function getLibraryScanStatus(jobId: string | number) {
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
    .prepare<[number], Pick<HonkerTaskRunsRow, "status" | "error">>(
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
  schema: libraryScanSchema,
  getQueue: getLibraryScanQueue,
  idlePollS: 10,
  retryDelayS: 60,
  filterJob(job) {
    return claimScheduledLibraryScanJob(job.id, job.payload);
  },
  processJob: async (payload, job) => {
    const { lidarrClient } = await import("./lidarrClient.ts");
    const { scanConfiguredLibrary } = await import("./libraryIndexService.ts");
    const { retryPlaybackRetainedFiles } = await import("./playback/playbackFileRetention.ts");
    const { playlistManager } = await import("./playlists/playlistManager.ts");
    const removedRetainedFiles = await retryPlaybackRetainedFiles();
    if (removedRetainedFiles.length > 0) {
      scheduleLibraryScan({ includeLidarr: false, changedPaths: removedRetainedFiles });
    }
    const { includeLidarr, force, changedPaths } = beginLibraryScanJob(job.id, payload);
    const changedFiles = new Set<string>();
    let scanResult;
    try {
      scanResult = await scanConfiguredLibrary({
        lidarrClient,
        includeLidarr,
        changedPaths,
        force,
        changedFiles,
      });
    } finally {
      try {
        playlistManager.schedulePlaybackScan([
          ...new Set([...changedFiles].map((filePath) => path.dirname(filePath))),
        ]);
      } catch (error) {
        console.error("[libraryScanWorker] Could not queue media server scan:", error);
      }
    }
    const { settleIngestedMusic } = await import("./libraryFiles/ingest.ts");
    await settleIngestedMusic();
    const { pruneLibraryArtwork } = await import("./libraryArtwork.ts");
    await pruneLibraryArtwork().catch((error) =>
      console.error("[libraryScanWorker] Could not prune library artwork:", error),
    );
    if (scanResult?.lidarr?.error) {
      throw new Error(`Lidarr library indexing failed: ${scanResult.lidarr.error}`);
    }
    websocketService.broadcast("library", { type: "library_scan_completed" });
  },
  resolveRetry(error, job) {
    const message = asAppError(error)?.message || String(error);
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

export { startLibraryScanWorker, stopLibraryScanWorker, isLibraryScanWorkerRunning };
