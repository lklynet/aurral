import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { downloadPipelineQueue: queue }] = await setupIsolatedBackend(
  "download-pipeline-priority",
  () => import("../../backend/services/jobs/queues.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("the download pipeline claims active transfer phases before searches and upgrades last", () => {
  queue.enqueue({ phase: "search", jobId: "search" });
  queue.enqueue({ phase: "finalize", jobId: "upgrade", upgrade: true });
  queue.enqueue({ phase: "poll", jobId: "poll" });
  queue.enqueue({ phase: "download", jobId: "download" });
  queue.enqueue({ phase: "finalize", jobId: "finalize" });

  const claimed: unknown[] = [];
  for (let job = queue.claim("priority-test"); job; job = queue.claim("priority-test")) {
    claimed.push(job.payload?.jobId);
    job.ack();
  }
  assert.deepEqual(claimed, ["finalize", "download", "poll", "search", "upgrade"]);
});
