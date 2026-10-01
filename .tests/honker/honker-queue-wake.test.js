import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBackgroundProcessSupervisor } from "../../backend/services/backgroundProcessSupervisor.js";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, honker] = await setupIsolatedBackend("queue-wake", "backend/services/honkerDb.js");
test.after(() => cleanupIsolatedState(state));

test("web enqueue persists registered and outbox jobs before notifying their owner", () => {
  process.env.NODE_ENV = "production";
  const delivered = [];
  try {
    honker.configureHonkerQueueWake((queue) => {
      const rows = honker.listHonkerJobs(queue);
      delivered.push({ queue, id: rows.at(-1)?.id });
    });
    const systemId = honker.enqueueSystemTaskJob({ kind: "session-cleanup" });
    const notificationId = honker.enqueueNotification({ message: "disposable" });
    const playId = honker.enqueuePlayEventDelivery({ eventId: "disposable" });
    assert.deepEqual(delivered, [
      { queue: "system-task-maintenance", id: systemId },
      { queue: "_outbox:notifications", id: notificationId },
      { queue: "_outbox:play-events", id: playId },
    ]);
    honker.configureHonkerQueueWake(() => { throw new Error("disconnected owner"); });
    const queuedId = honker.enqueueSystemTaskJob({ kind: "session-cleanup" }, { delaySeconds: 120 });
    assert.ok(honker.listHonkerJobs("system-task-maintenance").some((row) => row.id === queuedId && row.run_at > Date.now() / 1000));
  } finally {
    honker.configureHonkerQueueWake(null);
    for (const row of honker.listHonkerJobs("system-task-maintenance")) {
      honker.getMaintenanceTaskQueue().cancel(row.id);
    }
    process.env.NODE_ENV = "test";
  }
});

test("web finds the owners of due work and due schedules without a wake", () => {
  const now = Math.floor(Date.now() / 1000);
  const database = honker.getHonkerDb();
  const scheduler = database.scheduler();
  const execute = (sql, params) => {
    const tx = database.transaction();
    tx.execute(sql, params);
    tx.commit();
  };
  const hasWork = (group) => honker.listBackgroundGroupsWithWork().includes(group);
  const dueId = honker.getMaintenanceTaskQueue().enqueue({ kind: "session-cleanup" });
  const laterId = honker.getReleaseMetadataQueue().enqueue({ kind: "release-metadata-refresh" }, { runAt: now + 600 });
  const claimedId = honker.getInboxTaskQueue().enqueue({ kind: "inbox-refresh" });
  try {
    assert.equal(honker.getInboxTaskQueue().claimOne("disposable-live-owner")?.id, claimedId);
    assert.equal(hasWork("maintenance"), true);
    assert.equal(hasWork("release-metadata"), false);
    assert.equal(hasWork("inbox"), false);

    execute("UPDATE _honker_live SET claim_expires_at = ? WHERE id = ?", [now - 1, claimedId]);
    assert.equal(hasWork("inbox"), true);

    scheduler.add({
      name: "disposable-demand",
      queue: "system-task-maintenance",
      schedule: "@every 1h",
      payload: { kind: "session-cleanup" },
    });
    assert.equal(hasWork("scheduler"), false);
    execute("UPDATE _honker_scheduler_tasks SET next_fire_at = ? WHERE name = ?", [now - 1, "disposable-demand"]);
    assert.equal(hasWork("scheduler"), true);
    scheduler.pause("disposable-demand");
    assert.equal(hasWork("scheduler"), false);
  } finally {
    scheduler.remove("disposable-demand");
    execute("DELETE FROM _honker_live WHERE id IN (?, ?, ?)", [dueId, laterId, claimedId]);
  }
});

test("web wakeups drain a burst in a real isolated owner process", { timeout: 10000 }, async (t) => {
  const ready = Promise.withResolvers();
  const drained = Promise.withResolvers();
  const completed = new Set();
  const expected = new Set();
  const fixture = fileURLToPath(new URL("../fixtures/queue-wake-child.mjs", import.meta.url));
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["maintenance"],
    findGroupsWithWork: () => ["maintenance"],
    forkProcess: (_entry, args, options) => fork(fixture, args, options),
    onMessage(message) {
      if (message.type === "ready") ready.resolve();
      if (message.type === "job-finished" && expected.has(message.jobId)) {
        completed.add(message.jobId);
        if (completed.size === expected.size) drained.resolve();
      }
    },
  });
  t.after(async () => {
    honker.configureHonkerQueueWake(null);
    process.env.NODE_ENV = "test";
    await supervisor.stop();
  });
  supervisor.start();
  await ready.promise;
  process.env.NODE_ENV = "production";
  honker.configureHonkerQueueWake((queue) => {
    if (queue === "system-task-maintenance") supervisor.wake("maintenance");
  });
  for (let index = 0; index < 100; index++) {
    expected.add(honker.enqueueSystemTaskJob({ kind: "session-cleanup" }));
  }
  await drained.promise;
  assert.equal(completed.size, 100);
  assert.equal(honker.listHonkerJobs("system-task-maintenance").length, 0);
});
