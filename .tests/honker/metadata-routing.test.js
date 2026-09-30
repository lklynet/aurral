import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
const [paths, honker, { db }, { scheduleReleaseMetadataRefresh }] = await setupIsolatedBackend(
  "metadata-routing", "backend/services/honkerDb.js", "backend/config/db-sqlite.js",
  "backend/services/releaseMetadataSync.js");
after(() => cleanupIsolatedState(paths));

test("metadata schedule migration preserves overdue and future fires and legacy claims", () => {
  const scheduler = honker.getHonkerDb().scheduler();
  scheduler.add({ name: "release-metadata-refresh", queue: "system-task",
    schedule: "@every 24h", payload: { kind: "release-metadata-refresh" }, priority: -5 });
  const legacy = honker.getSystemTaskQueue();
  const id = legacy.enqueue({ kind: "release-metadata-refresh" });
  const claim = legacy.claimOne("legacy-owner");
  for (const next of [Math.floor(Date.now() / 1000) - 1000, Math.floor(Date.now() / 1000) + 1800]) {
    db.prepare("UPDATE _honker_scheduler_tasks SET queue = ?, next_fire_at = ? WHERE name = ?")
      .run("system-task", next, "release-metadata-refresh");
    honker.bootstrapHonkerSchedules();
    honker.bootstrapHonkerSchedules();
    const migrated = scheduler.list().find((row) => row.name === "release-metadata-refresh");
    assert.equal(migrated.queue, "release-metadata-refresh");
    assert.equal(migrated.next_fire_at, next);
    assert.equal(legacy.getJob(id).worker_id, "legacy-owner");
    assert.equal(legacy.getJob(id).attempts, claim.attempts);
  }
  legacy.cancel(id);
});

test("manual metadata refresh coalesces pending legacy work and advances its deadline", () => {
  const legacy = honker.getSystemTaskQueue();
  const id = legacy.enqueue({ kind: "release-metadata-refresh" }, { runAt: Math.floor(Date.now()/1000) + 60 });
  try {
    assert.equal(scheduleReleaseMetadataRefresh({ delaySeconds: 120 }), id);
    const earlier = scheduleReleaseMetadataRefresh();
    assert.ok(earlier);
    const jobs = [...honker.listHonkerJobs("system-task"), ...honker.listHonkerJobs("release-metadata-refresh")]
      .filter((job) => job.payload?.kind === "release-metadata-refresh" && job.state === "pending");
    assert.equal(jobs.length, 1);
    assert.ok(jobs[0].run_at <= Math.floor(Date.now()/1000));
    assert.equal(honker.getHonkerQueueByName("release-metadata-refresh")?.getJob(earlier)?.id, earlier);
  } finally {
    for (const name of ["system-task", "release-metadata-refresh"]) {
      const q = honker.getHonkerQueueByName(name);
      for (const job of honker.listHonkerJobs(name)) q?.cancel(job.id);
    }
  }
});

test("rollback moves only pending metadata and preserves its schedule and retries", () => {
  const queue = honker.getReleaseMetadataQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" }, { runAt: Math.floor(Date.now()/1000) + 60 });
  const runningId = queue.enqueue({ kind: "release-metadata-refresh" });
  const claim = queue.claimOne("still-running-owner");
  const before = queue.getJob(id);
  const schedule = honker.getHonkerDb().scheduler().list().find((row) => row.name === "release-metadata-refresh");
  assert.equal(claim.id, runningId);
  try {
    assert.throws(() => honker.restoreReleaseMetadataQueueForRollback(), /Stop and drain/);
    assert.equal(queue.getJob(id).id, id);
    claim.ack();
    assert.equal(honker.restoreReleaseMetadataQueueForRollback(), 1);
    const moved = honker.getSystemTaskQueue().getJob(id);
    assert.equal(moved.attempts, before.attempts);
    assert.equal(moved.run_at, before.run_at);
    assert.equal(moved.state, "pending");
    const restored = honker.getHonkerDb().scheduler().list().find((row) => row.name === "release-metadata-refresh");
    assert.equal(restored.queue, "system-task");
    assert.equal(restored.next_fire_at, schedule.next_fire_at);
    db.prepare("UPDATE _honker_live SET run_at = unixepoch() WHERE id = ?").run(id);
    const retry = honker.getSystemTaskQueue().claimOne("older-runtime");
    assert.equal(retry.id, id);
    retry.ack();
  } finally {
    queue.cancel(runningId);
    honker.getSystemTaskQueue().cancel(id);
  }
});
