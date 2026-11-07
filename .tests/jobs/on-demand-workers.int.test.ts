import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { createBackgroundProcessSupervisor } from "../../backend/services/backgroundProcessSupervisor.ts";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state, { db }, jobQueue, schedules] = await setupIsolatedBackend(
  "on-demand-workers",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/jobs/queue.ts"),
  () => import("../../backend/services/jobs/schedules.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test(
  "a due schedule runs in background processes that exit once idle",
  { timeout: 30000 },
  async (t: import("vite-plus/test").TestContext) => {
    const previousIdleStop = process.env.AURRAL_WORKER_IDLE_STOP_MS;
    schedules.syncSchedules();
    db.prepare("DELETE FROM job_schedules WHERE name != 'session-cleanup'").run();
    db.prepare("UPDATE job_schedules SET next_run_at = ?").run(Date.now() - 1);

    const started = Promise.withResolvers<{ payload: string | null }>();
    const finished = Promise.withResolvers<{ queue: string }>();
    const heartbeat = Promise.withResolvers<{ memory: { rss: number; heapUsed: number } }>();
    const exited = Promise.withResolvers<void>();
    const exits: { group: string; code: number | null; retired: boolean }[] = [];
    process.env.NODE_ENV = "production";
    process.env.AURRAL_WORKER_IDLE_STOP_MS = "5000";
    const supervisor = createBackgroundProcessSupervisor({
      groups: ["maintenance"],
      findGroupsWithWork: (now) => {
        schedules.runDueSchedules(now);
        return jobQueue.listGroupsWithWork(now);
      },
      getNextWorkAt: (now) => {
        const next = jobQueue.getNextWorkAt(now);
        return next != null && next - now > 60_000 ? null : next;
      },
      onMessage(message, group) {
        if (message.type === "job-started") started.resolve(message);
        if (message.type === "job-finished") finished.resolve(message);
        if (message.type === "heartbeat" && group === "maintenance") heartbeat.resolve(message);
      },
      onExit(group, code, _signal, _pid, _reason, retired) {
        exits.push({ group, code, retired });
        exited.resolve();
      },
    });
    t.onTestFinished(async () => {
      await supervisor.stop();
      db.prepare("DELETE FROM job_schedules").run();
      process.env.NODE_ENV = "test";
      if (previousIdleStop === undefined) delete process.env.AURRAL_WORKER_IDLE_STOP_MS;
      else process.env.AURRAL_WORKER_IDLE_STOP_MS = previousIdleStop;
    });

    supervisor.start();
    assert.deepEqual(supervisor.getGroups(), ["maintenance"]);
    assert.match((await started.promise).payload ?? "", /"kind":"session-cleanup"/);
    assert.equal((await finished.promise).queue, "system-task-maintenance");
    const { memory } = await heartbeat.promise;
    assert.ok(memory.rss > 0 && memory.heapUsed > 0);
    await exited.promise;
    assert.deepEqual(exits, [{ group: "maintenance", code: 0, retired: true }]);
    assert.deepEqual(supervisor.getGroups(), []);
    assert.deepEqual(db.prepare("SELECT kind, state FROM jobs").all(), [
      { kind: "session-cleanup", state: "done" },
    ]);
  },
);

test(
  "the download owner cancels one persisted job over IPC",
  { timeout: 30000 },
  async (t: import("vite-plus/test").TestContext) => {
    const { downloadTracker } =
      await import("../../backend/services/downloadJobs/downloadTracker.ts");
    const jobId = downloadTracker.addJob(
      { artistName: "Disposable IPC Artist", trackName: "Waiting song" },
      "library",
    );
    assert.ok(jobId != null);
    downloadTracker.setPending(jobId, "Waiting for retry", { asRetryCycle: true });
    const supervisor = createBackgroundProcessSupervisor({ groups: ["downloads"] });
    process.env.NODE_ENV = "production";
    t.onTestFinished(async () => {
      await supervisor.stop();
      process.env.NODE_ENV = "test";
      downloadTracker.reconcileCommittedJobs();
    });
    supervisor.start();
    const result = await supervisor.request("downloads", "cancelTrackDownload", [jobId]);
    assert.ok(
      result && typeof result === "object" && "status" in result && "cleanupFailed" in result,
    );
    assert.equal(result.status, "cancelled");
    assert.equal(result.cleanupFailed, false);
    assert.equal(downloadTracker.getJob(jobId)!.status, "cancelled");
  },
);
