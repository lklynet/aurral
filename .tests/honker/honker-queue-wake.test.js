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


test("web wakeups drain a burst in a real isolated owner process", { timeout: 10000 }, async (t) => {
  const ready = Promise.withResolvers();
  const drained = Promise.withResolvers();
  const completed = new Set();
  const expected = new Set();
  const fixture = fileURLToPath(new URL("../fixtures/queue-wake-child.mjs", import.meta.url));
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["maintenance"],
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
