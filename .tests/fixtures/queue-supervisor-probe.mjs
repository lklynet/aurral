import assert from "node:assert/strict";
import { mock } from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

process.env.AURRAL_BACKGROUND_WORKER_GROUP = "maintenance";
const scenario = process.argv[2];
if (scenario !== "fallback") process.env.AURRAL_WORKER_SUPERVISOR_POLL_MS = "120000";
const [state, honker, runtime] = await setupIsolatedBackend("supervisor-probe", "backend/services/honkerDb.js", "backend/services/appRuntime.js");
const queue = honker.getMaintenanceTaskQueue();
const now = Math.floor(Date.now() / 1000);
const pump = async () => { for (let index = 0; index < 100; index++) await new Promise(setImmediate); };
try {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
  if (scenario === "deadline") {
    mock.timers.setTime(now * 1000);
    const laterId = queue.enqueue({ kind: "session-cleanup" }, { runAt: now + 20 });
    runtime.startWorkerSupervisor({ group: "maintenance" });
    const earlierId = queue.enqueue({ kind: "session-cleanup" }, { runAt: now + 10 });
    runtime.wakeQueuedBackgroundWork("maintenance");
    mock.timers.tick(9500);
    runtime.wakeQueuedBackgroundWork("maintenance");
    const tx = honker.getHonkerDb().transaction();
    tx.execute("UPDATE _honker_live SET run_at = ? WHERE id = ?", [now, earlierId]);
    tx.commit();
    await pump();
    assert.ok(queue.getJob(earlierId), "the deadline must not fire early");
    mock.timers.tick(500);
    await pump();
    assert.equal(queue.getJob(earlierId), null, "an earlier wake deadline must survive later inspections");
    assert.ok(queue.getJob(laterId), "later scheduled work must stay pending");
  } else {
    runtime.startWorkerSupervisor({ group: "maintenance" });
    const id = queue.enqueue({ kind: "session-cleanup" });
    if (scenario === "expiry") {
      queue.claimOne("disposable-expired-owner");
      const tx = honker.getHonkerDb().transaction();
      tx.execute("UPDATE _honker_live SET claim_expires_at = ? WHERE id = ?", [now - 1, id]);
      tx.commit();
      mock.timers.tick(30000);
    } else {
      mock.timers.tick(2000);
    }
    await pump();
    assert.equal(queue.getJob(id), null, scenario === "expiry"
      ? "supervisor should recover expired work by 30 seconds"
      : "supervisor should start work inserted without a wake by 2 seconds");
  }
} finally {
  mock.timers.reset();
  await cleanupIsolatedState(state);
}
process.exit(0);
