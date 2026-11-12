import { requireFixture } from "../playlists/fixtures.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test, afterAll } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  state,
  { recoverAbandonedJobs },
  { libraryScanQueue: queue, discoveryUserRefreshQueue },
  { beginLibraryScanJob, onLibraryScanSuccess, scanRegistrySchema, scheduleLibraryScan },
  { dbOps },
] = await setupIsolatedBackend(
  "abandoned-jobs",
  () => import("../../backend/services/jobs/queue.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/libraryScanWorker.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test("an exited scan process releases its claimed job for retry", async (t: import("vite-plus/test").TestContext) => {
  const jobId = queue.enqueue({ force: true });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  assert.equal(queue.claim("library:exited")?.id, jobId);
  const changedPath = path.resolve("test-library", "artist.flac");
  const pendingPath = path.resolve("test-library", "later.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [changedPath],
  });

  await recoverAbandonedJobs("Worker exited", "library");
  const recovered = queue.getJob(jobId);
  assert.equal(recovered?.state, "pending");
  assert.equal(recovered?.worker_id, null);
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
  assert.deepEqual(registry?.changedPaths, [pendingPath, changedPath]);
  assert.equal(registry?.inFlightActive, undefined);
});

test("a worker exit preserves a full rescan requested during the active scan", async (t: import("vite-plus/test").TestContext) => {
  const jobId = queue.enqueue({ force: false });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  assert.equal(queue.claim("library:exited")?.id, jobId);
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: true,
    force: true,
    changedPaths: [],
    inFlightActive: true,
    inFlightPaths: [path.resolve("test-library", "earlier.flac")],
    fullRescanPending: true,
  });

  await recoverAbandonedJobs("Worker exited", "library");
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
  assert.ok(registry != null);
  assert.equal(registry.jobId, jobId);
  assert.equal(registry.includeReadOnly, true);
  assert.equal(registry.force, true);
  assert.equal("changedPaths" in registry, false);
  assert.equal(queue.getJob(jobId)?.state, "pending");
});

test("a full rescan whose worker dies on its last attempt is not revived by the next scan request", async (t: import("vite-plus/test").TestContext) => {
  const jobId = queue.enqueue({ force: true, includeReadOnly: true });
  const changedPath = path.resolve("test-library", "artist.nfo");
  let nextJobId: number | null = null;
  t.onTestFinished(() => {
    queue.cancel(jobId);
    if (nextJobId != null) queue.cancel(nextJobId);
  });
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: true,
    force: true,
    changedPaths: [],
    inFlightActive: true,
    inFlightPaths: null,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(queue.claim("library:killed")?.id, jobId);
    await recoverAbandonedJobs("library worker stopped responding", "library");
  }
  assert.equal(queue.getJob(jobId)?.state, "failed");

  nextJobId = scheduleLibraryScan({ changedPaths: [changedPath] });
  assert.notEqual(nextJobId, jobId);
  assert.deepEqual(JSON.parse(queue.getJob(nextJobId)!.payload), {
    force: false,
    includeReadOnly: true,
    changedPaths: [changedPath],
  });
});

test("a scan left running when Aurral stopped runs again at startup with the files it was scanning", async (t: import("vite-plus/test").TestContext) => {
  const jobId = queue.enqueue({ force: false });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  assert.equal(queue.claim("library:before-restart")?.id, jobId);
  const inFlightPath = path.resolve("test-library", "ingested.flac");
  const pendingPath = path.resolve("test-library", "queued.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [inFlightPath],
  });

  await recoverAbandonedJobs("Aurral restarted");

  assert.equal(queue.getJob(jobId)?.state, "pending");
  assert.deepEqual(
    beginLibraryScanJob(jobId, { force: false, includeReadOnly: false }).changedPaths,
    [pendingPath, inFlightPath],
  );
});

