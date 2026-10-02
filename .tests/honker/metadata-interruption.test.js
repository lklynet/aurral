import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [paths, { default: createWorker }, { getSystemTaskQueue }, { db }] =
  await setupIsolatedBackend("metadata-interruption", "backend/services/honkerWorkerFactory.js",
    "backend/services/honkerDb.js", "backend/config/db-sqlite.js");
after(() => cleanupIsolatedState(paths));

test("shutdown preserves unfinished metadata at its final retry attempt", async () => {
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  db.prepare("UPDATE _honker_live SET attempts = 2 WHERE id = ?").run(id);
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const worker = createWorker({
    name: "system-task", getQueue: () => queue, idlePollS: 1,
    interruptible: true,
    async processJob(payload, job, { signal } = {}) {
      reached();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
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
  const { acquireReleaseMetadataLease } = await import("../../backend/services/releaseMetadataLease.js");
  const { prepareSystemTask } = await import("../../backend/services/systemTaskWorker.js");
  const lease = await acquireReleaseMetadataLease();
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  let dequeued;
  const claimed = new Promise((resolve) => { dequeued = resolve; });
  let executed = false;
  const worker = createWorker({
    name: "system-task", getQueue: () => queue, idlePollS: 1,
    interruptible: true, prepareJob: prepareSystemTask,
    onJobDequeue: () => dequeued(),
    processJob() { executed = true; },
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
  const { requeueInterruptedHonkerJob, getWorkerId } = await import("../../backend/services/honkerDb.js");
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  const claim = queue.claimOne(getWorkerId());
  db.prepare("UPDATE _honker_live SET worker_id = ?, attempts = 2 WHERE id = ?")
    .run("replacement-owner", id);
  try {
    requeueInterruptedHonkerJob(claim, queue);
    assert.equal(queue.getJob(id).state, "processing");
    assert.equal(queue.getJob(id).worker_id, "replacement-owner");
    assert.equal(queue.getJob(id).attempts, 2);
  } finally { queue.cancel(id); }
});

test("stopping immediately after start preserves an unexecuted final-attempt claim", async () => {
  const queue = getSystemTaskQueue();
  const id = queue.enqueue({ kind: "release-metadata-refresh" });
  db.prepare("UPDATE _honker_live SET attempts = 2 WHERE id = ?").run(id);
  let executed = false;
  const worker = createWorker({ name: "system-task", getQueue: () => queue,
    idlePollS: 1, interruptible: true, processJob() { executed = true; } });
  const loop = worker.start();
  await worker.stop();
  await loop;
  try {
    assert.equal(executed, false);
    assert.equal(queue.getJob(id)?.state, "pending");
    assert.equal(queue.getJob(id)?.attempts, 2);
  } finally { queue.cancel(id); }
});

test("lease renewal failure aborts a blocked provider request", async (t) => {
  const { acquireReleaseMetadataLease } = await import("../../backend/services/releaseMetadataLease.js");
  const { refreshReleaseMetadata } = await import("../../backend/services/releaseMetadataSync.js");
  const { default: axios } = await import("../../lib/axiosFetch.js");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const lease = await acquireReleaseMetadataLease();
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  t.mock.method(axios, "get", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    requested();
  }));
  const refresh = refreshReleaseMetadata({
    lease,
    artists: [{ id: 999, mbid: "45454545-4545-4454-8454-454545454545" }],
  });
  try {
    await started;
    db.prepare("UPDATE _honker_locks SET owner = ? WHERE name = ?")
      .run("replacement-owner", "release-metadata-refresh");
    t.mock.timers.tick(30000);
    await assert.rejects(refresh, { code: "HONKER_JOB_INTERRUPTED" });
  } finally {
    lease.release();
    db.prepare("DELETE FROM _honker_locks WHERE name = ?").run("release-metadata-refresh");
    t.mock.timers.reset();
  }
});
