import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { recoverExitedWorkerJobs } from "../../backend/services/appRuntime.js";
import { getLibraryScanQueue } from "../../backend/services/honkerDb.js";
import { dbOps } from "../../backend/db/helpers/index.js";

test("an exited scan process releases its claimed job for retry", async () => {
  const queue = getLibraryScanQueue();
  const pid = 900000001;
  const workerId = `aurral-${pid}`;
  const jobId = queue.enqueue({ force: true });
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

  await recoverExitedWorkerJobs("library", pid, { warn() {} });
  const recovered = queue.getJob(jobId);
  assert.equal(recovered?.state, "pending");
  assert.equal(recovered?.worker_id, null);
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob");
  assert.deepEqual(registry?.changedPaths, [pendingPath, changedPath]);
  assert.equal(registry?.inFlightActive, undefined);
});

test("a worker exit preserves a full rescan requested during the active scan", async () => {
  const queue = getLibraryScanQueue();
  const pid = 900000002;
  const jobId = queue.enqueue({ force: false });
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

  await recoverExitedWorkerJobs("library", pid, { warn() {} });
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob");
  assert.equal(registry.jobId, jobId);
  assert.equal(registry.includeLidarr, true);
  assert.equal(registry.force, true);
  assert.equal("changedPaths" in registry, false);
  assert.equal(queue.getJob(jobId)?.state, "pending");
});
