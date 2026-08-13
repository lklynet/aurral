import fs from "fs";
import path from "path";
import honker from "@russellthehippo/honker-node";
import { resolveAurralDataDir } from "../config/data-dir.js";

export const HONKER_QUEUE_NAMES = [
  "system-task",
  "weekly-flow-operation",
  "slskd-pipeline",
  "playlist-retry",
  "playlist-reserve-build",
  "playlist-mbid-enrichment",
  "library-scan",
  "discovery-refresh",
  "discovery-playlist-build",
  "discovery-user-refresh",
  "_outbox:notifications",
];

function resolveHonkerDbPath() {
  return process.env.AURRAL_DB_PATH
    ? path.resolve(process.env.AURRAL_DB_PATH)
    : path.join(resolveAurralDataDir(), "aurral.db");
}

let honkerDb = null;
let openedHonkerDbPath = null;
let notificationOutbox = null;
let honkerSchedulerStarted = false;
let honkerSchedulerAbort = null;
let honkerSchedulerPromise = null;
const WORKER_ID = `aurral-${process.pid}`;
const DEFAULT_HONKER_WATCHER_POLL_MS = 25;

export function getHonkerOpenOptions() {
  const configured = Number(process.env.AURRAL_HONKER_WATCHER_POLL_MS);
  const watcherPollIntervalMs = Number.isFinite(configured) && configured > 0
    ? Math.min(1000, Math.max(1, Math.floor(configured)))
    : DEFAULT_HONKER_WATCHER_POLL_MS;
  return { watcherPollIntervalMs };
}

export const SCHEDULED_SYSTEM_TASKS = [
  {
    name: "weekly-flow-refresh",
    queue: "system-task",
    schedule: "@every 1h",
    payload: { kind: "weekly-flow-refresh" },
  },
  {
    name: "session-cleanup",
    queue: "system-task",
    schedule: "@every 1h",
    payload: { kind: "session-cleanup" },
  },
  {
    name: "weekly-flow-reuse-repair",
    queue: "system-task",
    schedule: "@every 30m",
    payload: { kind: "weekly-flow-reuse-repair" },
  },
  {
    name: "quality-upgrade-check",
    queue: "system-task",
    schedule: "@every 1h",
    payload: { kind: "quality-upgrade-check" },
    priority: -10,
  },
  {
    name: "discovery-refresh-check",
    queue: "system-task",
    schedule: "@every 15m",
    payload: { kind: "discovery-refresh-check" },
  },
  {
    name: "inbox-refresh",
    queue: "system-task",
    schedule: "@every 24h",
    payload: { kind: "inbox-refresh" },
  },
  {
    name: "news-refresh",
    queue: "system-task",
    schedule: "@every 15m",
    payload: { kind: "news-refresh" },
  },
  {
    name: "import-list-sync",
    queue: "system-task",
    schedule: "@every 30m",
    payload: { kind: "import-list-sync" },
  },
  {
    name: "playlist-mbid-enrichment-sweep",
    queue: "playlist-mbid-enrichment",
    schedule: "@every 6h",
    payload: { kind: "playlist-mbid-enrichment-sweep", reason: "schedule" },
    maxAttempts: 4,
  },
  {
    name: "library-index-refresh",
    queue: "system-task",
    schedule: "@every 15m",
    payload: { kind: "library-index-refresh" },
  },
];

const PIPELINE_PHASE_PRIORITY = {
  search: 0,
  poll: 10,
  download: 20,
  finalize: 30,
};

export function getPipelinePriorityForPhase(phase) {
  return PIPELINE_PHASE_PRIORITY[String(phase || "").toLowerCase()] ?? 0;
}

export function getHonkerDb() {
  const dbPath = resolveHonkerDbPath();
  if (honkerDb && openedHonkerDbPath !== dbPath) {
    closeHonkerDb();
  }
  if (!honkerDb) {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    honkerDb = honker.open(dbPath, getHonkerOpenOptions());
    openedHonkerDbPath = dbPath;
  }
  return honkerDb;
}

function resolveEnqueueRunAt(options) {
  if (options.runAt != null) return Math.floor(Number(options.runAt) / 1000);
  if (options.delaySeconds != null) return Math.floor(Date.now() / 1000) + Number(options.delaySeconds);
  return null;
}

