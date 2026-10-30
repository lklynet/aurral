import { requireFixture } from "../playlists/fixtures.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  recoverExitedWorkerJobs,
  recoverJobsClaimedBeforeStart,
} from "../../backend/services/backgroundJobRecovery.ts";
import { getHonkerDb, getLibraryScanQueue } from "../../backend/services/honkerDb.ts";
import {
  beginLibraryScanJob,
  onLibraryScanSuccess,
  scanRegistrySchema,
  scheduleLibraryScan,
} from "../../backend/services/libraryScanWorker.ts";
import { dbOps } from "../../backend/db/helpers/index.ts";

test("an exited scan process releases its claimed job for retry", async (t: import("vite-plus/test").TestContext) => {
  const queue = getLibraryScanQueue();
  const pid = 900000001;
  const workerId = `aurral-${pid}`;
  const jobId = queue.enqueue({ force: true });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  const claim = queue.claimOne(workerId);
  assert.equal(claim?.id, jobId);
  assert.equal(queue.getJob(jobId)?.state, "processing");
  const changedPath = path.resolve("test-library", "artist.flac");
  const pendingPath = path.resolve("test-library", "later.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [changedPath],
  });

  await recoverExitedWorkerJobs("library", pid, { warn() {}, error() {}, info() {} });
  const recovered = queue.getJob(jobId);
  assert.equal(recovered?.state, "pending");
  assert.equal(recovered?.worker_id, null);
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
  assert.deepEqual(registry?.changedPaths, [pendingPath, changedPath]);
  assert.equal(registry?.inFlightActive, undefined);
});

test("a worker exit preserves a full rescan requested during the active scan", async (t: import("vite-plus/test").TestContext) => {
  const queue = getLibraryScanQueue();
  const pid = 900000002;
  const jobId = queue.enqueue({ force: false });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  assert.equal(queue.claimOne(`aurral-${pid}`)?.id, jobId);
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: true,
    force: true,
    changedPaths: [],
    inFlightActive: true,
    inFlightPaths: [path.resolve("test-library", "earlier.flac")],
    fullRescanPending: true,
  });

  await recoverExitedWorkerJobs("library", pid, { warn() {}, error() {}, info() {} });
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
  assert.ok(registry != null);
  assert.equal(registry.jobId, jobId);
  assert.ok(registry != null);
  assert.equal(registry.includeLidarr, true);
  assert.ok(registry != null);
  assert.equal(registry.force, true);
  assert.ok(registry != null);
  assert.equal("changedPaths" in registry, false);
  assert.equal(queue.getJob(jobId)?.state, "pending");
});

test("a scan claimed before Aurral restarted runs again at startup with the files it was scanning", async (t: import("vite-plus/test").TestContext) => {
  const queue = getLibraryScanQueue();
  const earlier = queue.enqueue({ force: false });
  const current = queue.enqueue({ force: false });
  t.onTestFinished(() => {
    queue.cancel(earlier);
    queue.cancel(current);
  });
  assert.equal(queue.claimOne("aurral-900000004")?.id, earlier);
  assert.equal(queue.claimOne("aurral-900000005")?.id, current);
  getHonkerDb().query(
    "UPDATE _honker_live SET claim_expires_at = claim_expires_at - ? WHERE id = ?",
    [Math.ceil(process.uptime()) + 60, earlier],
  );
  const inFlightPath = path.resolve("test-library", "ingested.flac");
  const pendingPath = path.resolve("test-library", "queued.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId: earlier,
    includeLidarr: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [inFlightPath],
  });

  await recoverJobsClaimedBeforeStart({ warn() {}, error() {}, info() {} });

  assert.equal(queue.getJob(earlier)?.state, "pending");
  assert.equal(queue.getJob(current)?.state, "processing");
  assert.deepEqual(
    beginLibraryScanJob(earlier, { force: false, includeLidarr: false }).changedPaths,
    [pendingPath, inFlightPath],
  );
});

