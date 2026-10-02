import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.js";

test("upgrading restores the monitored flag that file scans removed from Aurral albums", async () => {
  const state = await createIsolatedStateDir("aurral-album-monitored");
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
    const artistId = db.prepare(
      "INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES ('artist:upgrade', 'Upgrade Artist', ?, ?)",
    ).run(now, now).lastInsertRowid;
    const scannedMetadata = JSON.stringify({ tags: { album: "Scanned" } });
    const addAlbum = (key, metadataJson, managedBy, monitorMode) => {
      const albumId = db.prepare(
        `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(key, artistId, key, metadataJson, now, now).lastInsertRowid;
      db.prepare(
        `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
         VALUES ('album', ?, ?, ?, ?, ?)`,
      ).run(albumId, managedBy, monitorMode, now, now);
      return albumId;
    };
    const scanned = addAlbum("album:scanned", scannedMetadata, "aurral", "monitored");
    const withoutMetadata = addAlbum("album:without-metadata", null, "aurral", null);
    const unmonitored = addAlbum("album:unmonitored", scannedMetadata, "aurral", "unmonitored");
    const lidarr = addAlbum("album:lidarr", scannedMetadata, "lidarr", null);
    db.prepare("DELETE FROM settings WHERE key LIKE 'migration:aurral-album-monitored%'").run();

    start();

    const metadata = (albumId) =>
      JSON.parse(db.prepare("SELECT metadata_json FROM library_albums WHERE id = ?").get(albumId).metadata_json || "null");
    assert.deepEqual(metadata(scanned), { tags: { album: "Scanned" }, monitored: true });
    assert.deepEqual(metadata(withoutMetadata), { monitored: true });
    assert.deepEqual(metadata(unmonitored), { tags: { album: "Scanned" } });
    assert.deepEqual(metadata(lidarr), { tags: { album: "Scanned" } });
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
