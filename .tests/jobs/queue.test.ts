import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, jobs, schedules] = await setupIsolatedBackend(
  "job-queue",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/jobs/queue.ts"),
  () => import("../../backend/services/jobs/schedules.ts"),
);
const LEASE = 60_000;
const abandoned: number[] = [];
const queue = jobs.defineQueue<{ kind: string; ids?: string[] }>({
  name: "test-jobs",
  group: "maintenance",
  leaseMs: LEASE,
  maxAttempts: 3,
  retryDelayMs: 1000,
  backoff: "exponential",
  timeoutMs: LEASE,
  skipInTest: true,
  start: async () => undefined,
  onAbandoned: (job) => {
    abandoned.push(job.id);
  },
});
const CHILD = fileURLToPath(new URL("../fixtures/job-claim-child.mts", import.meta.url));

beforeEach(() => {
  resetDatabase(db);
  abandoned.length = 0;
});
afterAll(() => cleanupIsolatedState(state));

test("two processes claiming at once never share a job or a dedupe key", async () => {
  const ids = Array.from({ length: 200 }, () => queue.enqueue({ kind: "race" }));
  const children = [0, 1].map(() =>
    fork(CHILD, [], { env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] }),
  );
  const step = (message?: string) =>
    Promise.all(
      children.map((child) => {
        const reply = once(child, "message").then(([value]: unknown[]) => value);
        if (message) child.send(message);
        return reply;
      }),
    );
  await step();
  const deduped = new Set(await step("enqueue"));
  const claimed = (await step("claim")).flatMap((ids) => (Array.isArray(ids) ? ids : []));
  assert.equal(deduped.size, 1);
  assert.equal(new Set(claimed).size, claimed.length);
  assert.deepEqual(
    claimed.toSorted((a, b) => a - b),
    [...ids, ...deduped].map(Number).toSorted((a, b) => a - b),
  );
});

test("a worker whose lease lapsed cannot settle the job another worker reclaimed", () => {
  const id = queue.enqueue({ kind: "lease" });
  const now = Date.now();
  const stale = queue.claim("worker-a", now);
  assert.equal(stale?.id, id);
  assert.equal(queue.claim("worker-b", now + LEASE - 1), null);
  const fresh = queue.claim("worker-b", now + LEASE);
  assert.equal(fresh?.id, id);
  assert.equal(fresh.attempts, 2);
  assert.equal(stale.heartbeat(), "lost");
  assert.equal(stale.ack(), false);
  assert.equal(stale.fail("late"), false);
  assert.equal(fresh.ack(), true);
  assert.equal(queue.getJob(id)?.state, "done");
});

test("a lapsed lease on the last attempt fails the job instead of running it again", () => {
  const id = queue.enqueue({ kind: "lease" }, { maxAttempts: 1 });
  const now = Date.now();
  queue.claim("worker-a", now);
  assert.equal(queue.claim("worker-b", now + LEASE), null);
  const row = queue.getJob(id);
  assert.equal(row?.state, "failed");
  assert.equal(row?.last_error, "The worker stopped renewing its claim");
});

test("jobs left running by a crashed process go back to the queue and release its locks", async () => {
  const retried = queue.enqueue({ kind: "crash" });
  const spent = queue.enqueue({ kind: "crash" }, { maxAttempts: 1 });
  const cancelled = queue.enqueue({ kind: "crash" });
  for (let index = 0; index < 3; index++) queue.claim("maintenance:gone");
  queue.cancel(cancelled);
  jobs.tryLock("held-by-crash", "maintenance:gone", LEASE);
  jobs.tryLock("held-elsewhere", "downloads:alive", LEASE);

  assert.equal(await jobs.recoverAbandonedJobs("Worker exited", "maintenance"), 3);

  assert.deepEqual(abandoned, [retried, spent, cancelled]);
  assert.deepEqual(
    [retried, spent, cancelled].map((id) => {
      const row = queue.getJob(id);
      return [row?.state, row?.worker_id, row?.last_error];
    }),
    [
      ["pending", null, "Worker exited"],
      ["failed", null, "Worker exited"],
      ["cancelled", null, "Worker exited"],
    ],
  );
  assert.equal(jobs.isLockHeld("held-by-crash"), false);
  assert.equal(jobs.isLockHeld("held-elsewhere"), true);
});

test("cancelling reaches a running job through its next heartbeat", () => {
  const id = queue.enqueue({ kind: "cancel" });
  const job = queue.claim();
  assert.equal(job?.id, id);
  assert.equal(job.heartbeat(), "held");
  assert.equal(queue.cancel(id), true);
  assert.equal(queue.getJob(id)?.state, "running");
  assert.equal(job.heartbeat(), "cancelled");
  assert.equal(job.retry(0, "Cancelled"), true);
  assert.equal(queue.getJob(id)?.state, "cancelled");
  assert.equal(queue.claim(), null);
});

