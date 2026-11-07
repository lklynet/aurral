import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  jobQueue,
  { discoveryRefreshQueue },
  refreshScheduler,
  persistence,
  { getDiscoveryStatus },
] = await setupIsolatedBackend(
  "discovery-refresh-scheduler",
  () => import("../../backend/services/jobs/queue.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/discovery/refreshScheduler.ts"),
  () => import("../../backend/services/discovery/persistence.ts"),
  () => import("../../backend/services/discovery/userDiscovery.ts"),
);

const {
  discoveryNeedsRefresh,
  bootstrapDiscoveryRefresh,
  enqueueDiscoveryRefresh,
  enqueueDiscoveryRefreshIfNeeded,
  scheduleNextDiscoveryRefresh,
} = refreshScheduler;
const { db } = await import("../../backend/config/db-sqlite.ts");
const { dbOps } = await import("../../backend/db/helpers/index.ts");
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

const LOCK_OWNER = "discovery-refresh-scheduler-test";

function holdGlobalRefreshLock() {
  assert.ok(jobQueue.tryLock("discovery-global-refresh", LOCK_OWNER, 3_600_000));
}

function releaseHeldGlobalRefreshLock() {
  jobQueue.releaseLock("discovery-global-refresh", LOCK_OWNER);
}

function clearDiscoveryRefreshJobs() {
  db.prepare("DELETE FROM jobs WHERE queue = 'discovery-refresh'").run();
}

function countDiscoveryRefreshJobs() {
  return discoveryRefreshQueue.list().length;
}

function discoveryRefreshPayloads() {
  return discoveryRefreshQueue.list().map((row) => row.payload ?? {});
}

// Writes the shared database and leaves this process's memory empty, like a
// worker process that started before another process refreshed discovery.
function setDiscoveryCache({
  lastUpdated = null,
  ...data
}: Parameters<typeof dbOps.updateDiscoveryCache>[0] = {}) {
  db.prepare("DELETE FROM discovery_cache WHERE key NOT LIKE 'user:%'").run();
  persistence.resetDiscoveryModuleCache();
  if (Object.keys(data).length === 0) return;
  dbOps.updateDiscoveryCache(data);
  if (lastUpdated) db.prepare("UPDATE discovery_cache SET last_updated = ?").run(lastUpdated);
}

beforeEach(() => {
  clearDiscoveryRefreshJobs();
  setDiscoveryCache();
  releaseHeldGlobalRefreshLock();
  clearLibraryArtists();
});

afterAll(async () => {
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  releaseHeldGlobalRefreshLock();
  await cleanupIsolatedState(isolatedState);
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
      globalTop: [{ id: "trend-1", name: "trend-1" }],
      topGenres: [],
      lastUpdated: new Date().toISOString(),
    }),
    false,
  );
});

test("discoveryNeedsRefresh leaves genres to personal refreshes when the library has seed artists", () => {
  seedLibraryArtist();
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [],
      globalTop: [{ id: "trend-1", name: "trend-1" }],
      topGenres: [],
      lastUpdated: new Date().toISOString(),
    }),
    false,
  );
});

test("interval check does not queue a refresh after a seedless run left genres empty", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({
    recommendations: [],
    globalTop: [{ id: "trend-1", name: "trend-1" }],
    topGenres: [],
    lastUpdated: new Date().toISOString(),
  });

  const result = await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });

  assert.equal(result.enqueued, false);
  assert.equal(result.reason, "fresh");
  assert.equal(countDiscoveryRefreshJobs(), 0);
});

test("discoveryNeedsRefresh rebuilds a fresh cache that came from the other music data source", () => {
  const fresh = {
    globalTop: [{ id: "trend-1", name: "trend-1" }],
    lastUpdated: new Date().toISOString(),
  };
  delete process.env.LASTFM_API_KEY;
  assert.equal(discoveryNeedsRefresh({ ...fresh, provider: "lastfm" }), true);
  assert.equal(discoveryNeedsRefresh({ ...fresh, provider: "listenbrainz" }), false);
  process.env.LASTFM_API_KEY = "test-key";
  assert.equal(discoveryNeedsRefresh({ ...fresh, provider: "listenbrainz" }), true);
});

test("discoveryNeedsRefresh returns false for fresh populated cache", () => {
  assert.equal(
    discoveryNeedsRefresh({
      recommendations: [{ id: "rec-1", name: "rec-1" }],
      topGenres: ["rock"],
      lastUpdated: new Date().toISOString(),
    }),
    false,
  );
});

test("first discovery startup queues one refresh", async () => {
  process.env.LASTFM_API_KEY = "test-key";

  await bootstrapDiscoveryRefresh();

  const [payload, ...rest] = discoveryRefreshPayloads();
  assert.equal(rest.length, 0);
  assert.equal(payload?.reason, "startup");
  assert.equal(payload?.scheduleOnly, false);
});

test("stale and incomplete discovery caches retry", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({
    recommendations: [{ id: "old", name: "old" }],
    topGenres: ["rock"],
    lastUpdated: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  });

  await bootstrapDiscoveryRefresh();
  assert.equal(discoveryRefreshPayloads()[0]?.reason, "startup");

  clearDiscoveryRefreshJobs();
  setDiscoveryCache({ topGenres: ["rock"] });

  await bootstrapDiscoveryRefresh();
  assert.equal(discoveryRefreshPayloads()[0]?.reason, "startup");
});

test("repeated startup checks do not create duplicate active refresh jobs", async () => {
  process.env.LASTFM_API_KEY = "test-key";
  setDiscoveryCache({ lastUpdated: null });

  await bootstrapDiscoveryRefresh();
  await bootstrapDiscoveryRefresh();

  assert.equal(countDiscoveryRefreshJobs(), 1);
});

test("a completed discovery queue job no longer blocks the next refresh", () => {
  process.env.LASTFM_API_KEY = "test-key";
  const first = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(first.enqueued, true);
  const claimed = discoveryRefreshQueue.claim("aurral-test-worker");
  assert.ok(claimed);
  claimed.ack();

  const second = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(second.enqueued, true);
  assert.equal(countDiscoveryRefreshJobs(), 1);
});

test("enqueueDiscoveryRefresh deduplicates active refresh requests", () => {
  holdGlobalRefreshLock();
  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, "updating");
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

test("a recorded refresh request without a queued job does not block a new refresh", () => {
  persistence.markDiscoveryRefreshRequested();

  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, true);
  assert.equal(result.reason, "manual");
});

test("enqueueDiscoveryRefresh queues immediate refresh and reports it as queued", () => {
  const result = enqueueDiscoveryRefresh({ reason: "manual" });
  assert.equal(result.enqueued, true);
  const status = getDiscoveryStatus(null);
  assert.equal(status.isUpdating, true);
  assert.equal(status.updatePhase, "queued");
});

test("scheduleNextDiscoveryRefresh enqueues future job without marking updating", () => {
  setDiscoveryCache({ globalTop: [{ id: "trend-1", name: "trend-1" }] });
  const result = scheduleNextDiscoveryRefresh();
  assert.equal(result.enqueued, true);
  assert.equal(getDiscoveryStatus(null).isUpdating, false);
});

test("scheduleNextDiscoveryRefresh deduplicates existing future refresh", () => {
  clearDiscoveryRefreshJobs();
  setDiscoveryCache({ globalTop: [{ id: "trend-1", name: "trend-1" }] });

  const first = scheduleNextDiscoveryRefresh();
  const second = scheduleNextDiscoveryRefresh();

  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, true);
  assert.equal(countDiscoveryRefreshJobs(), 1);
});
