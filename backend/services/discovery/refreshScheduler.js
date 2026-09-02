import { dbOps } from "../../db/helpers/index.js";
import { getLastfmApiKey } from "../apiClients/index.js";
import { getCanonicalArtistProjection } from "../libraryQueryService.js";
import {
  enqueueDiscoveryRefreshJob,
  getHonkerDb,
  getDiscoveryRefreshQueue,
  isHonkerLockHeld,
} from "../honkerDb.js";
import {
  clearDiscoveryUpdateProgress,
  getDiscoveryAutoRefreshHours,
  getDiscoveryCache,
  recordDiscoveryUpdateProgress,
} from "./index.js";

const DISCOVERY_GLOBAL_REFRESH_LOCK = "discovery-global-refresh";

let discoveryRefreshQueued = false;

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

export function markDiscoveryRefreshDequeued() {
  discoveryRefreshQueued = false;
}

export async function isDiscoveryRefreshConfigured() {
  const hasLastfm = !!getLastfmApiKey();
  if (hasLastfm) return true;
  return getCanonicalArtistProjection({ page: 1, pageSize: 1 }).length > 0;
}

function hasDiscoverySeedArtists() {
  try {
    return getCanonicalArtistProjection({ page: 1, pageSize: 1 }).length > 0;
  } catch {
    return true;
  }
}

export function discoveryNeedsRefresh(cache = getDiscoveryCache()) {
  const lastUpdated = cache?.lastUpdated;
  const hasRecommendations =
    Array.isArray(cache?.recommendations) && cache.recommendations.length > 0;
  const hasGlobalTop =
    Array.isArray(cache?.globalTop) && cache.globalTop.length > 0;
  const hasGenres = Array.isArray(cache?.topGenres) && cache.topGenres.length > 0;
  const refreshHours = getDiscoveryAutoRefreshHours();
  const staleCutoff = Date.now() - refreshHours * 60 * 60 * 1000;
  const lastUpdatedAt = new Date(lastUpdated || "").getTime();
  if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt < staleCutoff) {
    return true;
  }
  if (!hasRecommendations && !hasGlobalTop) {
    return true;
  }
  // Recommendations and genres are seeded from library artists, so with an
  // empty library a completed refresh legitimately leaves them empty and
  // retrying cannot fill them — treating that as stale would re-run the
  // refresh on every scheduled check (#763).
  return !hasGenres && hasDiscoverySeedArtists();
}

function emitDiscoveryQueued(reason) {
  recordDiscoveryUpdateProgress("queued", "Discovery refresh queued", 1, { reason });
}

export function enqueueDiscoveryRefresh(options = {}) {
  const {
    force = false,
    reason = "manual",
    runAt = null,
    delaySeconds = null,
    scheduleOnly = false,
  } = options;
  const cache = getDiscoveryCache();

  if (!scheduleOnly && force && recoverDeadDiscoveryRefresh()) {
    discoveryRefreshQueued = false;
    cache.isUpdating = false;
    clearDiscoveryUpdateProgress();
  }

  if (!scheduleOnly) {
    if (isHonkerLockHeld(DISCOVERY_GLOBAL_REFRESH_LOCK)) {
      if (force) {
        return { enqueued: true, reason: "already_updating" };
      }
      return { enqueued: false, reason: "updating" };
    }
    if (!force && discoveryRefreshQueued) {
      return { enqueued: false, reason: "queued" };
    }
    discoveryRefreshQueued = true;
    if (!cache.isUpdating) {
      cache.isUpdating = true;
      emitDiscoveryQueued(reason);
    }
  }

  try {
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
  } catch (error) {
    if (!scheduleOnly) {
      discoveryRefreshQueued = false;
      cache.isUpdating = false;
    }
    throw error;
  }
  return { enqueued: true, reason };
}

export function scheduleNextDiscoveryRefresh() {
  pruneDuplicateScheduledDiscoveryRefreshes();
  const cache = getDiscoveryCache();
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
  if (!(await isDiscoveryRefreshConfigured())) {
    return { enqueued: false, reason: "not_configured" };
  }
  if (!options.force && !discoveryNeedsRefresh()) {
    return { enqueued: false, reason: "fresh" };
  }
  return enqueueDiscoveryRefresh(options);
}

export async function bootstrapDiscoveryRefresh() {
  recoverDeadDiscoveryRefresh();
  const cache = getDiscoveryCache();
  if (
    !isHonkerLockHeld("discovery-global-refresh") &&
    !discoveryRefreshQueued
  ) {    cache.isUpdating = false;
    clearDiscoveryUpdateProgress();
  }

  if (!(await isDiscoveryRefreshConfigured())) {
    console.log("Discovery not configured (no Last.fm API key and no artists). Clearing cache.");
    try {
      dbOps.updateDiscoveryCache({
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
      });
      Object.assign(getDiscoveryCache(), {
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
        isUpdating: false,
      });
    } catch (error) {
      console.error("Failed to clear discovery cache:", error.message);
    }
    return;
  }

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
