import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, honkerDb] = await setupIsolatedBackend(
  "honker-db-config",
  "backend/services/honkerDb.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("schedule bootstrap reconciles config without resetting next fire state", () => {
  honkerDb.bootstrapHonkerSchedules();
  const scheduler = honkerDb.getHonkerDb().scheduler();

  const tx = honkerDb.getHonkerDb().transaction();
  tx.execute(
    "UPDATE _honker_scheduler_tasks SET next_fire_at = ?, priority = ? WHERE name = ?",
    [42, 99, "weekly-flow-refresh"],
  );
  tx.commit();

  honkerDb.bootstrapHonkerSchedules();

  const rows = scheduler.list();
  const weeklyFlow = rows.find((row) => row.name === "weekly-flow-refresh");
  const enrichment = rows.find(
    (row) => row.name === "playlist-mbid-enrichment-sweep",
  );

  assert.equal(weeklyFlow?.next_fire_at, 42);
  assert.equal(weeklyFlow?.priority, 0);
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
