import fs from "fs";
import path from "path";
import honker from "@russellthehippo/honker-node";
import { resolveAurralDataDir } from "../config/data-dir.js";
import { scheduleHonkerComponentRestart } from "./honkerWorkerRuntime.js";

function resolveHonkerDbPath() {
  return process.env.AURRAL_DB_PATH
    ? path.resolve(process.env.AURRAL_DB_PATH)
    : path.join(resolveAurralDataDir(), "aurral.db");
}

let honkerDb = null;
let openedHonkerDbPath = null;
let pipelineQueue = null;
let discoveryRefreshQueue = null;
let discoveryPlaylistBuildQueue = null;
let discoveryUserRefreshQueue = null;
let weeklyFlowOperationQueue = null;
let playlistRetryQueue = null;
let playlistReserveBuildQueue = null;
let systemTaskQueue = null;
let libraryScanQueue = null;
let imagePrefetchQueue = null;
let notificationOutbox = null;
let honkerSchedulerStarted = false;
let honkerSchedulerAbort = null;
const WORKER_ID = `aurral-${process.pid}`;

const SCHEDULED_SYSTEM_TASKS = [
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
    name: "discovery-refresh-check",
    queue: "system-task",
    schedule: "@every 15m",
    payload: { kind: "discovery-refresh-check" },
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
    honkerDb = honker.open(dbPath);
    openedHonkerDbPath = dbPath;
  }
  return honkerDb;
}

export function getPipelineQueue() {
  if (!pipelineQueue) {
    pipelineQueue = getHonkerDb().queue("slskd-pipeline", {
      visibilityTimeoutS: 1200,
      maxAttempts: 5,
    });
  }
  return pipelineQueue;
}

export function enqueuePipelineJob(payload, options = {}) {
  const queue = getPipelineQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const priority =
    options.priority != null
      ? Number(options.priority)
      : getPipelinePriorityForPhase(payload?.phase);
  const jobId = queue.enqueue(payload, {
    priority,
    runAt,
  });
  import("./slskdOrchestratorWorker.js")
    .then(({ startSlskdOrchestratorWorker }) => startSlskdOrchestratorWorker())
    .catch(() => {});
  return jobId;
}

export function getDiscoveryRefreshQueue() {
  if (!discoveryRefreshQueue) {
    discoveryRefreshQueue = getHonkerDb().queue("discovery-refresh", {
      visibilityTimeoutS: 3600,
      maxAttempts: 4,
    });
  }
  return discoveryRefreshQueue;
}

export function enqueueDiscoveryRefreshJob(payload, options = {}) {
  const queue = getDiscoveryRefreshQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  if (process.env.NODE_ENV !== "test") {
    import("./discoveryRefreshWorker.js")
      .then(({ startDiscoveryRefreshWorker }) => startDiscoveryRefreshWorker())
      .catch(() => {});
  }
  return jobId;
}

export function getDiscoveryPlaylistBuildQueue() {
  if (!discoveryPlaylistBuildQueue) {
    discoveryPlaylistBuildQueue = getHonkerDb().queue(
      "discovery-playlist-build",
      {
        visibilityTimeoutS: 3600,
        maxAttempts: 4,
      },
    );
  }
  return discoveryPlaylistBuildQueue;
}

export function enqueueDiscoveryPlaylistBuildJob(payload, options = {}) {
  const queue = getDiscoveryPlaylistBuildQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./discoveryPlaylistBuildWorker.js")
    .then(({ startDiscoveryPlaylistBuildWorker }) =>
      startDiscoveryPlaylistBuildWorker(),
    )
    .catch(() => {});
  return jobId;
}

export function getDiscoveryUserRefreshQueue() {
  if (!discoveryUserRefreshQueue) {
    discoveryUserRefreshQueue = getHonkerDb().queue("discovery-user-refresh", {
      visibilityTimeoutS: 3600,
      maxAttempts: 4,
    });
  }
  return discoveryUserRefreshQueue;
}

export function enqueueDiscoveryUserRefreshJob(payload, options = {}) {
  const queue = getDiscoveryUserRefreshQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./discoveryUserRefreshWorker.js")
    .then(({ startDiscoveryUserRefreshWorker }) =>
      startDiscoveryUserRefreshWorker(),
    )
    .catch(() => {});
  return jobId;
}