test("a dedupe key holds one active job and frees up once it finishes", () => {
  const first = queue.enqueue({ kind: "dedupe" }, { dedupeKey: "one" });
  assert.equal(queue.enqueue({ kind: "dedupe" }, { dedupeKey: "one" }), first);
  assert.notEqual(queue.enqueue({ kind: "dedupe" }, { dedupeKey: "two" }), first);
  const claimed = queue.claim();
  assert.equal(claimed?.id, first);
  assert.equal(queue.enqueue({ kind: "dedupe" }, { dedupeKey: "one" }), first);
  claimed.ack();
  assert.notEqual(queue.enqueue({ kind: "dedupe" }, { dedupeKey: "one" }), first);
});

test("merging folds into a waiting job only until it starts, and never pulls it earlier", () => {
  const merge = (ids: string[], runAt: number) =>
    queue.enqueue(
      { kind: "merge", ids },
      {
        runAt,
        mergeInto: (waiting) => ({
          kind: "merge",
          ids: [...(Array.isArray(waiting.ids) ? waiting.ids.map(String) : []), ...ids],
        }),
      },
    );
  const now = Date.now();
  const first = merge(["a"], now + 5000);
  assert.equal(merge(["b"], now), first);
  const waiting = queue.getJob(first);
  assert.deepEqual(JSON.parse(waiting?.payload ?? "null"), { kind: "merge", ids: ["a", "b"] });
  assert.equal(waiting?.run_at, now + 5000);
  assert.equal(queue.claim("worker", now + 5000)?.id, first);
  assert.notEqual(merge(["c"], now), first);
});

test("retries back off and stop at the attempts limit", () => {
  assert.deepEqual([1, 2, 3].map(queue.retryDelayFor), [1000, 2000, 4000]);
  const id = queue.enqueue({ kind: "retry" }, { maxAttempts: 2 });
  const now = Date.now();
  const first = queue.claim("worker", now);
  assert.ok(first?.retry(queue.retryDelayFor(first.attempts), "busy"));
  assert.equal(queue.claim("worker", now + 999), null);
  const second = queue.claim("worker", now + 5000);
  assert.equal(second?.id, id);
  assert.equal(second.attempts, second.maxAttempts);
  second.fail("still busy");
  assert.deepEqual(
    [queue.getJob(id)?.state, queue.getJob(id)?.last_error],
    ["failed", "still busy"],
  );
});

test("a lock passes to another owner only after its TTL lapses", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    assert.equal(jobs.tryLock("ttl", "a", 1000), true);
    assert.equal(jobs.tryLock("ttl", "a", 1000), false);
    assert.equal(jobs.tryLock("ttl", "b", 1000), false);
    vi.advanceTimersByTime(999);
    assert.equal(jobs.renewLock("ttl", "a", 1000), true);
    vi.advanceTimersByTime(999);
    assert.equal(jobs.tryLock("ttl", "b", 1000), false);
    vi.advanceTimersByTime(1);
    assert.equal(jobs.isLockHeld("ttl"), false);
    assert.equal(jobs.renewLock("ttl", "a", 1000), false);
    assert.equal(jobs.tryLock("ttl", "b", 1000), true);
    jobs.releaseLock("ttl", "a");
    assert.equal(jobs.ownsLock("ttl", "b"), true);
  } finally {
    vi.useRealTimers();
  }
});

test("a schedule fires once per due time, and once after a long outage", () => {
  const name = "release-metadata-refresh";
  const now = Date.now();
  schedules.syncSchedules(now);
  db.prepare("DELETE FROM job_schedules WHERE name != ?").run(name);
  const dueAt = now + 24 * 60 * 60 * 1000;
  const fired = () =>
    db
      .prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE kind = ?")
      .get(name)?.count;

  assert.deepEqual(schedules.runDueSchedules(dueAt - 1), []);
  assert.deepEqual(schedules.runDueSchedules(dueAt), [name]);
  assert.deepEqual(schedules.runDueSchedules(dueAt), []);
  assert.equal(fired(), 1);

  const afterOutage = dueAt + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(schedules.runDueSchedules(afterOutage), [name]);
  assert.deepEqual(schedules.runDueSchedules(afterOutage), []);
  assert.equal(schedules.listSchedules()[0]?.next_run_at, afterOutage + 24 * 60 * 60 * 1000);
});

test("an enqueue inside a transaction wakes its worker only after the commit", async () => {
  const seen: number[] = [];
  const stop = jobs.onQueueWake(queue.name, () => seen.push(queue.readyCount()));
  try {
    db.transaction(() => {
      queue.enqueue({ kind: "commit" });
      assert.deepEqual(seen, []);
    })();
    await Promise.resolve();
    assert.deepEqual(seen, [1]);
  } finally {
    stop();
  }
});
