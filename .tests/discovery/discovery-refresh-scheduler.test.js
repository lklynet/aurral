import test from "node:test";
import assert from "node:assert/strict";
import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("discovery-refresh-scheduler");
applyIsolatedBackendEnv(isolatedState);

const honkerDbModule = await importFromRepo("backend/services/honkerDb.js");
const {
  discoveryNeedsRefresh,
  enqueueDiscoveryRefresh,
  markDiscoveryRefreshDequeued,
  requestDiscoveryRefresh,
  scheduleNextDiscoveryRefresh,
} = await importFromRepo("backend/services/discoveryRefreshScheduler.js");
const { getDiscoveryCache } = await importFromRepo("backend/services/discoveryService.js");

let heldGlobalRefreshLock = null;

function holdGlobalRefreshLock() {
  heldGlobalRefreshLock = honkerDbModule.getHonkerDb().tryLock(
    "discovery-global-refresh",
    "discovery-refresh-scheduler-test",
    3600,
  );
  assert.ok(heldGlobalRefreshLock);
}

function releaseHeldGlobalRefreshLock() {
  if (!heldGlobalRefreshLock) return;
  try {
    heldGlobalRefreshLock.release();
  } catch {}
  heldGlobalRefreshLock = null;
}

test.beforeEach(() => {
  markDiscoveryRefreshDequeued();
  getDiscoveryCache().isUpdating = false;
  releaseHeldGlobalRefreshLock();
});

test.after(async () => {
  releaseHeldGlobalRefreshLock();
  markDiscoveryRefreshDequeued();
  await cleanupIsolatedState(isolatedState);
});

test("discoveryNeedsRefresh returns true when cache is empty", () => {
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [],
      topGenres: [],
      lastUpdated: null,
    }),
    true,
  );
});

test("discoveryNeedsRefresh returns false for fresh populated cache", () => {
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [{ id: "rec-1" }],
      topGenres: ["rock"],
      lastUpdated: new Date().toISOString(),
    }),
    false,
  );
});

test("enqueueDiscoveryRefresh deduplicates active refresh requests", () => {
  holdGlobalRefreshLock();
  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, "updating");
});

test("requestDiscoveryRefresh returns a plain result object", () => {
  const cache = getDiscoveryCache();
  cache.isUpdating = false;
  const result = requestDiscoveryRefresh({ reason: "manual", force: true });
  assert.equal(typeof result?.enqueued, "boolean");
  assert.equal(result?.then, undefined);
});

test("enqueueDiscoveryRefresh treats force as success when already updating", () => {
  holdGlobalRefreshLock();
  const result = enqueueDiscoveryRefresh({ reason: "manual", force: true });
  assert.equal(result.enqueued, true);
  assert.equal(result.reason, "already_updating");
});

test("enqueueDiscoveryRefresh deduplicates when refresh queue lock is held", () => {
  const first = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(first.enqueued, true);

  const second = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(second.enqueued, false);
  assert.equal(second.reason, "queued");
});

test("enqueueDiscoveryRefresh does not treat cache.isUpdating alone as in-progress", () => {
  const cache = getDiscoveryCache();
  cache.isUpdating = true;

  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, true);
  assert.equal(result.reason, "manual");
});

test("enqueueDiscoveryRefresh queues immediate refresh", () => {
  const cache = getDiscoveryCache();
  markDiscoveryRefreshDequeued();
  cache.isUpdating = false;
  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, true);
  assert.equal(cache.isUpdating, true);
});

test("scheduleNextDiscoveryRefresh enqueues future job without marking updating", () => {
  const cache = getDiscoveryCache();
  cache.isUpdating = false;
  cache.lastUpdated = new Date().toISOString();
  const result = scheduleNextDiscoveryRefresh();
  assert.equal(result.enqueued, true);
  assert.equal(cache.isUpdating, false);
});