export function getWeeklyFlowOperationQueue() {
  if (!weeklyFlowOperationQueue) {
    weeklyFlowOperationQueue = getHonkerDb().queue("weekly-flow-operation", {
      visibilityTimeoutS: 3600,
      maxAttempts: 3,
    });
  }
  return weeklyFlowOperationQueue;
}

export function enqueueWeeklyFlowOperationJob(payload, options = {}) {
  const queue = getWeeklyFlowOperationQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./weeklyFlowOperationWorker.js")
    .then(({ startWeeklyFlowOperationWorker }) =>
      startWeeklyFlowOperationWorker(),
    )
    .catch(() => {});
  return jobId;
}

export function getPlaylistRetryQueue() {
  if (!playlistRetryQueue) {
    playlistRetryQueue = getHonkerDb().queue("playlist-retry", {
      visibilityTimeoutS: 1800,
      maxAttempts: 5,
    });
  }
  return playlistRetryQueue;
}

export function enqueuePlaylistRetryJob(payload, options = {}) {
  const queue = getPlaylistRetryQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./weeklyFlowPlaylistRetryWorker.js")
    .then(({ startWeeklyFlowPlaylistRetryWorker }) =>
      startWeeklyFlowPlaylistRetryWorker(),
    )
    .catch(() => {});
  return jobId;
}

export function getPlaylistReserveBuildQueue() {
  if (!playlistReserveBuildQueue) {
    playlistReserveBuildQueue = getHonkerDb().queue("playlist-reserve-build", {
      visibilityTimeoutS: 1800,
      maxAttempts: 4,
    });
  }
  return playlistReserveBuildQueue;
}

export function enqueuePlaylistReserveBuildJob(payload, options = {}) {
  const queue = getPlaylistReserveBuildQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./weeklyFlowPlaylistReserveBuildWorker.js")
    .then(({ startWeeklyFlowPlaylistReserveBuildWorker }) =>
      startWeeklyFlowPlaylistReserveBuildWorker(),
    )
    .catch(() => {});
  return jobId;
}

export function getSystemTaskQueue() {
  if (!systemTaskQueue) {
    systemTaskQueue = getHonkerDb().queue("system-task", {
      visibilityTimeoutS: 3600,
      maxAttempts: 3,
    });
  }
  return systemTaskQueue;
}

export function enqueueSystemTaskJob(payload, options = {}) {
  const queue = getSystemTaskQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./systemTaskWorker.js")
    .then(({ startSystemTaskWorker }) => startSystemTaskWorker())
    .catch(() => {});
  return jobId;
}

export function getLibraryScanQueue() {
  if (!libraryScanQueue) {
    libraryScanQueue = getHonkerDb().queue("library-scan", {
      visibilityTimeoutS: 600,
      maxAttempts: 3,
    });
  }
  return libraryScanQueue;
}

export function enqueueLibraryScanJob(payload = {}, options = {}) {
  const queue = getLibraryScanQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./libraryScanWorker.js")
    .then(({ startLibraryScanWorker }) => startLibraryScanWorker())
    .catch(() => {});
  return jobId;
}

export function getImagePrefetchQueue() {
  if (!imagePrefetchQueue) {
    imagePrefetchQueue = getHonkerDb().queue("image-prefetch", {
      visibilityTimeoutS: 600,
      maxAttempts: 4,
    });
  }
  return imagePrefetchQueue;
}

export function enqueueImagePrefetchJob(payload, options = {}) {
  const queue = getImagePrefetchQueue();
  const runAt =
    options.runAt != null
      ? Math.floor(Number(options.runAt) / 1000)
      : options.delaySeconds != null
        ? Math.floor(Date.now() / 1000) + Number(options.delaySeconds)
        : null;
  const jobId = queue.enqueue(payload, {
    priority: Number(options.priority || 0),
    runAt,
  });
  import("./imagePrefetchWorker.js")
    .then(({ startImagePrefetchWorker }) => startImagePrefetchWorker())
    .catch(() => {});
  return jobId;
}

