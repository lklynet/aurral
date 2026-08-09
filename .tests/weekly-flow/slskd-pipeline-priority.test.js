import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, honkerDb] = await setupIsolatedBackend(
  "slskd-pipeline-priority",
  "backend/services/honkerDb.js",
);

const { getPipelinePriorityForPhase, getPipelineQueue, enqueuePipelineJob } =
  honkerDb;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("slskd pipeline queue prioritizes active transfer phases over search", () => {
  assert.ok(getPipelinePriorityForPhase("search") < getPipelinePriorityForPhase("poll"));
  assert.ok(getPipelinePriorityForPhase("poll") < getPipelinePriorityForPhase("download"));
  assert.ok(
    getPipelinePriorityForPhase("download") < getPipelinePriorityForPhase("finalize"),
  );

  const queue = getPipelineQueue();
  enqueuePipelineJob({ phase: "search", jobId: "a" });
  enqueuePipelineJob({ phase: "search", jobId: "b" });
  enqueuePipelineJob({ phase: "finalize", jobId: "upgrade", upgrade: true });
  enqueuePipelineJob({ phase: "download", jobId: "a" });
  const claimed = queue.claimOne("priority-test-worker");
  assert.equal(claimed.payload.phase, "download");
  assert.equal(claimed.payload.jobId, "a");
  claimed.ack();
});
