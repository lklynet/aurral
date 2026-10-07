import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundProcessSupervisor } from "../../backend/services/backgroundProcessSupervisor.js";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, honker] = await setupIsolatedBackend("on-demand-workers", "backend/services/honkerDb.js");
test.after(() => cleanupIsolatedState(state));

test("a due schedule runs in background processes that exit once idle", { timeout: 30000 }, async (t) => {
  const scheduler = honker.getHonkerDb().scheduler();
  const previousIdleStop = process.env.AURRAL_WORKER_IDLE_STOP_MS;
  scheduler.add({
    name: "disposable-on-demand",
    queue: "system-task-maintenance",
    schedule: "@every 1h",
    payload: { kind: "session-cleanup" },
  });
  const tx = honker.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_scheduler_tasks SET next_fire_at = ? WHERE name = ?",
    [Math.floor(Date.now() / 1000) - 1, "disposable-on-demand"]);
  tx.commit();

  const finished = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const exits = [];
  process.env.NODE_ENV = "production";
  process.env.AURRAL_WORKER_IDLE_STOP_MS = "5000";
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["scheduler", "maintenance"],
    findGroupsWithWork: honker.listBackgroundGroupsWithWork,
    onMessage(message) {
      if (message.type === "job-finished") finished.resolve(message);
    },
    onExit(group, code, _signal, _pid, _reason, retired) {
      exits.push({ group, code, retired });
      if (exits.length === 2) exited.resolve();
    },
  });
  t.after(async () => {
    await supervisor.stop();
    scheduler.remove("disposable-on-demand");
    process.env.NODE_ENV = "test";
    if (previousIdleStop === undefined) delete process.env.AURRAL_WORKER_IDLE_STOP_MS;
    else process.env.AURRAL_WORKER_IDLE_STOP_MS = previousIdleStop;
  });

  supervisor.start();
  assert.deepEqual(supervisor.getGroups(), ["scheduler"]);
  assert.equal((await finished.promise).queue, "system-task-maintenance");
  await exited.promise;
  assert.deepEqual(exits.sort((a, b) => a.group.localeCompare(b.group)), [
    { group: "maintenance", code: 0, retired: true },
    { group: "scheduler", code: 0, retired: true },
  ]);
  assert.deepEqual(supervisor.getGroups(), []);
  assert.deepEqual(honker.listHonkerJobs("system-task-maintenance"), []);
  assert.deepEqual(honker.listBackgroundGroupsWithWork(), []);
});

test("the download owner cancels one persisted job over IPC", { timeout: 30000 }, async (t) => {
  const { downloadTracker } = await import("../../backend/services/downloadJobs/downloadTracker.js");
  const jobId = downloadTracker.addJob({ artistName: "Disposable IPC Artist", trackName: "Waiting song" }, "library");
  downloadTracker.setPending(jobId, "Waiting for retry", { asRetryCycle: true });
  const supervisor = createBackgroundProcessSupervisor({ groups: ["downloads"] });
  process.env.NODE_ENV = "production";
  t.after(async () => {
    await supervisor.stop();
    process.env.NODE_ENV = "test";
    downloadTracker.reconcileCommittedJobs();
  });
  supervisor.start();
  const result = await supervisor.request("downloads", "cancelTrackDownload", [jobId]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cleanupFailed, false);
  assert.equal(downloadTracker.getJob(jobId).status, "cancelled");
});
