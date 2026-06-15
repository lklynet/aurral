import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("slskd-pipeline-priority");
applyIsolatedBackendEnv(isolatedState);

const { getPipelinePriorityForPhase, getPipelineQueue, enqueuePipelineJob } =
  await importFromRepo("backend/services/honkerDb.js");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getPipelinePriorityForPhase ranks active transfer phases above search", () => {
  assert.ok(getPipelinePriorityForPhase("search") < getPipelinePriorityForPhase("poll"));
  assert.ok(getPipelinePriorityForPhase("poll") < getPipelinePriorityForPhase("download"));
  assert.ok(
    getPipelinePriorityForPhase("download") < getPipelinePriorityForPhase("finalize"),
  );
});

test("pipeline queue claims higher-priority phases before pending searches", () => {
  const queue = getPipelineQueue();
  enqueuePipelineJob({ phase: "search", jobId: "a" });
  enqueuePipelineJob({ phase: "search", jobId: "b" });
  enqueuePipelineJob({ phase: "download", jobId: "a" });
  const claimed = queue.claimOne("priority-test-worker");
  assert.equal(claimed.payload.phase, "download");
  assert.equal(claimed.payload.jobId, "a");
  claimed.ack();
});