test("a scan retried after its claim expired scans the files the interrupted attempt was scanning", () => {
  const jobId = queue.enqueue({ force: false });
  const inFlightPath = path.resolve("test-library", "interrupted.flac");
  const pendingPath = path.resolve("test-library", "afterwards.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [inFlightPath],
  });
  try {
    const scan = beginLibraryScanJob(jobId, { force: false, includeReadOnly: false });
    assert.deepEqual(scan.changedPaths, [inFlightPath, pendingPath]);
  } finally {
    queue.cancel(jobId);
  }
});

test("scan start and completion preserve requests received while a scan is active", () => {
  const inFlightPath = path.resolve("test-library", "current.flac");
  const pendingPath = path.resolve("test-library", "next.flac");
  const jobId = queue.enqueue({ force: false });
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: false,
    changedPaths: [inFlightPath],
  });
  let nextJobId;
  try {
    const scan = beginLibraryScanJob(jobId, { force: false, includeReadOnly: false });
    assert.deepEqual(scan.changedPaths, [inFlightPath]);
    assert.deepEqual(
      requireFixture(dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema))
        .inFlightPaths,
      [inFlightPath],
    );
    assert.equal(
      scheduleLibraryScan({ includeReadOnly: true, changedPaths: [pendingPath] }),
      jobId,
    );

    onLibraryScanSuccess({}, { id: jobId });
    const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
    assert.ok(registry != null);
    nextJobId = registry.jobId;
    assert.notEqual(nextJobId, jobId);
    assert.ok(registry != null);
    assert.deepEqual(registry.changedPaths, [pendingPath]);
    assert.ok(registry != null);
    assert.equal(registry.includeReadOnly, true);
  } finally {
    queue.cancel(jobId);
    if (nextJobId) queue.cancel(nextJobId);
  }
});

test("scan completion schedules a full rescan requested while the scan was active", () => {
  const jobId = queue.enqueue({ force: false });
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeReadOnly: false,
    changedPaths: [path.resolve("test-library", "current.flac")],
  });
  let nextJobId;
  try {
    beginLibraryScanJob(jobId, { force: false, includeReadOnly: false });
    assert.equal(scheduleLibraryScan({ force: true, includeReadOnly: true }), jobId);
    onLibraryScanSuccess({}, { id: jobId });
    const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
    assert.ok(registry != null);
    nextJobId = registry.jobId;
    assert.notEqual(nextJobId, jobId);
    assert.ok(registry != null);
    assert.equal(registry.force, true);
    assert.ok(registry != null);
    assert.equal(registry.includeReadOnly, true);
    assert.ok(registry != null);
    assert.equal("changedPaths" in registry, false);
  } finally {
    queue.cancel(jobId);
    if (nextJobId) queue.cancel(nextJobId);
  }
});

test("an exited personal discovery process stops reporting that user's refresh as running", async (t: import("vite-plus/test").TestContext) => {
  const persistence = await import("../../backend/services/discovery/persistence.ts");
  const { getDiscoveryStatus } = await import("../../backend/services/discovery/userDiscovery.ts");
  const originalLastfmApiKey = process.env.LASTFM_API_KEY;
  process.env.LASTFM_API_KEY = "test-key";
  t.onTestFinished(() => {
    if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  });
  const jobId = discoveryUserRefreshQueue.enqueue({ userId: 41, requestedAt: Date.now() });
  t.onTestFinished(() => {
    discoveryUserRefreshQueue.cancel(jobId);
  });
  assert.equal(discoveryUserRefreshQueue.claim("discovery-user-refresh:exited")?.id, jobId);
  persistence.markDiscoveryRefreshStarted("user:41");
  assert.equal(getDiscoveryStatus(41).isUpdating, true);

  await recoverAbandonedJobs("Worker crashed", "discovery-user-refresh");

  const status = getDiscoveryStatus(41);
  assert.equal(status.isUpdating, false);
  assert.equal(status.error, "Worker crashed");
  assert.equal(discoveryUserRefreshQueue.getJob(jobId)?.state, "pending");
});