function createHonkerQueue({
  name,
  visibilityTimeoutS,
  maxAttempts,
  workerModule,
  workerStartFn,
  defaultPriorityFn = (payload, options) => Number(options.priority || 0),
  skipInTest = false,
}) {
  let queue = null;

  function getQueue() {
    if (!queue) {
      queue = getHonkerDb().queue(name, { visibilityTimeoutS, maxAttempts });
    }
    return queue;
  }

  function enqueueJob(payload, options = {}) {
    const q = getQueue();
    const runAt = resolveEnqueueRunAt(options);
    const priority = defaultPriorityFn(payload, options);
    const jobId = q.enqueue(payload, { priority, runAt });
    if (!(skipInTest && process.env.NODE_ENV === "test")) {
      import(workerModule)
        .then((mod) => mod[workerStartFn]())
        .catch((err) => { console.warn(err); });
    }
    return jobId;
  }

  function reset() {
    queue = null;
  }

  return { getQueue, enqueueJob, reset };
}

const queueByName = new Map();
const allQueues = [];

function registerQueue(config) {
  const { getQueue, enqueueJob, reset } = createHonkerQueue(config);
  queueByName.set(config.name, { getQueue, enqueueJob });
  allQueues.push(reset);
  return { getQueue, enqueueJob };
}

const pipeline = registerQueue({
  name: "slskd-pipeline",
  visibilityTimeoutS: 1200,
  maxAttempts: 5,
  workerModule: "./slskdOrchestratorWorker.js",
  workerStartFn: "startSlskdOrchestratorWorker",
  defaultPriorityFn: (payload) =>
    getPipelinePriorityForPhase(payload?.phase) - (payload?.upgrade ? 100 : 0),
});
export const getPipelineQueue = pipeline.getQueue;
export const enqueuePipelineJob = pipeline.enqueueJob;

const discoveryRefresh = registerQueue({
  name: "discovery-refresh",
  visibilityTimeoutS: 3600,
  maxAttempts: 4,
  workerModule: "./discoveryRefreshWorker.js",
  workerStartFn: "startDiscoveryRefreshWorker",
  skipInTest: true,
});
export const getDiscoveryRefreshQueue = discoveryRefresh.getQueue;
export const enqueueDiscoveryRefreshJob = discoveryRefresh.enqueueJob;

const discoveryPlaylistBuild = registerQueue({
  name: "discovery-playlist-build",
  visibilityTimeoutS: 3600,
  maxAttempts: 4,
  workerModule: "./discoveryPlaylistBuildWorker.js",
  workerStartFn: "startDiscoveryPlaylistBuildWorker",
});
export const getDiscoveryPlaylistBuildQueue = discoveryPlaylistBuild.getQueue;
export const enqueueDiscoveryPlaylistBuildJob = discoveryPlaylistBuild.enqueueJob;

const discoveryUserRefresh = registerQueue({
  name: "discovery-user-refresh",
  visibilityTimeoutS: 3600,
  maxAttempts: 4,
  workerModule: "./discoveryUserRefreshWorker.js",
  workerStartFn: "startDiscoveryUserRefreshWorker",
});
export const getDiscoveryUserRefreshQueue = discoveryUserRefresh.getQueue;
export const enqueueDiscoveryUserRefreshJob = discoveryUserRefresh.enqueueJob;

const weeklyFlowOperation = registerQueue({
  name: "weekly-flow-operation",
  visibilityTimeoutS: 3600,
  maxAttempts: 3,
  workerModule: "./weeklyFlow/weeklyFlowOperationWorker.js",
  workerStartFn: "startWeeklyFlowOperationWorker",
});

export const getWeeklyFlowOperationQueue = weeklyFlowOperation.getQueue;
export const enqueueWeeklyFlowOperationJob = weeklyFlowOperation.enqueueJob;

const playlistRetry = registerQueue({
  name: "playlist-retry",
  visibilityTimeoutS: 1800,
  maxAttempts: 5,
  workerModule: "./weeklyFlow/weeklyFlowPlaylistRetryWorker.js",
  workerStartFn: "startWeeklyFlowPlaylistRetryWorker",
});
export const getPlaylistRetryQueue = playlistRetry.getQueue;
export const enqueuePlaylistRetryJob = playlistRetry.enqueueJob;

const playlistReserveBuild = registerQueue({
  name: "playlist-reserve-build",
  visibilityTimeoutS: 1800,
  maxAttempts: 4,
  workerModule: "./weeklyFlow/weeklyFlowPlaylistReserveBuildWorker.js",
  workerStartFn: "startWeeklyFlowPlaylistReserveBuildWorker",
});

export const getPlaylistReserveBuildQueue = playlistReserveBuild.getQueue;

const playlistMbidEnrichment = registerQueue({
  name: "playlist-mbid-enrichment",
  visibilityTimeoutS: 3600,
  maxAttempts: 4,
  workerModule: "./playlistMbidEnrichmentWorker.js",
  workerStartFn: "startPlaylistMbidEnrichmentWorker",
});

export const getPlaylistMbidEnrichmentQueue = playlistMbidEnrichment.getQueue;
export const enqueuePlaylistMbidEnrichmentJob = playlistMbidEnrichment.enqueueJob;

