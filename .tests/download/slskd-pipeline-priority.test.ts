import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, honkerDb] = await setupIsolatedBackend(
  "slskd-pipeline-priority",
  () => import("../../backend/services/honkerDb.ts"),
);

const { getPipelineQueue, enqueuePipelineJob } = honkerDb;

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("slskd pipeline claims active transfer phases before searches and upgrades last", () => {
  const queue = getPipelineQueue();
  enqueuePipelineJob({ phase: "search", jobId: "search" });
  enqueuePipelineJob({ phase: "finalize", jobId: "upgrade", upgrade: true });
  enqueuePipelineJob({ phase: "poll", jobId: "poll" });
  enqueuePipelineJob({ phase: "download", jobId: "download" });
  enqueuePipelineJob({ phase: "finalize", jobId: "finalize" });

  const claimed: string[] = [];
  for (
    let job = queue.claimOne("priority-test-worker");
    job;
    job = queue.claimOne("priority-test-worker")
  ) {
    claimed.push((job.payload as { jobId: string }).jobId);
    job.ack();
  }
  assert.deepEqual(claimed, ["finalize", "download", "poll", "search", "upgrade"]);
});
