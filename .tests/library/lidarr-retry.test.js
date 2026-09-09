import assert from "node:assert/strict";
import test from "node:test";

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

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("unavailable Lidarr keeps one retry job and continues its retry chain", async (t) => {
  t.mock.method(lidarrClient, "isConfigured", () => true);
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("provider unavailable");
  });
  const queue = honkerDb.getSystemTaskQueue();

  await libraryManager.syncLidarrArtists();
  for (let index = 0; index < 5; index += 1) {
    await libraryManager.syncLidarrArtists();
    await libraryManager.getRecentArtists();
  }
  await settleRetryEnqueues();

  const firstRetryJobs = getPendingRetryJobs();
  assert.equal(firstRetryJobs.length, 1);
  assert.equal(request.mock.callCount(), 1);

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
  assert.equal(request.mock.callCount(), 2);
  assert.equal(successorJobs.length, 1);
  assert.notEqual(successorJobs[0].id, claimedRetry.id);

  claimedRetry.ack();
  queue.cancel(successorJobs[0].id);
  await systemTaskWorker.stopSystemTaskWorker();
});
