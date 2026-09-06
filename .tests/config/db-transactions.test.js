import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db, DB_PATH }] = await setupIsolatedBackend(
  "db-transactions",
  "backend/config/db-sqlite.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("db.transaction takes the write lock up front", () => {
  const other = new Database(DB_PATH);
  other.pragma("busy_timeout = 0");
  try {
    db.transaction(() => {
      // A deferred transaction would still be a reader here and let the other
      // connection write first, failing this one later with SQLITE_BUSY_SNAPSHOT.
      assert.throws(() => other.prepare("BEGIN IMMEDIATE").run(), /database is locked/);
      db.prepare("SELECT COUNT(*) FROM settings").get();
    })();
    other.prepare("BEGIN IMMEDIATE").run();
    other.prepare("ROLLBACK").run();
    // Read-only callers can still opt into a deferred transaction.
    db.transaction(() => {
      other.prepare("BEGIN IMMEDIATE").run();
      other.prepare("ROLLBACK").run();
    }).deferred();
  } finally {
    other.close();
  }
});
