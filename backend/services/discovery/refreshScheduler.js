import { dbOps } from "../../db/helpers/index.js";
import { getMusicDataSourceName } from "../musicDataSource/index.js";
import {
  enqueueDiscoveryRefreshJob,
  getHonkerDb,
  getDiscoveryRefreshQueue,
  isHonkerLockHeld,
} from "../honkerDb.js";
import { websocketService } from "../websocketService.js";
import { getDiscoveryAutoRefreshHours, getDiscoveryCache } from "./index.js";
import { markDiscoveryRefreshRequested, markInterruptedDiscoveryRefresh } from "./persistence.js";

const DISCOVERY_GLOBAL_REFRESH_LOCK = "discovery-global-refresh";

function isWorkerAlive(workerId) {
  const match = /^aurral-(\d+)$/.exec(String(workerId || ""));
  if (!match) return true;
  try {
    process.kill(Number(match[1]), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function recoverDeadDiscoveryRefresh() {
  const honker = getHonkerDb();
  let liveRows;
  let lockRows;
  try {
    liveRows = honker.query(`
      SELECT id, worker_id
      FROM _honker_live
      WHERE queue = 'discovery-refresh'
        AND state = 'processing'
    `);
    lockRows = honker.query(
      "SELECT owner FROM _honker_locks WHERE name = ?",
      [DISCOVERY_GLOBAL_REFRESH_LOCK],
    );
  } catch {
    return false;
  }

  const deadJobs = liveRows.filter((row) => !isWorkerAlive(row.worker_id));
  const deadLocks = lockRows.filter((row) => !isWorkerAlive(row.owner));
  if (!deadJobs.length && !deadLocks.length) return false;

  const queue = getDiscoveryRefreshQueue();
  for (const row of deadJobs) {
    try {
      queue.cancel(row.id);
    } catch {}
  }
  if (deadJobs.length) {
    markInterruptedDiscoveryRefresh("Discovery refresh was interrupted", {
      clearPending: !hasQueuedDiscoveryRefresh(),
    });
  }
  for (const row of deadLocks) {
    const tx = honker.transaction();
    try {
      tx.query(
        "SELECT honker_lock_release(?, ?)",
        [DISCOVERY_GLOBAL_REFRESH_LOCK, row.owner],
      );
      tx.commit();
    } catch {
      try { tx.rollback(); } catch {}
    }
  }
  return true;
}

function parseQueuedPayload(payload) {
  try {
    return JSON.parse(String(payload || "{}"));
  } catch {
    return {};
  }
}

function getPendingScheduledDiscoveryRefresh() {
  try {
    const rows = getHonkerDb().query(
      `
        SELECT id, payload, run_at
        FROM _honker_live
        WHERE queue = 'discovery-refresh'
          AND state = 'pending'
          AND run_at > ?
        ORDER BY run_at ASC, id ASC
      `,
      [Math.floor(Date.now() / 1000)],
    );
    return (
      rows.find((row) => {
        const payload = parseQueuedPayload(row.payload);
        return payload?.scheduleOnly === true && String(payload?.reason || "") === "scheduled";
      }) || null
    );
  } catch {
    return null;
  }
}

export function pruneDuplicateScheduledDiscoveryRefreshes() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = getHonkerDb().query(
      `
        SELECT id, payload, run_at
        FROM _honker_live
        WHERE queue = 'discovery-refresh'
          AND state = 'pending'
          AND run_at > ?
        ORDER BY run_at ASC, id ASC
      `,
      [now],
    );
    const scheduled = rows.filter((row) => {
      const payload = parseQueuedPayload(row.payload);
      return payload?.scheduleOnly === true && String(payload?.reason || "") === "scheduled";
    });
    if (scheduled.length <= 1) return 0;
    const removeIds = scheduled.slice(1).map((row) => row.id);
    const queue = getDiscoveryRefreshQueue();
    let removed = 0;
    for (const id of removeIds) {
      if (queue.cancel(id)) removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

function hasQueuedDiscoveryRefresh() {
  const now = Math.floor(Date.now() / 1000);
  const rows = getHonkerDb().query(
    "SELECT payload, state, run_at FROM _honker_live WHERE queue = 'discovery-refresh' AND state IN ('pending', 'processing')",
  );
  return rows.some((row) => {
    if (row.state === "processing") return true;
    const payload = parseQueuedPayload(row.payload);
    return payload.scheduleOnly !== true || Number(row.run_at) <= now;
  });
}

export function discoveryNeedsRefresh(cache = dbOps.getDiscoveryCache()) {
  if (cache?.provider && cache.provider !== getMusicDataSourceName()) return true;
  const refreshHours = getDiscoveryAutoRefreshHours();
  const staleCutoff = Date.now() - refreshHours * 60 * 60 * 1000;
  const lastUpdatedAt = new Date(cache?.lastUpdated || "").getTime();
  if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt < staleCutoff) {
    return true;
  }
  const hasRecommendations =
    Array.isArray(cache?.recommendations) && cache.recommendations.length > 0;
  const hasGlobalTop = Array.isArray(cache?.globalTop) && cache.globalTop.length > 0;
  return !hasRecommendations && !hasGlobalTop;
}

function markDiscoveryQueued(reason) {
  markDiscoveryRefreshRequested();
  websocketService.emitDiscoveryUpdate({
    isUpdating: true,
    configured: true,
    phase: "queued",
    progressMessage: "Discovery refresh queued",
    reason,
  });
}

export function enqueueDiscoveryRefresh(options = {}) {
  const {
    force = false,
    reason = "manual",
    runAt = null,
    delaySeconds = null,
    scheduleOnly = false,
  } = options;
  if (!scheduleOnly && force) {
    recoverDeadDiscoveryRefresh();
  }

  if (!scheduleOnly) {
    if (isHonkerLockHeld(DISCOVERY_GLOBAL_REFRESH_LOCK)) {
      if (force) {
        return { enqueued: true, reason: "already_updating" };
      }
      return { enqueued: false, reason: "updating" };
    }
    if (!force && hasQueuedDiscoveryRefresh()) {
      return { enqueued: false, reason: "queued" };
    }
  }

  if (scheduleOnly && reason === "scheduled" && getPendingScheduledDiscoveryRefresh()) {
    return { enqueued: false, reason: "already_scheduled" };
  }
  enqueueDiscoveryRefreshJob(
    {
      reason,
      requestedAt: Date.now(),
      scheduleOnly: scheduleOnly === true,
    },
    { runAt, delaySeconds },
  );
  if (!scheduleOnly) markDiscoveryQueued(reason);
  return { enqueued: true, reason };
}

export function scheduleNextDiscoveryRefresh() {
  pruneDuplicateScheduledDiscoveryRefreshes();
  const cache = dbOps.getDiscoveryCache();
  const refreshMs = getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;
  const base = cache.lastUpdated ? new Date(cache.lastUpdated).getTime() : Date.now();
  const runAtMs = base + refreshMs;
  if (runAtMs <= Date.now()) {
    return enqueueDiscoveryRefresh({ reason: "scheduled" });
  }
  return enqueueDiscoveryRefresh({
    reason: "scheduled",
    runAt: runAtMs,
    scheduleOnly: true,
  });
}

export async function enqueueDiscoveryRefreshIfNeeded(options = {}) {
  if (!options.force && !discoveryNeedsRefresh()) {
    return { enqueued: false, reason: "fresh" };
  }
  return enqueueDiscoveryRefresh(options);
}

export async function bootstrapDiscoveryRefresh() {
  recoverDeadDiscoveryRefresh();

  const result = await enqueueDiscoveryRefreshIfNeeded({ reason: "startup" });
  if (result.reason === "fresh") {
    const latest = getDiscoveryCache();
    console.log(
      `Discovery cache is fresh (last updated ${latest.lastUpdated}). Scheduling next refresh.`,
    );
    scheduleNextDiscoveryRefresh();
    return;
  }
  if (result.enqueued) {
    console.log("Discovery cache needs update. Queued refresh.");
  }
}
