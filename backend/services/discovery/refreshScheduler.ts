import { dbOps } from "../../db/helpers/index.ts";
import { getMusicDataSourceName } from "../musicDataSource/index.ts";
import { isLockHeld } from "../jobs/queue.ts";
import { discoveryRefreshQueue } from "../jobs/queues.ts";
import { websocketService } from "../websocketService.ts";
import { DISCOVERY_REFRESH_MS, getDiscoveryCache } from "./index.ts";
import { markDiscoveryRefreshRequested } from "./persistence.ts";

type EnqueueDiscoveryRefreshOptions = {
  force?: boolean;
  reason?: string;
  runAt?: number | null;
  delaySeconds?: number | null;
  scheduleOnly?: boolean;
};

const DISCOVERY_GLOBAL_REFRESH_LOCK = "discovery-global-refresh";

function hasQueuedDiscoveryRefresh(now = Date.now()) {
  return discoveryRefreshQueue
    .list()
    .some(
      (row) => row.state === "running" || row.payload?.scheduleOnly !== true || row.run_at <= now,
    );
}

export function discoveryNeedsRefresh(
  cache: Partial<ReturnType<typeof dbOps.getDiscoveryCache>> = dbOps.getDiscoveryCache(),
) {
  if (cache?.provider && cache.provider !== getMusicDataSourceName()) return true;
  const staleCutoff = Date.now() - DISCOVERY_REFRESH_MS;
  const lastUpdatedAt = new Date(cache?.lastUpdated || "").getTime();
  if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt < staleCutoff) {
    return true;
  }
  const hasRecommendations =
    Array.isArray(cache?.recommendations) && cache.recommendations.length > 0;
  const hasGlobalTop = Array.isArray(cache?.globalTop) && cache.globalTop.length > 0;
  return !hasRecommendations && !hasGlobalTop;
}

function markDiscoveryQueued(reason: string) {
  markDiscoveryRefreshRequested();
  websocketService.emitDiscoveryUpdate({
    isUpdating: true,
    configured: true,
    phase: "queued",
    progressMessage: "Discovery refresh queued",
    reason,
  });
}

export function enqueueDiscoveryRefresh(options: EnqueueDiscoveryRefreshOptions = {}) {
  const {
    force = false,
    reason = "manual",
    runAt = null,
    delaySeconds = null,
    scheduleOnly = false,
  } = options;
  if (!scheduleOnly) {
    if (isLockHeld(DISCOVERY_GLOBAL_REFRESH_LOCK)) {
      if (force) {
        return { enqueued: true, reason: "already_updating" };
      }
      return { enqueued: false, reason: "updating" };
    }
    if (!force && hasQueuedDiscoveryRefresh()) {
      return { enqueued: false, reason: "queued" };
    }
  }

  const payload = { reason, requestedAt: Date.now(), scheduleOnly };
  discoveryRefreshQueue.enqueue(payload, {
    runAt,
    delayMs: delaySeconds == null ? null : delaySeconds * 1000,
    mergeInto: (waiting) =>
      scheduleOnly && waiting.scheduleOnly === true && waiting.reason === reason ? payload : null,
  });
  if (!scheduleOnly) markDiscoveryQueued(reason);
  return { enqueued: true, reason };
}

export function scheduleNextDiscoveryRefresh() {
  const cache = dbOps.getDiscoveryCache();
  const base = cache.lastUpdated ? new Date(cache.lastUpdated).getTime() : Date.now();
  const runAtMs = base + DISCOVERY_REFRESH_MS;
  if (runAtMs <= Date.now()) {
    return enqueueDiscoveryRefresh({ reason: "scheduled" });
  }
  return enqueueDiscoveryRefresh({
    reason: "scheduled",
    runAt: runAtMs,
    scheduleOnly: true,
  });
}

export async function enqueueDiscoveryRefreshIfNeeded(
  options: EnqueueDiscoveryRefreshOptions = {},
) {
  if (!options.force && !discoveryNeedsRefresh()) {
    return { enqueued: false, reason: "fresh" };
  }
  return enqueueDiscoveryRefresh(options);
}

export async function bootstrapDiscoveryRefresh() {
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
