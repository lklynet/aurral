import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading drops the shared ListenBrainz genre sections and keeps discovery data", async () => {
  const state = await createIsolatedStateDir("unified-discovery-source-migration");
  const start = () => {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      'const { db } = await import("./backend/config/db-sqlite.js"); db.close();',
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
  const db = new Database(state.dbPath);
  try {
    const insert = db.prepare(
      "INSERT OR REPLACE INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?)",
    );
    const genres = JSON.stringify([{ name: "Rock", artists: [{ name: "Queen" }] }]);
    insert.run("fallbackGenres", genres, "2026-01-01");
    insert.run("fallbackGenrePools", JSON.stringify({ Rock: [{ name: "Queen" }] }), "2026-01-01");
    insert.run("topTags", JSON.stringify(["Rock", "Pop"]), "2026-01-01");
    insert.run("provider", "listenbrainz-fallback", "2026-01-01");
    insert.run("globalTop", JSON.stringify([{ name: "Trending" }]), "2026-01-01");
    insert.run("user:1:topGenres", JSON.stringify(["shoegaze"]), "2026-01-01");
    db.prepare("DELETE FROM settings WHERE key = 'migration:unified-discovery-source-v1'").run();

    start();

    const rows = Object.fromEntries(
      db.prepare("SELECT key, value FROM discovery_cache").all().map((row) => [row.key, row.value]),
    );
    assert.deepEqual(Object.keys(rows).sort(), ["globalTop", "provider", "user:1:topGenres"]);
    assert.equal(rows.provider, "listenbrainz");
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
