import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, honkerDb, { dbOps }] = await setupIsolatedBackend(
  "honker-db-config",
  "backend/services/honkerDb.js",
  "backend/db/helpers/index.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("schedule bootstrap skips stale runs without postponing recently due work", () => {
  honkerDb.bootstrapHonkerSchedules();
  const scheduler = honkerDb.getHonkerDb().scheduler();
  const now = Math.floor(Date.now() / 1000);

  const tx = honkerDb.getHonkerDb().transaction();
  tx.execute(
    "UPDATE _honker_scheduler_tasks SET next_fire_at = ?, priority = ? WHERE name = ?",
    [now - 3 * 60 * 60, 99, "weekly-flow-refresh"],
  );
  tx.commit();

  honkerDb.bootstrapHonkerSchedules();

  const rows = scheduler.list();
  const weeklyFlow = rows.find((row) => row.name === "weekly-flow-refresh");
  const enrichment = rows.find(
    (row) => row.name === "playlist-mbid-enrichment-sweep",
  );

  assert.ok(weeklyFlow?.next_fire_at > now);
  assert.equal(weeklyFlow?.priority, 0);

  const recentlyDue = now - 60;
  const recentTx = honkerDb.getHonkerDb().transaction();
  recentTx.execute(
    "UPDATE _honker_scheduler_tasks SET next_fire_at = ? WHERE name = ?",
    [recentlyDue, "weekly-flow-refresh"],
  );
  recentTx.commit();

  honkerDb.bootstrapHonkerSchedules();

  const preserved = scheduler
    .list()
    .find((row) => row.name === "weekly-flow-refresh");
  assert.equal(preserved?.next_fire_at, recentlyDue);
  assert.equal(enrichment?.max_attempts, 4);
  assert.equal(rows.length, honkerDb.SCHEDULED_SYSTEM_TASKS.length);
});

test("queue registry survives a Honker database close and reopen", () => {
  honkerDb.closeHonkerDb();

  const queue = honkerDb.getHonkerQueueByName("system-task");
  assert.equal(queue?.name, "system-task");
  assert.equal(queue?.maxAttempts, 3);
});

test("Honker uses a low-CPU watcher cadence by default", () => {
  const original = process.env.AURRAL_HONKER_WATCHER_POLL_MS;
  delete process.env.AURRAL_HONKER_WATCHER_POLL_MS;
  try {
    assert.deepEqual(honkerDb.getHonkerOpenOptions(), {
      watcherPollIntervalMs: 25,
    });
  } finally {
    if (original === undefined) {
      delete process.env.AURRAL_HONKER_WATCHER_POLL_MS;
    } else {
      process.env.AURRAL_HONKER_WATCHER_POLL_MS = original;
    }
  }
});

test("startup only queues due bootstrap work and a pending migration", () => {
  const db = honkerDb.getHonkerDb();
  const clearQueue = () => {
    const tx = db.transaction();
    tx.execute("DELETE FROM _honker_live");
    tx.commit();
  };
  const queuedKinds = () =>
    db
      .query("SELECT payload FROM _honker_live ORDER BY id")
      .map((row) => JSON.parse(row.payload).kind);

  clearQueue();
  honkerDb.enqueueHonkerStartupTasks();
  honkerDb.enqueueHonkerStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "playlist-startup-migration",
    "weekly-flow-startup-check",
    "discovery-bootstrap",
    "library-index-bootstrap",
  ]);

  dbOps.setJSONSetting(honkerDb.PLAYLIST_STARTUP_MIGRATION_SETTING, {
    version: honkerDb.PLAYLIST_STARTUP_MIGRATION_VERSION,
    rootPath: process.env.WEEKLY_FLOW_FOLDER,
  });
  clearQueue();
  honkerDb.enqueueHonkerStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "weekly-flow-startup-check",
    "discovery-bootstrap",
    "library-index-bootstrap",
  ]);
});
