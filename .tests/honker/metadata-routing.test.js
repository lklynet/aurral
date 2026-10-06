import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
const [paths, honker, , { scheduleReleaseMetadataRefresh }] = await setupIsolatedBackend(
  "metadata-routing", "backend/services/honkerDb.js", "backend/config/db-sqlite.js",
  "backend/services/releaseMetadataSync.js");
after(() => cleanupIsolatedState(paths));

const pendingRefreshes = () => honker.listHonkerJobs("release-metadata-refresh")
  .filter((job) => job.payload?.kind === "release-metadata-refresh" && job.state === "pending");

const clearMetadataQueue = () => {
  const queue = honker.getHonkerQueueByName("release-metadata-refresh");
  for (const job of honker.listHonkerJobs("release-metadata-refresh")) queue?.cancel(job.id);
};

test("manual metadata refresh coalesces pending work and advances its deadline", () => {
  const queue = honker.getReleaseMetadataQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" }, { runAt: Math.floor(Date.now() / 1000) + 60 });
  try {
    assert.equal(scheduleReleaseMetadataRefresh({ delaySeconds: 120 }), id);
    const earlier = scheduleReleaseMetadataRefresh();
    assert.ok(earlier);
    const jobs = pendingRefreshes();
    assert.equal(jobs.length, 1);
    assert.ok(jobs[0].run_at <= Math.floor(Date.now() / 1000));
    assert.equal(queue.getJob(earlier)?.id, earlier);
  } finally {
    clearMetadataQueue();
  }
});

test("manual metadata refresh keeps one pending refresh", () => {
  const now = Math.floor(Date.now() / 1000);
  const queue = honker.getReleaseMetadataQueue();
  const firstId = queue.enqueue({ kind: "release-metadata-refresh" }, { runAt: now + 60 });
  queue.enqueue({ kind: "release-metadata-refresh" }, { runAt: now + 90 });
  try {
    assert.equal(scheduleReleaseMetadataRefresh({ delaySeconds: 120 }), firstId);
    assert.deepEqual(pendingRefreshes().map((job) => job.id), [firstId]);
  } finally {
    clearMetadataQueue();
  }
});