const systemTask = registerQueue({
  name: "system-task",
  visibilityTimeoutS: 3600,
  maxAttempts: 3,
  workerModule: "./systemTaskWorker.js",
  workerStartFn: "startSystemTaskWorker",
});

export const getSystemTaskQueue = systemTask.getQueue;
export const enqueueSystemTaskJob = systemTask.enqueueJob;

const libraryScan = registerQueue({
  name: "library-scan",
  visibilityTimeoutS: 600,
  maxAttempts: 3,
  workerModule: "./libraryScanWorker.js",
  workerStartFn: "startLibraryScanWorker",
});

export const getLibraryScanQueue = libraryScan.getQueue;
export const enqueueLibraryScanJob = libraryScan.enqueueJob;

export function getNotificationOutbox() {
  if (!notificationOutbox) {
    notificationOutbox = getHonkerDb().outbox(
      "notifications",
      async (payload, job) => {
        const { deliverQueuedNotification } = await import("./notificationService.js");
        const { withJobHeartbeat } = await import("./honkerWorkerRuntime.js");
        const outbox = getNotificationOutbox();
        await withJobHeartbeat(job, outbox.queue, () => deliverQueuedNotification(payload));
      },
      {
        visibilityTimeoutS: 120,
        maxAttempts: 5,
        baseBackoffS: 30,
      },
    );
  }
  return notificationOutbox;
}

export function enqueueNotification(payload) {
  const jobId = getNotificationOutbox().enqueue(payload);
  import("./notificationOutboxWorker.js")
    .then(({ startNotificationOutboxWorker }) =>
      startNotificationOutboxWorker(),
    )
    .catch((err) => { console.warn(err); });  return jobId;
}

export function bootstrapHonkerSchedules() {
  const scheduler = getHonkerDb().scheduler();
  const canonicalByName = new Map(SCHEDULED_SYSTEM_TASKS.map((task) => [task.name, task]));
  const existingByName = new Map(scheduler.list().map((row) => [row.name, row]));

  for (const row of existingByName.values()) {
    if (!canonicalByName.has(row.name)) {
      scheduler.remove(row.name);
    }
  }

  for (const task of SCHEDULED_SYSTEM_TASKS) {
    const existing = existingByName.get(task.name);
    if (!existing) {
      scheduler.add(task);
      continue;
    }

    const priority = Number(task.priority ?? 0);
    const expiresS = task.expiresS ?? null;
    const maxAttempts = Number(task.maxAttempts ?? 3);
    const payloadText = JSON.stringify(task.payload ?? null);

    // Queue changes require re-registration. Other fields can use the
    // supported update API so an unchanged schedule keeps next_fire_at.
    if (existing.queue !== task.queue) {
      scheduler.remove(task.name);
      scheduler.add(task);
      continue;
    }

    const updates = {};
    if (existing.cron_expr !== task.schedule) updates.schedule = task.schedule;
    if (existing.payload !== payloadText) updates.payload = task.payload;
    if (Number(existing.priority) !== priority) updates.priority = priority;
    if ((existing.expires_s ?? null) !== expiresS) updates.expiresS = expiresS;
    if (Number(existing.max_attempts ?? 3) !== maxAttempts) {
      updates.maxAttempts = maxAttempts;
    }
    if (Object.keys(updates).length > 0) {
      scheduler.update(task.name, updates);
    }
    if (existing.enabled === false) {
      scheduler.resume(task.name);
    }
  }
}

export function enqueueHonkerStartupTasks() {
  enqueueSystemTaskJob({ kind: "playlist-startup-migration" }, { delaySeconds: 3, priority: 10 });
  enqueueSystemTaskJob({ kind: "weekly-flow-startup-check" }, { delaySeconds: 5, priority: 5 });
  enqueueSystemTaskJob({ kind: "quality-profile-refresh" }, { delaySeconds: 10, priority: -10 });
  enqueueSystemTaskJob(
    { kind: "weekly-flow-startup-reuse-repair" },
    { delaySeconds: 15, priority: 5 },
  );
  enqueueSystemTaskJob({ kind: "discovery-bootstrap" }, { delaySeconds: 15, priority: 5 });
  enqueueSystemTaskJob({ kind: "inbox-refresh" }, { delaySeconds: 20, priority: -5 });
  enqueueSystemTaskJob({ kind: "library-index-refresh" }, { delaySeconds: 8, priority: 0 });
  enqueuePlaylistMbidEnrichmentJob(
    {
      kind: "playlist-mbid-enrichment-sweep",
      reason: "startup",
      reconcileArtistMbids: true,
    },
    { delaySeconds: 30, priority: -5 },
  );
}

