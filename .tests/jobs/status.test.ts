import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { insertJob } from "../helpers/jobs.ts";

const [state, { db }, { getTaskStatus, clearStaleJobs }] = await setupIsolatedBackend(
  "job-status",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/jobs/status.ts"),
);
const HOUR = 60 * 60 * 1000;

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(state));

function startJob(id: number, startedAt: number) {
  db.prepare(
    `UPDATE jobs SET state = 'running', attempts = 1, worker_id = 'library:test',
       started_at = ?, lease_until = ? WHERE id = ?`,
  ).run(startedAt, startedAt + 10 * HOUR, id);
}

test("task status counts queued jobs past the rows it lists", async () => {
  const now = Date.now();
  for (let index = 0; index < 501; index++) {
    insertJob(
      db,
      "download-pipeline",
      { jobId: `queued-${index}`, phase: "search" },
      { runAt: now },
    );
  }
  const status = await getTaskStatus(now);
  assert.equal(status.queue.length, 500);
  assert.equal(status.workers.find((entry) => entry.queue === "download-pipeline")?.queued, 501);
});

test("task status flags long runs and groups repeated scheduled jobs", async () => {
  const now = Date.now();
  const fresh = insertJob(db, "library-scan", { force: true });
  startJob(fresh, now - 1000);
  const stuck = insertJob(db, "library-scan", { force: false });
  startJob(stuck, now - 2 * HOUR);
  for (const requestedAt of [1, 2]) {
    insertJob(
      db,
      "discovery-refresh",
      { reason: "scheduled", requestedAt, scheduleOnly: true },
      { runAt: now + 24 * HOUR },
    );
  }

  const status = await getTaskStatus(now);
  const worker = (queue: string) => status.workers.find((entry) => entry.queue === queue);
  const row = (jobId: number) => status.queue.find((entry) => entry.jobId === jobId);
  assert.equal(worker("library-scan")?.processing, 2);
  assert.deepEqual(
    [row(fresh)?.status, row(fresh)?.runningForMs, row(fresh)?.isStale],
    ["running", 1000, false],
  );
  assert.equal(row(stuck)?.isStale, true);
  assert.equal(status.summary.staleCount, 1);
  assert.equal(status.summary.healthy, false);
  const discovery = status.queue.filter((entry) => entry.queue === "discovery-refresh");
  assert.deepEqual(
    discovery.map((entry) => [entry.name, entry.duplicateCount]),
    [["Discovery auto refresh", 2]],
  );
  assert.equal(worker("discovery-refresh")?.scheduled, 2);
});

test("clearing stuck jobs cancels only work running past the stale limit", async () => {
  const now = Date.now();
  const fresh = insertJob(db, "library-scan", { force: true });
  startJob(fresh, now - 1000);
  const stuck = insertJob(db, "library-scan", { force: false });
  startJob(stuck, now - 2 * HOUR);

  assert.deepEqual(clearStaleJobs(now), { cleared: 1 });

  const states = db
    .prepare<[], { id: number; state: string }>("SELECT id, state FROM jobs ORDER BY id")
    .all();
  assert.deepEqual(states, [
    { id: fresh, state: "running" },
    { id: stuck, state: "cancelled" },
  ]);
  const status = await getTaskStatus(now);
  assert.equal(status.summary.staleCount, 0);
});
