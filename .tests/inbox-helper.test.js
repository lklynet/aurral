import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "inbox-helper",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let userId;

test.before(() => {
  resetDatabase(db);
  userId = userOps.createUser("inbox-user", "password-hash").id;
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("inbox items preserve read state while source metadata updates", () => {
  const first = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "artist:release",
    title: "New record",
    subtitle: "Artist",
    metadata: { releaseDate: "2026-08-05" },
  });
  assert.equal(first.isRead, false);
  assert.equal(dbOps.getInboxUnreadCount(userId), 1);

  const read = dbOps.updateInboxItem(userId, first.id, { isRead: true });
  assert.equal(read.isRead, true);
  assert.equal(dbOps.getInboxUnreadCount(userId), 0);

  const refreshed = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "artist:release",
    title: "New record (updated)",
    metadata: { releaseDate: "2026-08-06" },
  });
  assert.equal(refreshed.title, "New record (updated)");
  assert.equal(refreshed.isRead, true);
});