export function startHonkerScheduler() {
  if (honkerSchedulerStarted || process.env.NODE_ENV === "test") return;
  honkerSchedulerStarted = true;
  const abort = new AbortController();
  honkerSchedulerAbort = abort;
  const runPromise = getHonkerDb()
    .scheduler()
    .run(WORKER_ID, abort.signal);
  honkerSchedulerPromise = runPromise;
  void runPromise
    .catch(async (error) => {
      console.error("[honkerScheduler] loop error:", error);
      honkerSchedulerStarted = false;
      honkerSchedulerAbort = null;
      const { scheduleHonkerComponentRestart } = await import("./honkerWorkerRuntime.js");
      scheduleHonkerComponentRestart("scheduler", startHonkerScheduler);
    })
    .finally(() => {
      if (honkerSchedulerPromise === runPromise) {
        honkerSchedulerPromise = null;
      }
    });
}

export function stopHonkerScheduler() {
  const running = honkerSchedulerPromise;
  honkerSchedulerAbort?.abort();
  honkerSchedulerAbort = null;
  honkerSchedulerStarted = false;
  return running || Promise.resolve();
}

export function closeHonkerDb() {
  stopHonkerScheduler();
  if (honkerDb) {
    try {
      honkerDb.close();
    } catch {}
  }
  honkerDb = null;
  openedHonkerDbPath = null;
  for (const reset of allQueues) {
    reset();
  }
  notificationOutbox = null;
}

export function isHonkerLockHeld(name) {
  const probeOwner = `probe-${WORKER_ID}-${Date.now()}`;
  const lock = getHonkerDb().tryLock(String(name || "").trim(), probeOwner, 1);
  if (lock) {
    try {
      lock.release();
    } catch {}
    return false;
  }
  return true;
}

const inProcessLockTails = new Map();

export async function withHonkerLock(
  name,
  fn,
  { ttlSeconds = 120, waitTimeoutMs = 300000, retryDelayMs = 250 } = {},
) {
  const safeName = String(name || "").trim();
  if (!safeName) {
    throw new Error("Honker lock name is required");
  }
  const deadline = Date.now() + Math.max(0, Number(waitTimeoutMs) || 0);

  const previousTail = inProcessLockTails.get(safeName) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const tail = previousTail.then(() => gate);
  inProcessLockTails.set(safeName, tail);

  try {
    const gateAcquired = await Promise.race([
      previousTail.then(() => true),
      new Promise((resolve) => {
        const waitMs = Math.max(0, deadline - Date.now());
        const timer = setTimeout(() => resolve(false), waitMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (!gateAcquired) {
      throw new Error(`Timed out waiting for Honker lock: ${safeName}`);
    }

    let lock = null;
    while (!lock) {
      lock = getHonkerDb().tryLock(safeName, WORKER_ID, ttlSeconds);
      if (lock) break;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Honker lock: ${safeName}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(50, Number(retryDelayMs) || 250)),
      );
    }

    const heartbeatMs = Math.max(1000, Math.floor((Number(ttlSeconds) || 120) * 1000 * 0.33));
    const heartbeat = setInterval(() => {
      try {
        lock.heartbeat(ttlSeconds);
      } catch {}
    }, heartbeatMs);

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      try {
        lock.release();
      } catch {}
    }
  } finally {
    releaseGate();
    if (inProcessLockTails.get(safeName) === tail) {
      inProcessLockTails.delete(safeName);
    }
  }
}

export function getWorkerId() {
  return WORKER_ID;
}

export function getHonkerQueueDepth(queueName) {
  const safeQueue = String(queueName || "").trim();
  if (!safeQueue) return 0;
  const now = Math.floor(Date.now() / 1000);
  const row = getHonkerDb().query(
    `SELECT COUNT(*) AS count
     FROM _honker_live
     WHERE queue = ?
       AND state = 'pending'
       AND run_at <= ?`,
    [safeQueue, now],
  )[0];
  return Number(row?.count) || 0;
}

export function sweepAllHonkerQueues() {
  let swept = 0;
  for (const queueName of HONKER_QUEUE_NAMES) {
    const queue = getHonkerQueueByName(queueName);
    if (!queue) continue;
    try {
      swept += Number(queue.sweepExpired()) || 0;
    } catch {}
  }
  return swept;
}

export function getHonkerQueueByName(queueName) {
  if (queueName === "_outbox:notifications") {
    return getNotificationOutbox().queue;
  }
  return queueByName.get(queueName)?.getQueue() ?? null;
}

export function getHonkerQueueNextClaimAt(queueName) {
  const safeQueue = String(queueName || "").trim();
  if (!safeQueue) return null;
  const queue = getHonkerQueueByName(safeQueue);
  const value = queue && typeof queue._nextClaimAt === "function" ? queue._nextClaimAt() : null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}
