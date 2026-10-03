import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { db }, honker, store] = await setupIsolatedBackend(
  "bulk-operation-lifecycle", "backend/config/db-sqlite.js", "backend/services/honkerDb.js",
  "backend/services/playlists/bulkOperationStore.js",
);
test.after(() => cleanupIsolatedState(state));

test("bulk acceptance commits its queue job and durable progress together", () => {
  const result = store.enqueueBulkOperation({ ownerUserId: 1, sourcePlaylistId: "source", action: "remove", selections: [{ jobId: "one" }] });
  assert.equal(result.queued, true);
  const persisted = store.getBulkOperation(result.operationId);
  assert.equal(persisted.state, "queued");
  assert.equal(persisted.ownerUserId, 1);
  assert.deepEqual(persisted.selections, [{ jobId: "one" }]);
  const claimed = honker.getPlaylistOperationQueue().claimOne("bulk-test");
  assert.equal(claimed.id, result.operationId);
  assert.equal(claimed.payload.kind, "shared-playlist-bulk");
  store.saveBulkOperation({ ...persisted, state: "completed", outcomes: [{ jobId: "one", status: "removed" }] });
  claimed.ack();
  assert.equal(store.getBulkOperation(result.operationId).state, "completed");
});

test("failed progress persistence rolls back queue acceptance", () => {
  const before = honker.getHonkerQueueDepth("weekly-flow-operation");
  db.exec("CREATE TRIGGER reject_bulk_result BEFORE INSERT ON settings WHEN NEW.key LIKE 'playlistBulkOperation:%' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END");
  try {
    assert.throws(() => store.enqueueBulkOperation({ ownerUserId: 1, sourcePlaylistId: "source", selections: [] }), /fixture persistence failure/);
    assert.equal(honker.getHonkerQueueDepth("weekly-flow-operation"), before);
  } finally {
    db.exec("DROP TRIGGER reject_bulk_result");
  }
});

test("cleanup bounds terminal results per owner and preserves live work", () => {
  const live = store.enqueueBulkOperation({ ownerUserId: 2, sourcePlaylistId: "source", selections: [] });
  for (let index = 0; index < 105; index++) {
    store.saveBulkOperation({ operationId: 10000 + index, ownerUserId: 2, sourcePlaylistId: "source", state: "completed", updatedAt: Date.now() + index });
  }
  store.saveBulkOperation({ operationId: 20000, ownerUserId: 3, sourcePlaylistId: "source", state: "completed", updatedAt: Date.now() - 8 * 86400000 });
  store.cleanupBulkOperations();
  assert.equal(store.getBulkOperation(live.operationId).state, "queued");
  assert.equal(store.getBulkOperation(10000), null);
  assert.equal(store.getBulkOperation(10104).state, "completed");
  assert.equal(store.getBulkOperation(20000), null);
  assert.equal(db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'playlistBulkOperation:%'").get().count, 102);
});
