import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  paths,
  { releaseMetadataQueue },
  { createJobWorker },
  { acquireReleaseMetadataLease },
  { systemTask, systemTaskSchema },
] = await setupIsolatedBackend(
  "release-metadata-lease",
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/jobs/worker.ts"),
  () => import("../../backend/services/releaseMetadataLease.ts"),
  () => import("../../backend/services/jobs/systemTasks.ts"),
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
    prepareJob: (payload, _job, context) => systemTask(payload.kind).prepare?.(context) ?? null,
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
