import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

test("startup removes the old stored news state and publisher blocks but keeps other user settings", async () => {
  const paths = await createIsolatedStateDir("news-legacy-settings");
  applyIsolatedBackendEnv(paths);
  const legacy = new Database(paths.dbPath);
  legacy.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = legacy.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  insert.run("news:rssState", JSON.stringify({ articles: [{ id: "old" }] }));
  insert.run("user:1:newsPreferences", JSON.stringify({ blockedPublishers: ["NME"] }));
  insert.run("user:1:discoverLayout", JSON.stringify({ sections: [] }));
  legacy.close();

  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  try {
    const keys = db.prepare("SELECT key FROM settings WHERE key LIKE 'user:%' OR key LIKE 'news:%'").all()
      .map(({ key }) => key);
    assert.deepEqual(keys, ["user:1:discoverLayout"]);
  } finally {
    db.close();
    await cleanupIsolatedState(paths);
  }
});
