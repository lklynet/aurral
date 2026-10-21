import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, honkerDb, libraryManagerModule, systemTaskWorker] =
  await setupIsolatedBackend(
    "lidarr-retry",
    "backend/config/db-sqlite.js",
    "backend/services/honkerDb.js",
    "backend/services/libraryManager.js",
    "backend/services/systemTaskWorker.js",
  );
const { lidarrClient } = await import("../../backend/services/lidarrClient.js");
const { libraryManager } = libraryManagerModule;

function getPendingRetryJobs() {
  return db
    .prepare(
      `
        SELECT id, payload
        FROM _honker_live
        WHERE queue = 'system-task' AND state = 'pending'
      `,
    )
    .all()
    .filter((row) => JSON.parse(row.payload)?.kind === "lidarr-retry");
}

async function settleRetryEnqueues() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("unavailable Lidarr keeps one retry job and continues its retry chain", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("provider unavailable");
  });
  const queue = honkerDb.getSystemTaskQueue();
  const backlogRunAt = Math.floor(Date.now() / 1000) + 3600;
  for (let index = 0; index < 101; index += 1) {
    queue.enqueue({ kind: `older-system-task-${index}` }, { runAt: backlogRunAt });
  }

  await libraryManager.syncLidarrArtists();
  for (let index = 0; index < 5; index += 1) {
    await libraryManager.syncLidarrArtists();
  }
  await settleRetryEnqueues();

  const firstRetryJobs = getPendingRetryJobs();
  assert.equal(firstRetryJobs.length, 1);
  assert.equal(request.mock.calls.length, 1);

  await systemTaskWorker.stopSystemTaskWorker();
  const firstRetryJob = firstRetryJobs[0];
  db.prepare("UPDATE _honker_live SET run_at = ? WHERE id = ?").run(
    Math.floor(Date.now() / 1000) - 1,
    firstRetryJob.id,
  );
  const claimedRetry = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(claimedRetry?.id, firstRetryJob.id);

  await systemTaskWorker.processSystemTask(
    { kind: "lidarr-retry" },
    claimedRetry,
  );
  await settleRetryEnqueues();

  const successorJobs = getPendingRetryJobs();
  assert.equal(request.mock.calls.length, 2);
  assert.equal(successorJobs.length, 1);
  assert.notEqual(successorJobs[0].id, claimedRetry.id);

  claimedRetry.ack();
  queue.cancel(successorJobs[0].id);
  await systemTaskWorker.stopSystemTaskWorker();
});
