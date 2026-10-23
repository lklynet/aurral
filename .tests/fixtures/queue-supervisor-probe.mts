import assert from "node:assert/strict";
import { mock } from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const scenario = process.argv[2];
process.env.AURRAL_BACKGROUND_WORKER_GROUP = scenario === "settings" ? "downloads" : "maintenance";
if (scenario !== "fallback") process.env.AURRAL_WORKER_SUPERVISOR_POLL_MS = "120000";
const [state, honker, runtime] = await setupIsolatedBackend("supervisor-probe", () => import("../../backend/services/honkerDb.ts"), () => import("../../backend/services/appRuntime.ts"));
const queue = scenario === "settings" ? honker.getPipelineQueue() : honker.getMaintenanceTaskQueue();
const now = Math.floor(Date.now() / 1000);
const pump = async () => { for (let index = 0; index < 100; index++) await new Promise(setImmediate); };
try {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
  if (scenario === "settings") {
    const { dbOps } = await import("../../backend/db/helpers/index.ts");
    dbOps.updateSettings({ integrations: { ytdlp: { enabled: false } } });
    runtime.startWorkerSupervisor({ group: "downloads" });
    const id = queue.enqueue({ jobId: "disposable-missing-track", phase: "search" }, { runAt: now });
    runtime.wakeQueuedBackgroundWork("downloads");
    await pump();
    assert.ok(queue.getJob(id), "an unconfigured download source must not run");
    dbOps.getSettings();
    const tx = honker.getHonkerDb().transaction();
    tx.execute("UPDATE settings SET value = ? WHERE key = 'integrations'", [JSON.stringify({ ytdlp: { enabled: false }, deemix: { enabled: true, url: "http://127.0.0.1:9999" } })]);
    tx.commit();
    const updates = honker.getHonkerDb().updateEvents();
    try {
      runtime.wakeQueuedBackgroundWork("downloads");
      while (queue.getJob(id)) await updates.next();
    } finally {
      updates.close();
    }
    assert.equal(queue.getJob(id), null, "new source settings must take effect without waiting for the settings cache");
  } else if (scenario === "deadline") {
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
    const id = queue.enqueue({ kind: "session-cleanup" }, { runAt: now });
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
