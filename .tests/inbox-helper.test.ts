import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "inbox-helper",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
);

let userId: number;

beforeAll(() => {
  resetDatabase(db);
  userId = userOps.createUser("inbox-user", "password-hash")!.id;
});

afterAll(async () => {
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
  assert.ok(first != null);
  assert.equal(first.isRead, false);
  assert.equal(dbOps.getInboxUnreadCount(userId), 1);

  const read = dbOps.updateInboxItem(userId, requireFixture(first.id), { isRead: true });
  assert.ok(read != null);
  assert.equal(read.isRead, true);
  assert.equal(dbOps.getInboxUnreadCount(userId), 0);

  const refreshed = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "artist:release",
    title: "New record (updated)",
    metadata: { releaseDate: "2026-08-06" },
  });
  assert.ok(refreshed != null);
  assert.equal(refreshed.title, "New record (updated)");
  assert.equal(refreshed.isRead, true);
});
