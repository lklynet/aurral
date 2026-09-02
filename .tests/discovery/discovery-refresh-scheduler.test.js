import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const [isolatedState, honkerDbModule, refreshScheduler, discoveryIndex] =
  await setupIsolatedBackend(
    "discovery-refresh-scheduler",
    "backend/services/honkerDb.js",
    "backend/services/discovery/refreshScheduler.js",
    "backend/services/discovery/index.js",
  );

const {
  discoveryNeedsRefresh,
  bootstrapDiscoveryRefresh,
  enqueueDiscoveryRefresh,
  enqueueDiscoveryRefreshIfNeeded,
  markDiscoveryRefreshDequeued,
  recoverDeadDiscoveryRefresh,
  scheduleNextDiscoveryRefresh,
} = refreshScheduler;
const { getDiscoveryCache } = discoveryIndex;
const { db } = await importFromRepo("backend/config/db-sqlite.js");
const originalLastfmApiKey = process.env.LASTFM_API_KEY;

function seedLibraryArtist() {
  db.prepare(
    `INSERT INTO library_artists (identity_key, name, created_at, updated_at)
     VALUES ('test:seed-artist', 'Seed Artist', 1, 1)`,
  ).run();
}

function clearLibraryArtists() {
  db.prepare("DELETE FROM library_artists").run();
}

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

function clearDiscoveryRefreshJobs() {
  const tx = honkerDbModule.getHonkerDb().transaction();
  try {
    tx.execute("DELETE FROM _honker_live WHERE queue = ?", [
      "discovery-refresh",
    ]);
    tx.execute("DELETE FROM _honker_dead WHERE queue = ?", [
      "discovery-refresh",
    ]);
    tx.commit();
  } catch (error) {
    try {
      tx.rollback();
    } catch {}
    throw error;
  }
}

function countDiscoveryRefreshJobs() {
  return Number(
    honkerDbModule.getHonkerDb().query(
      "SELECT COUNT(*) AS count FROM _honker_live WHERE queue = ?",
      ["discovery-refresh"],
    )[0]?.count || 0,
  );
}

function discoveryRefreshPayloads() {
  return honkerDbModule
    .getHonkerDb()
    .query("SELECT payload FROM _honker_live WHERE queue = ? ORDER BY id", [
      "discovery-refresh",
    ])
    .map((row) => JSON.parse(row.payload));
}

function setDiscoveryCache(overrides = {}) {
  Object.assign(getDiscoveryCache(), {
    recommendations: [],
    globalTop: [],
    topGenres: [],
    lastUpdated: null,
    isUpdating: false,
    ...overrides,
  });
}

test.beforeEach(() => {
  clearDiscoveryRefreshJobs();
  markDiscoveryRefreshDequeued();
  setDiscoveryCache();
  releaseHeldGlobalRefreshLock();
  clearLibraryArtists();
});

test.after(async () => {
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
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

test("discoveryNeedsRefresh retries a recent empty cache", () => {
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [],
      globalTop: [],
      topGenres: [],
      lastUpdated: new Date().toISOString(),
    }),
    true,
  );
});

test("discoveryNeedsRefresh does not retry missing genres when the library has no artists", () => {
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [],
      globalTop: [{ id: "trend-1" }],
      topGenres: [],
      lastUpdated: new Date().toISOString(),
    }),
    false,
  );
});

test("discoveryNeedsRefresh retries missing genres when the library has seed artists", () => {
  seedLibraryArtist();
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [{ id: "rec-1" }],
      globalTop: [{ id: "trend-1" }],
      topGenres: [],
      lastUpdated: new Date().toISOString(),
    }),
    true,
  );
});

test("interval check does not queue a refresh after a seedless run left genres empty", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({
    recommendations: [],
    globalTop: [{ id: "trend-1" }],
    topGenres: [],
    lastUpdated: new Date().toISOString(),
  });

  const result = await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });

  assert.equal(result.enqueued, false);
  assert.equal(result.reason, "fresh");
  assert.equal(countDiscoveryRefreshJobs(), 0);
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

test("first discovery startup queues one refresh", async () => {
  process.env.LASTFM_API_KEY = "test-key";

  await bootstrapDiscoveryRefresh();

  const payloads = discoveryRefreshPayloads();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].reason, "startup");
  assert.equal(payloads[0].scheduleOnly, false);
});

