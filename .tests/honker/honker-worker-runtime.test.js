import test from "node:test";
import assert from "node:assert/strict";
import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("honker-worker-runtime");
applyIsolatedBackendEnv(isolatedState);

await importFromRepo("backend/config/db-sqlite.js");

const honkerDb = await importFromRepo("backend/services/honkerDb.js");
const runtime = await importFromRepo("backend/services/honkerWorkerRuntime.js");
const operationQueueModule = await importFromRepo(
  "backend/services/weeklyFlowOperationQueue.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getHonkerQueueDepth counts claimable pending jobs", () => {
  honkerDb.getWeeklyFlowOperationQueue().enqueue({ kind: "noop-test" });
  const depth = honkerDb.getHonkerQueueDepth("weekly-flow-operation");
  assert.ok(depth >= 1);
});

test("withJobHeartbeat extends job claim while work runs", async () => {
  const queue = honkerDb.getImagePrefetchQueue();
  const jobId = queue.enqueue({ mbids: ["test-mbid"] });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const initialExpiry = job.claimExpiresAt;
  await runtime.withJobHeartbeat(job, queue, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  assert.ok(job.claimExpiresAt >= initialExpiry);
  job.ack();
});

test("weekly flow operation queue status reflects worker state and depth", () => {
  operationQueueModule.setWeeklyFlowOperationWorkerState({
    running: true,
    currentLabel: "manual-start-flow",
  });
  honkerDb.getWeeklyFlowOperationQueue().enqueue({ kind: "manual-start-flow" });
  const status = operationQueueModule.weeklyFlowOperationQueue.getStatus();
  assert.equal(status.processing, true);
  assert.equal(status.currentLabel, "manual-start-flow");
  assert.ok(status.pending >= 1);
  operationQueueModule.setWeeklyFlowOperationWorkerState({
    running: false,
    currentLabel: null,
  });
});
