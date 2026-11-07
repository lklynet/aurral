import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const [isolatedState, { db }, { systemTaskQueue: queue }, libraryManagerModule, systemTaskWorker] =
  await setupIsolatedBackend(
    "lidarr-retry",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/jobs/queues.ts"),
    () => import("../../backend/services/libraryManager.ts"),
    () => import("../../backend/services/systemTaskWorker.ts"),
  );
const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");
const { libraryManager } = libraryManagerModule;

function getPendingRetryJobs() {
  return db
    .prepare<[], { id: number }>(
      `
        SELECT id FROM jobs
        WHERE queue = 'system-task' AND kind = 'lidarr-retry' AND state = 'pending'
      `,
    )
    .all();
}

async function settleRetryEnqueues() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("unavailable Lidarr keeps one retry job and continues its retry chain", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("provider unavailable");
  });
  await libraryManager.syncLidarrArtists();
  for (let index = 0; index < 5; index += 1) {
    await libraryManager.syncLidarrArtists();
  }
  await settleRetryEnqueues();

  const firstRetryJobs = getPendingRetryJobs();
  assert.equal(firstRetryJobs.length, 1);
  assert.equal(request.mock.calls.length, 1);

  const firstRetryJob = requireFixture(firstRetryJobs[0]);
  db.prepare("UPDATE jobs SET run_at = ? WHERE id = ?").run(Date.now() - 1, firstRetryJob.id);
  const claimedRetry = queue.claim("lidarr-retry-test");
  assert.ok(claimedRetry != null);
  assert.equal(claimedRetry?.id, firstRetryJob.id);

  await systemTaskWorker.processSystemTask({ kind: "lidarr-retry" });
  await settleRetryEnqueues();

  const successorJobs = getPendingRetryJobs();
  assert.equal(request.mock.calls.length, 2);
  assert.equal(successorJobs.length, 1);
  assert.notEqual(requireFixture(successorJobs[0]).id, claimedRetry.id);

  claimedRetry.ack();
  queue.cancel(requireFixture(successorJobs[0]).id);
});