test("a scan retried after its claim expired scans the files the interrupted attempt was scanning", () => {
  const queue = getLibraryScanQueue();
  const jobId = queue.enqueue({ force: false });
  const inFlightPath = path.resolve("test-library", "interrupted.flac");
  const pendingPath = path.resolve("test-library", "afterwards.flac");
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: false,
    changedPaths: [pendingPath],
    inFlightActive: true,
    inFlightPaths: [inFlightPath],
  });
  try {
    const scan = beginLibraryScanJob(jobId, { force: false, includeLidarr: false });
    assert.deepEqual(scan.changedPaths, [inFlightPath, pendingPath]);
  } finally {
    queue.cancel(jobId);
  }
});

test("scan start and completion preserve requests received while a scan is active", () => {
  const queue = getLibraryScanQueue();
  const inFlightPath = path.resolve("test-library", "current.flac");
  const pendingPath = path.resolve("test-library", "next.flac");
  const jobId = queue.enqueue({ force: false });
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: false,
    changedPaths: [inFlightPath],
  });
  let nextJobId;
  try {
    const scan = beginLibraryScanJob(jobId, { force: false, includeLidarr: false });
    assert.deepEqual(scan.changedPaths, [inFlightPath]);
    assert.deepEqual(
      requireFixture(dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema))
        .inFlightPaths,
      [inFlightPath],
    );
    assert.equal(scheduleLibraryScan({ includeLidarr: true, changedPaths: [pendingPath] }), jobId);

    onLibraryScanSuccess({}, { id: jobId });
    const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
    assert.ok(registry != null);
    nextJobId = registry.jobId;
    assert.notEqual(nextJobId, jobId);
    assert.ok(registry != null);
    assert.deepEqual(registry.changedPaths, [pendingPath]);
    assert.ok(registry != null);
    assert.equal(registry.includeLidarr, true);
  } finally {
    queue.cancel(jobId);
    if (nextJobId) queue.cancel(nextJobId);
  }
});

test("scan completion schedules a full rescan requested while the scan was active", () => {
  const queue = getLibraryScanQueue();
  const jobId = queue.enqueue({ force: false });
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: false,
    changedPaths: [path.resolve("test-library", "current.flac")],
  });
  let nextJobId;
  try {
    beginLibraryScanJob(jobId, { force: false, includeLidarr: false });
    assert.equal(scheduleLibraryScan({ force: true, includeLidarr: true }), jobId);
    onLibraryScanSuccess({}, { id: jobId });
    const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
    assert.ok(registry != null);
    nextJobId = registry.jobId;
    assert.notEqual(nextJobId, jobId);
    assert.ok(registry != null);
    assert.equal(registry.force, true);
    assert.ok(registry != null);
    assert.equal(registry.includeLidarr, true);
    assert.ok(registry != null);
    assert.equal("changedPaths" in registry, false);
  } finally {
    queue.cancel(jobId);
    if (nextJobId) queue.cancel(nextJobId);
  }
});

test("an exited personal discovery process stops reporting that user's refresh as running", async (t: import("vite-plus/test").TestContext) => {
  const { getDiscoveryUserRefreshQueue } = await import("../../backend/services/honkerDb.ts");
  const persistence = await import("../../backend/services/discovery/persistence.ts");
  const { getDiscoveryStatus } = await import("../../backend/services/discovery/userDiscovery.ts");
  const originalLastfmApiKey = process.env.LASTFM_API_KEY;
  process.env.LASTFM_API_KEY = "test-key";
  t.onTestFinished(() => {
    if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  });
  const queue = getDiscoveryUserRefreshQueue();
  const pid = 900000003;
  const jobId = queue.enqueue({ userId: 41, requestedAt: Date.now() });
  t.onTestFinished(() => {
    queue.cancel(jobId);
  });
  assert.equal(queue.claimOne(`aurral-${pid}`)?.id, jobId);
  persistence.markDiscoveryRefreshStarted("user:41");
  assert.equal(getDiscoveryStatus(41).isUpdating, true);

  await recoverExitedWorkerJobs(
    "discovery-user-refresh",
    pid,
    { warn() {}, error() {}, info() {} },
    "Worker crashed",
  );

  const status = getDiscoveryStatus(41);
  assert.equal(status.isUpdating, false);
  assert.equal(status.error, "Worker crashed");
  assert.equal(queue.getJob(jobId)?.state, "pending");
});
