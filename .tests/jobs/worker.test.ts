import assert from "node:assert/strict";
import * as v from "valibot";
import { test, beforeEach, afterAll } from "vite-plus/test";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";
import { insertJob } from "../helpers/jobs.ts";

const [state, { db }, { defineQueue }, { createJobWorker }, { logger }] =
  await setupIsolatedBackend(
    "job-worker",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/jobs/queue.ts"),
    () => import("../../backend/services/jobs/worker.ts"),
    () => import("../../backend/services/logger.ts"),
  );
useFakeClock();

const queue = defineQueue<{ kind: string }>({
  name: "test-worker-jobs",
  group: "maintenance",
  leaseMs: 30_000,
  maxAttempts: 3,
  retryDelayMs: 1000,
  timeoutMs: 30_000,
  skipInTest: true,
  start: async () => undefined,
});
const schema = v.looseObject({ kind: v.string() });

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(state));

function untilAborted(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function captureLogs() {
  const events: { level: string; message: string; data?: object }[] = [];
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = (_category, message, data) => events.push({ level: "warn", message, data });
  logger.error = (_category, message, data) => events.push({ level: "error", message, data });
  return {
    events,
    [Symbol.dispose]() {
      Object.assign(logger, original);
    },
  };
}

test("stopping a worker lets its running job finish and settle", async () => {
  const id = queue.enqueue({ kind: "finish" });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = createJobWorker(queue, {
    schema,
    processJob: async () => {
      started.resolve();
      await release.promise;
    },
  });
  void worker.start();
  await started.promise;
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release.resolve();
  await stopping;
  assert.equal(queue.getJob(id)?.state, "done");
});

test("stopping an interruptible job puts it back without spending its last attempt", async () => {
  const id = queue.enqueue({ kind: "interrupt" });
  db.prepare("UPDATE jobs SET attempts = 2 WHERE id = ?").run(id);
  const started = Promise.withResolvers<void>();
  const worker = createJobWorker(queue, {
    schema,
    interruptible: true,
    processJob: (_payload, _job, { signal }) => {
      started.resolve();
      return untilAborted(signal);
    },
  });
  void worker.start();
  await started.promise;
  await worker.stop();
  const row = queue.getJob(id);
  assert.deepEqual([row?.state, row?.attempts, row?.worker_id], ["pending", 2, null]);
  const retry = queue.claim("replacement", Date.now() + 1000);
  assert.equal(retry?.id, id);
  assert.equal(retry.attempts, 3);
});

test("cancelling a running job aborts its work and leaves it cancelled", async () => {
  const id = queue.enqueue({ kind: "cancel" });
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const worker = createJobWorker(queue, {
    schema,
    processJob: (_payload, _job, { signal }) => {
      started.resolve();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return untilAborted(signal);
    },
  });
  void worker.start();
  await started.promise;
  assert.equal(queue.cancel(id), true);
  await aborted.promise;
  await worker.stop();
  assert.equal(queue.getJob(id)?.state, "cancelled");
});

test("a failing job retries, then fails, and the log leaves out its payload", async () => {
  using logs = captureLogs();
  const id = insertJob(db, queue.name, { kind: "flaky", secret: "do-not-log" }, { maxAttempts: 2 });
  const failed = Promise.withResolvers<void>();
  const worker = createJobWorker(queue, {
    schema,
    processJob: () => {
      throw new Error("source unavailable");
    },
    onFinalFailure: () => failed.resolve(),
  });
  void worker.start();
  await failed.promise;
  await worker.stop();
  assert.deepEqual(
    logs.events.map(({ level, message, data }) => [
      level,
      message,
      Reflect.get(data ?? {}, "attempt"),
    ]),
    [
      ["warn", "Job attempt failed; retrying", 1],
      ["error", "Job failed", 2],
    ],
  );
  assert.ok(!JSON.stringify(logs.events).includes("do-not-log"));
  const row = queue.getJob(id);
  assert.deepEqual([row?.state, row?.last_error], ["failed", "source unavailable"]);
});

test("a job Aurral can't read fails at once without running", async () => {
  using logs = captureLogs();
  const id = insertJob(db, queue.name, { kind: 7 });
  let ran = false;
  const worker = createJobWorker(queue, {
    schema,
    processJob: () => {
      ran = true;
    },
  });
  const loop = worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.stop();
  await loop;
  assert.equal(ran, false);
  const row = queue.getJob(id);
  assert.deepEqual([row?.state, row?.attempts], ["failed", 1]);
  assert.deepEqual(
    logs.events.map((event) => event.message),
    ["Job payload unreadable"],
  );
});
