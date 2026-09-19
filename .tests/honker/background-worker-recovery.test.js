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
  dbOps.setJSONSetting("pendingLibraryScanJob", {
    jobId,
    includeLidarr: false,
    changedPaths: [],
    inFlightActive: true,
    inFlightPaths: [changedPath],
  });

  await recoverExitedWorkerJobs("library", pid, { warn() {} });
  const recovered = queue.getJob(jobId);
  assert.equal(recovered?.state, "pending");
  assert.equal(recovered?.worker_id, null);
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob");
  assert.deepEqual(registry?.changedPaths, [changedPath]);
  assert.equal(registry?.inFlightActive, undefined);
});