test("recent empty discovery cache queues one recovery refresh", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({
    recommendations: [],
    globalTop: [],
    topGenres: [],
    lastUpdated: new Date().toISOString(),
  });

  await bootstrapDiscoveryRefresh();
  await bootstrapDiscoveryRefresh();

  const payloads = discoveryRefreshPayloads();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].reason, "startup");
  assert.equal(payloads[0].scheduleOnly, false);
});

test("stale and incomplete discovery caches retry", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({
    recommendations: [{ id: "old" }],
    topGenres: ["rock"],
    lastUpdated: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  });

  await bootstrapDiscoveryRefresh();
  assert.equal(discoveryRefreshPayloads()[0].reason, "startup");

  clearDiscoveryRefreshJobs();
  markDiscoveryRefreshDequeued();
  setDiscoveryCache({ recommendations: [{ id: "partial" }] });

  await bootstrapDiscoveryRefresh();
  assert.equal(discoveryRefreshPayloads()[0].reason, "startup");
});

test("repeated startup checks do not create duplicate active refresh jobs", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({ lastUpdated: null });

  await bootstrapDiscoveryRefresh();
  await bootstrapDiscoveryRefresh();

  assert.equal(countDiscoveryRefreshJobs(), 1);
});

test("enqueueDiscoveryRefresh deduplicates active refresh requests", () => {
  holdGlobalRefreshLock();
  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, "updating");
});

test("enqueueDiscoveryRefresh returns a plain result object", () => {
  const cache = getDiscoveryCache();
  cache.isUpdating = false;
  const result = enqueueDiscoveryRefresh({ reason: "manual", force: true });
  assert.equal(typeof result?.enqueued, "boolean");
  assert.equal(result?.then, undefined);
});

test("enqueueDiscoveryRefresh treats force as success when already updating", () => {
  holdGlobalRefreshLock();
  const result = enqueueDiscoveryRefresh({ reason: "manual", force: true });
  assert.equal(result.enqueued, true);
  assert.equal(result.reason, "already_updating");
});

test("recoverDeadDiscoveryRefresh clears jobs and locks owned by dead local workers", () => {
  clearDiscoveryRefreshJobs();
  const workerId = "aurral-99999999";
  const lock = honkerDbModule.getHonkerDb().tryLock(
    "discovery-global-refresh",
    workerId,
    3600,
  );
  assert.ok(lock);
  const jobId = honkerDbModule.getDiscoveryRefreshQueue().enqueue({ reason: "manual" });
  const claimed = honkerDbModule.getDiscoveryRefreshQueue().claimOne(workerId);
  assert.equal(claimed?.id, jobId);

  assert.equal(recoverDeadDiscoveryRefresh(), true);
  assert.equal(
    honkerDbModule.getHonkerDb().query(
      "SELECT COUNT(*) AS count FROM _honker_live WHERE id = ?",
      [jobId],
    )[0]?.count,
    0,
  );
  assert.equal(honkerDbModule.isHonkerLockHeld("discovery-global-refresh"), false);
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

test("scheduleNextDiscoveryRefresh deduplicates existing future refresh", () => {
  clearDiscoveryRefreshJobs();
  const cache = getDiscoveryCache();
  cache.isUpdating = false;
  cache.lastUpdated = new Date().toISOString();

  const first = scheduleNextDiscoveryRefresh();
  const second = scheduleNextDiscoveryRefresh();

  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(second.reason, "already_scheduled");
  assert.equal(countDiscoveryRefreshJobs(), 1);
});

test("pruneDuplicateScheduledDiscoveryRefreshes collapses stacked future refreshes", async () => {
  clearDiscoveryRefreshJobs();
  const { pruneDuplicateScheduledDiscoveryRefreshes } = await importFromRepo(
    "backend/services/discovery/refreshScheduler.js",
  );
  const queue = honkerDbModule.getDiscoveryRefreshQueue();
  const runAt = Math.floor(Date.now() / 1000) + 3600;
  for (let index = 0; index < 3; index += 1) {
    queue.enqueue(
      {
        reason: "scheduled",
        requestedAt: Date.now() + index,
        scheduleOnly: true,
      },
      { runAt: runAt + index * 120 },
    );
  }
  assert.equal(countDiscoveryRefreshJobs(), 3);
  assert.equal(pruneDuplicateScheduledDiscoveryRefreshes(), 2);
  assert.equal(countDiscoveryRefreshJobs(), 1);
});
