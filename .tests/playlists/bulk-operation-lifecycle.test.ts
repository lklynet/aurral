import { requireFixture } from "./fixtures.ts";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state, { db }, honker, store] = await setupIsolatedBackend(
  "bulk-operation-lifecycle",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/playlists/bulkOperationStore.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test("bulk acceptance commits its queue job and durable progress together", () => {
  const result = store.enqueueBulkOperation({
    ownerUserId: 1,
    sourcePlaylistId: "source",
    action: "remove",
    target: null,
    selections: [
      {
        jobId: "one",
        membershipId: "one",
        jobPlaylistId: "source",
        jobGeneration: 0,
        jobCreatedAt: 1,
      },
    ],
  });
  assert.equal(result.queued, true);
  const persisted = store.getBulkOperation(result.operationId);
  assert.ok(persisted != null);
  assert.equal(persisted.state, "queued");
  assert.equal(persisted.ownerUserId, 1);
  assert.deepEqual(persisted.selections, [
    {
      jobId: "one",
      membershipId: "one",
      jobPlaylistId: "source",
      jobGeneration: 0,
      jobCreatedAt: 1,
    },
  ]);
  const claimed = honker.getPlaylistOperationQueue().claimOne("bulk-test");
  assert.ok(claimed != null);
  assert.equal(claimed.id, result.operationId);
  assert.ok(
    claimed.payload && typeof claimed.payload === "object" && !Array.isArray(claimed.payload),
  );
  assert.equal(claimed.payload.kind, "shared-playlist-bulk");
  store.saveBulkOperation({
    ...persisted,
    state: "completed",
    outcomes: [{ jobId: "one", status: "removed" }],
  });
  claimed.ack();
  assert.equal(
    requireFixture(requireFixture(store).getBulkOperation(result.operationId)).state,
    "completed",
  );
});

test("failed progress persistence rolls back queue acceptance", () => {
  const before = honker.getHonkerQueueDepth("weekly-flow-operation");
  db.exec(
    "CREATE TRIGGER reject_bulk_result BEFORE INSERT ON settings WHEN NEW.key LIKE 'playlistBulkOperation:%' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END",
  );
  try {
    assert.throws(
      () =>
        store.enqueueBulkOperation({
          ownerUserId: 1,
          sourcePlaylistId: "source",
          action: "remove",
          target: null,
          selections: [],
        }),
      /fixture persistence failure/,
    );
    assert.equal(honker.getHonkerQueueDepth("weekly-flow-operation"), before);
  } finally {
    db.exec("DROP TRIGGER reject_bulk_result");
  }
});

test("cleanup bounds terminal results per owner and preserves live work", () => {
  const live = store.enqueueBulkOperation({
    ownerUserId: 2,
    sourcePlaylistId: "source",
    action: "remove",
    target: null,
    selections: [],
  });
  for (let index = 0; index < 105; index++) {
    store.saveBulkOperation({
      operationId: 10000 + index,
      ownerUserId: 2,
      sourcePlaylistId: "source",
      state: "completed",
      action: "remove",
      target: null,
      selections: [],
      outcomes: [],
      synchronization: {},
      createdAt: Date.now(),
      updatedAt: Date.now() + index,
    });
  }
  store.saveBulkOperation({
    operationId: 20000,
    ownerUserId: 3,
    sourcePlaylistId: "source",
    state: "completed",
    action: "remove",
    target: null,
    selections: [],
    outcomes: [],
    synchronization: {},
    createdAt: Date.now(),
    updatedAt: Date.now() - 8 * 86400000,
  });
  store.cleanupBulkOperations();
  assert.equal(
    requireFixture(requireFixture(store).getBulkOperation(live.operationId)).state,
    "queued",
  );
  assert.equal(store.getBulkOperation(10000), null);
  assert.equal(requireFixture(requireFixture(store).getBulkOperation(10104)).state, "completed");
  assert.equal(store.getBulkOperation(20000), null);
  assert.equal(
    db
      .prepare<[], { count: number }>(
        "SELECT count(*) AS count FROM settings WHERE key LIKE 'playlistBulkOperation:%'",
      )
      .get()?.count,
    102,
  );
});

test("cleanup skips a listed result that is gone when it is read", () => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "PLAYLISTBULKOPERATION:30001",
    "{}",
  );
  assert.equal(store.getBulkOperation(30001), null);
  store.saveBulkOperation({
    operationId: 30002,
    ownerUserId: 4,
    sourcePlaylistId: "source",
    state: "completed",
    action: "remove",
    target: null,
    selections: [],
    outcomes: [],
    synchronization: {},
    createdAt: Date.now(),
    updatedAt: Date.now() - 8 * 86400000,
  });
  store.cleanupBulkOperations();
  assert.equal(store.getBulkOperation(30002), null);
});
