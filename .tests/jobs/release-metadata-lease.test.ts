import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  paths,
  { db },
  { releaseMetadataQueue, systemTaskSchema },
  { createJobWorker },
  { acquireReleaseMetadataLease },
  { prepareSystemTask },
] = await setupIsolatedBackend(
  "release-metadata-lease",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/jobs/worker.ts"),
  () => import("../../backend/services/releaseMetadataLease.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
);
afterAll(() => cleanupIsolatedState(paths));

test("a metadata refresh waiting on another's lease stops without running or spending an attempt", async () => {
  const lease = await acquireReleaseMetadataLease();
  const id = releaseMetadataQueue.enqueue({ kind: "release-metadata-refresh" });
  const dequeued = Promise.withResolvers<void>();
  let executed = false;
  const worker = createJobWorker(releaseMetadataQueue, {
    schema: systemTaskSchema,
    interruptible: true,
    prepareJob: prepareSystemTask,
    onJobDequeue: () => dequeued.resolve(),
    processJob: () => {
      executed = true;
    },
  });
  try {
    void worker.start();
    await dequeued.promise;
    await worker.stop();
    assert.equal(executed, false);
    const row = releaseMetadataQueue.getJob(id);
    assert.deepEqual([row?.state, row?.attempts], ["pending", 0]);
  } finally {
    lease.release();
    releaseMetadataQueue.cancel(id);
  }
});

test("losing the lease aborts a blocked provider request", async () => {
  const { refreshReleaseMetadata } = await import("../../backend/services/releaseMetadataSync.ts");
  const { http } = await import("../../lib/http.ts");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], now: 0 });
  const lease = await acquireReleaseMetadataLease();
  const requested = Promise.withResolvers<void>();
  vi.spyOn(http, "get").mockImplementation(
    (_url, config) =>
      new Promise<never>((_resolve, reject) => {
        const signal = config?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        requested.resolve();
      }),
  );
  const refresh = refreshReleaseMetadata({
    lease,
    artists: [{ id: 999, mbid: "45454545-4545-4454-8454-454545454545" }],
  });
  try {
    await requested.promise;
    db.prepare("UPDATE job_locks SET owner = ? WHERE name = ?").run(
      "replacement-owner",
      "release-metadata-refresh",
    );
    vi.advanceTimersByTime(30000);
    await assert.rejects(refresh, { code: "JOB_INTERRUPTED" });
  } finally {
    lease.release();
    db.prepare("DELETE FROM job_locks WHERE name = ?").run("release-metadata-refresh");
    vi.useRealTimers();
  }
});
