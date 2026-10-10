import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading turns Aurral monitor modes into monitoring rules and leaves Lidarr artists alone", async () => {
  const state = await createIsolatedStateDir("aurral-monitoring-rules-migration");
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
    const changedAt = 1_700_000_000_000;
    const startedAt = 1_650_000_000_000;
    const addArtist = (key, managedBy, mode) => {
      const metadata = { monitored: true, monitor: mode, monitorOption: mode, monitorStartedAt: startedAt, addOptions: { monitor: mode } };
      const artistId = db.prepare(
        "INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(key, key, JSON.stringify(metadata), changedAt, changedAt).lastInsertRowid;
      db.prepare(
        `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
         VALUES ('artist', ?, ?, ?, ?, ?)`,
      ).run(artistId, managedBy, mode, changedAt, changedAt);
      return artistId;
    };
    const all = addArtist("artist:all", "aurral", "all");
    const future = addArtist("artist:future", "aurral", "future");
    const latest = addArtist("artist:latest", "aurral", "latest");
    const first = addArtist("artist:first", "aurral", "first");
    const none = addArtist("artist:none", "aurral", "none");
    const lidarr = addArtist("artist:lidarr", "lidarr", "future");
    db.prepare("DELETE FROM settings WHERE key = 'migration:aurral-monitoring-rules-v1'").run();

    start();

    const read = (artistId) => {
      const row = db.prepare(
        "SELECT monitor_mode, monitor_rules FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
      ).get(artistId);
      const metadata = JSON.parse(
        db.prepare("SELECT metadata_json FROM library_artists WHERE id = ?").get(artistId).metadata_json,
      );
      const stored = JSON.parse(row.monitor_rules ?? "null");
      return {
        mode: row.monitor_mode,
        monitored: metadata.monitored,
        default: stored?.default ?? null,
        catalog: stored?.rules?.catalog ?? null,
        newReleases: stored?.rules?.newReleases ?? null,
        since: stored ? [stored.catalogAt, stored.newSince] : null,
      };
    };
    assert.deepEqual(read(all), {
      mode: "all", monitored: true, default: true, catalog: null, newReleases: null, since: [changedAt, changedAt],
    });
    assert.deepEqual(read(future), {
      mode: "future", monitored: true, default: false, catalog: "none", newReleases: true, since: [startedAt, startedAt],
    });
    assert.deepEqual(read(latest), {
      mode: "latest", monitored: true, default: false, catalog: "latest", newReleases: true, since: [changedAt, changedAt],
    });
    assert.deepEqual(read(first), {
      mode: "none", monitored: false, default: null, catalog: null, newReleases: null, since: null,
    });
    assert.deepEqual(read(none), {
      mode: "none", monitored: true, default: null, catalog: null, newReleases: null, since: null,
    });
    assert.deepEqual(read(lidarr), {
      mode: "future", monitored: true, default: null, catalog: null, newReleases: null, since: null,
    });

  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
