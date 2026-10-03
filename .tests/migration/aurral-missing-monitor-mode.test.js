import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading moves Aurral artists from missing to all and leaves Lidarr artists alone", async () => {
  const state = await createIsolatedStateDir("aurral-missing-monitor-mode-migration");
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
    const now = Date.now();
    const addArtist = (key, managedBy) => {
      const metadata = { monitored: true, monitor: "missing", monitorOption: "missing", addOptions: { monitor: "missing" } };
      const artistId = db.prepare(
        "INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(key, key, JSON.stringify(metadata), now, now).lastInsertRowid;
      db.prepare(
        `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
         VALUES ('artist', ?, ?, 'missing', ?, ?)`,
      ).run(artistId, managedBy, now, now);
      return artistId;
    };
    const aurralArtist = addArtist("artist:aurral", "aurral");
    const lidarrArtist = addArtist("artist:lidarr", "lidarr");
    db.prepare("DELETE FROM settings WHERE key LIKE 'migration:aurral-missing-monitor-mode%'").run();

    start();

    const read = (artistId) => {
      const { metadata_json: metadataJson } = db.prepare("SELECT metadata_json FROM library_artists WHERE id = ?").get(artistId);
      const metadata = JSON.parse(metadataJson);
      const { monitor_mode: mode } = db.prepare(
        "SELECT monitor_mode FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
      ).get(artistId);
      return [mode, metadata.monitor, metadata.monitorOption, metadata.addOptions.monitor];
    };
    assert.deepEqual(read(aurralArtist), ["all", "all", "all", "all"]);
    assert.deepEqual(read(lidarrArtist), ["missing", "missing", "missing", "missing"]);
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
