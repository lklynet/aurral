import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading refreshes cached indexes for existing users and stars once", async () => {
  const state = await createIsolatedStateDir("subsonic-star-migration");
  const db = new Database(state.dbPath);
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE subsonic_stars (
        user_id INTEGER NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, entity_kind, entity_key)
      );
      INSERT INTO users (id, username) VALUES (1, 'starred'), (2, 'unstarred');
    `);
    const previousIndexTimestamp = Date.now();
    db.prepare(
      "INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (1, 'artist', 'old', ?)",
    ).run(previousIndexTimestamp - 1000);

    const start = () => {
      const result = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        "import('./backend/config/db-sqlite.js')",
      ], {
        cwd: new URL("../..", import.meta.url),
        env: {
          ...process.env,
          AURRAL_DATA_DIR: state.dataDir,
          AURRAL_DB_PATH: state.dbPath,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    };

    start();
    const stamps = db.prepare(
      "SELECT user_id, changed_at FROM subsonic_star_changes ORDER BY user_id",
    ).all();
    assert.deepEqual(stamps.map((row) => row.user_id), [1, 2]);
    assert.ok(stamps.every((row) => row.changed_at > previousIndexTimestamp));

    start();
    assert.deepEqual(db.prepare(
      "SELECT user_id, changed_at FROM subsonic_star_changes ORDER BY user_id",
    ).all(), stamps);
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
