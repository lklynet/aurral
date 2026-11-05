import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading unmonitors tracks whose file was kept and drops keep_file", async () => {
  const state = await createIsolatedStateDir("kept-track-files");
  const start = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { db } = await import("./backend/config/db-sqlite.ts"); db.close();',
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: {
          ...process.env,
          AURRAL_DATA_DIR: state.dataDir,
          AURRAL_DB_PATH: state.dbPath,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };

  start();
  const db = new Database(state.dbPath);
  try {
    db.exec("ALTER TABLE library_tracks ADD COLUMN keep_file INTEGER NOT NULL DEFAULT 0");
    const now = Date.now();
    const addTrack = db.prepare(
      "INSERT INTO library_tracks (identity_key, title, monitored, keep_file, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)",
    );
    addTrack.run("kept", "Kept", 1, now, now);
    addTrack.run("upgradable", "Upgradable", 0, now, now);

    start();

    assert.deepEqual(
      db.prepare("SELECT identity_key, monitored FROM library_tracks ORDER BY id").all(),
      [
        { identity_key: "kept", monitored: 0 },
        { identity_key: "upgradable", monitored: 1 },
      ],
    );
    assert.equal(
      db
        .prepare("SELECT name FROM pragma_table_info('library_tracks') WHERE name = 'keep_file'")
        .get(),
      undefined,
    );
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
