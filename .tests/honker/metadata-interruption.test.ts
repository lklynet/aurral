import * as v from "valibot";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [paths, { default: createWorker }, { getSystemTaskQueue }, { db }] =
  await setupIsolatedBackend(
    "metadata-interruption",
    () => import("../../backend/services/honkerWorkerFactory.ts"),
    () => import("../../backend/services/honkerDb.ts"),
    () => import("../../backend/config/db-sqlite.ts"),
  );
afterAll(() => cleanupIsolatedState(paths));

test("shutdown preserves unfinished metadata at its final retry attempt", async () => {
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  db.prepare("UPDATE _honker_live SET attempts = 2 WHERE id = ?").run(id);
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const worker = createWorker({
    name: "system-task",
    schema: v.unknown(),
    getQueue: () => queue,
    idlePollS: 1,
    interruptible: true,
    async processJob(payload, job, { signal }) {
      reached();
      await new Promise<never>((resolve, reject) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    },
  });
  const loop = worker.start();
  await started;
  await worker.stop();
  await loop;
  const unfinished = queue.getJob(id);
  assert.equal(unfinished?.state, "pending");
  assert.equal(unfinished.attempts, 2);
  assert.equal(unfinished.worker_id, null);
  db.prepare("UPDATE _honker_live SET run_at = unixepoch() WHERE id = ?").run(id);
  const retry = queue.claimOne("replacement-worker");
  assert.equal(retry?.id, id);
  assert.equal(retry.attempts, 3);
  retry.ack();
  assert.equal(queue.getJob(id), null);
});

test("shutdown interrupts a contending metadata claim without executing it", async () => {
  const { acquireReleaseMetadataLease } =
    await import("../../backend/services/releaseMetadataLease.ts");
  const { prepareSystemTask, systemTaskSchema } =
    await import("../../backend/services/systemTaskWorker.ts");
  const lease = await acquireReleaseMetadataLease();
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  let dequeued!: () => void;
  const claimed = new Promise<void>((resolve) => {
    dequeued = resolve;
  });
  let executed = false;
  const worker = createWorker({
    name: "system-task",
    schema: systemTaskSchema,
    getQueue: () => queue,
    idlePollS: 1,
    interruptible: true,
    prepareJob: prepareSystemTask,
    onJobDequeue: () => dequeued(),
    processJob() {
      executed = true;
    },
  });
  try {
    const loop = worker.start();
    await claimed;
    await worker.stop();
    await loop;
    assert.equal(executed, false);
    assert.equal(queue.getJob(id)?.state, "pending");
    assert.equal(queue.getJob(id)?.attempts, 0);
  } finally {
    lease.release();
    queue.cancel(id);
  }
});

test("an interrupted stale claim cannot overwrite its replacement owner", async () => {
  const { requeueInterruptedHonkerJob, getWorkerId } =
    await import("../../backend/services/honkerDb.ts");
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  const claim = queue.claimOne(getWorkerId());
  assert.ok(claim != null);
  db.prepare("UPDATE _honker_live SET worker_id = ?, attempts = 2 WHERE id = ?").run(
    "replacement-owner",
    id,
  );
  try {
    requeueInterruptedHonkerJob(claim, queue);
    assert.equal(queue.getJob(id)!.state, "processing");
    assert.equal(queue.getJob(id)!.worker_id, "replacement-owner");
    assert.equal(queue.getJob(id)!.attempts, 2);
  } finally {
    queue.cancel(id);
  }
});

test("lease renewal failure aborts a blocked provider request", async () => {
  const { acquireReleaseMetadataLease } =
    await import("../../backend/services/releaseMetadataLease.ts");
  const { refreshReleaseMetadata } = await import("../../backend/services/releaseMetadataSync.ts");
  const { default: axios } = await import("../../lib/axiosFetch.ts");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], now: 0 });
  const lease = await acquireReleaseMetadataLease();
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  vi.spyOn(axios, "get").mockImplementation(
    (_url, config) =>
      new Promise<never>((_resolve, reject) => {
        const signal = config?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        requested();
      }),
  );
  const refresh = refreshReleaseMetadata({
    lease,
    artists: [{ id: 999, mbid: "45454545-4545-4454-8454-454545454545" }],
  });
  try {
    await started;
    db.prepare("UPDATE _honker_locks SET owner = ? WHERE name = ?").run(
      "replacement-owner",
      "release-metadata-refresh",
    );
    vi.advanceTimersByTime(30000);
    await assert.rejects(refresh, { code: "HONKER_JOB_INTERRUPTED" });
  } finally {
    lease.release();
    db.prepare("DELETE FROM _honker_locks WHERE name = ?").run("release-metadata-refresh");
    vi.useRealTimers();
  }
});
