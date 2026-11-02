import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

async function bootDb() {
  vi.resetModules();
  return import("../../backend/config/db-sqlite.ts");
}

test("each user's single history source moves into per-service sources once", async () => {
  const paths = await createIsolatedStateDir("listen-history-sources");
  applyIsolatedBackendEnv(paths);

  const legacyDb = new Database(paths.dbPath);
  legacyDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      permissions TEXT,
      lastfm_username TEXT,
      listen_history_provider TEXT,
      listen_history_username TEXT,
      listen_history_url TEXT
    );
    INSERT INTO users (username, password_hash, lastfm_username, listen_history_provider, listen_history_username, listen_history_url) VALUES
      ('legacy', 'x', 'old-lastfm', NULL, NULL, NULL),
      ('lastfm', 'x', NULL, 'lastfm', ' listener ', NULL),
      ('brainz', 'x', NULL, 'listenbrainz', 'brainz-listener', NULL),
      ('koito', 'x', NULL, 'koito', NULL, 'http://koito.local:4110'),
      ('local', 'x', NULL, 'local', NULL, NULL);
  `);
  legacyDb.close();

  const sources = (db: Awaited<ReturnType<typeof bootDb>>["db"]) =>
    db
      .prepare<[], { username: string; provider: string; account: string }>(
        "SELECT u.username, s.provider, s.account FROM listen_history_sources s JOIN users u ON u.id = s.user_id ORDER BY u.username",
      )
      .all();

  let { db } = await bootDb();
  assert.deepEqual(sources(db), [
    { username: "brainz", provider: "listenbrainz", account: "brainz-listener" },
    { username: "koito", provider: "koito", account: "http://koito.local:4110" },
    { username: "lastfm", provider: "lastfm", account: "listener" },
    { username: "legacy", provider: "lastfm", account: "old-lastfm" },
  ]);

  db.prepare("DELETE FROM listen_history_sources WHERE provider = 'lastfm'").run();
  db.close();
  ({ db } = await bootDb());
  assert.deepEqual(
    sources(db).map((source) => source.username),
    ["brainz", "koito"],
  );
  db.close();
  await cleanupIsolatedState(paths);
});