export function getNotificationOutbox() {
  if (!notificationOutbox) {
    notificationOutbox = getHonkerDb().outbox(
      "notifications",
      async (payload, job) => {
        const { deliverQueuedNotification } =
          await import("./notificationService.js");
        const { withJobHeartbeat } = await import("./honkerWorkerRuntime.js");
        const outbox = getNotificationOutbox();
        await withJobHeartbeat(job, outbox.queue, () =>
          deliverQueuedNotification(payload),
        );
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
    .catch(() => {});
  return jobId;
}

export function bootstrapHonkerSchedules() {
  const scheduler = getHonkerDb().scheduler();
  for (const task of SCHEDULED_SYSTEM_TASKS) {
    try {
      scheduler.remove(task.name);
    } catch {}
    scheduler.add(task);
  }
}

export function enqueueHonkerStartupTasks() {
  enqueueSystemTaskJob(
    { kind: "playlist-startup-migration" },
    { delaySeconds: 3, priority: 10 },
  );
  enqueueSystemTaskJob(
    { kind: "weekly-flow-startup-check" },
    { delaySeconds: 5, priority: 5 },
  );
  enqueueSystemTaskJob(
    { kind: "weekly-flow-startup-reuse-repair" },
    { delaySeconds: 15, priority: 5 },
  );
  enqueueSystemTaskJob(
    { kind: "discovery-bootstrap" },
    { delaySeconds: 15, priority: 5 },
  );
}

export function startHonkerScheduler() {
  if (honkerSchedulerStarted || process.env.NODE_ENV === "test") return;
  honkerSchedulerStarted = true;
  const abort = new AbortController();
  honkerSchedulerAbort = abort;
  getHonkerDb()
    .scheduler()
    .run(WORKER_ID, abort.signal)
    .catch((error) => {
      console.error("[honkerScheduler] loop error:", error);
      honkerSchedulerStarted = false;
      honkerSchedulerAbort = null;
      scheduleHonkerComponentRestart("scheduler", startHonkerScheduler);
    });
}

export function stopHonkerScheduler() {
  if (!honkerSchedulerAbort) return;
  honkerSchedulerAbort.abort();
  honkerSchedulerAbort = null;
  honkerSchedulerStarted = false;
}

export function closeHonkerDb() {
  stopHonkerScheduler();
  if (discoveryRefreshQueueLock) {
    try {
      discoveryRefreshQueueLock.release();
    } catch {}
    discoveryRefreshQueueLock = null;
  }
  if (honkerDb) {
    try {
      honkerDb.close();
    } catch {}
  }
  honkerDb = null;
  openedHonkerDbPath = null;
  pipelineQueue = null;
  discoveryRefreshQueue = null;
  discoveryPlaylistBuildQueue = null;
  discoveryUserRefreshQueue = null;
  weeklyFlowOperationQueue = null;
  playlistRetryQueue = null;
  playlistReserveBuildQueue = null;
  systemTaskQueue = null;
  libraryScanQueue = null;
  imagePrefetchQueue = null;
  notificationOutbox = null;
}

const DISCOVERY_REFRESH_QUEUE_LOCK = "discovery-refresh-queue";

let discoveryRefreshQueueLock = null;

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

export function tryAcquireDiscoveryRefreshQueueLock() {
  if (discoveryRefreshQueueLock) return true;
  const lock = getHonkerDb().tryLock(
    DISCOVERY_REFRESH_QUEUE_LOCK,
    WORKER_ID,
    3600,
  );
  if (!lock) return false;
  discoveryRefreshQueueLock = lock;
  return true;
}

export function releaseDiscoveryRefreshQueueLock() {
  if (!discoveryRefreshQueueLock) return;
  try {
    discoveryRefreshQueueLock.release();
  } catch {}
  discoveryRefreshQueueLock = null;
}

export function isDiscoveryRefreshQueueLocked() {
  return (
    discoveryRefreshQueueLock != null ||
    isHonkerLockHeld(DISCOVERY_REFRESH_QUEUE_LOCK)
  );
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

    const heartbeatMs = Math.max(
      1000,
      Math.floor((Number(ttlSeconds) || 120) * 1000 * 0.33),
    );
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
