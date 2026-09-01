import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

function createPreV4Db() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-v4-"));
  const dbPath = path.join(tempDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE playlist_download_jobs (
      id TEXT PRIMARY KEY,
      artist_name TEXT NOT NULL,
      track_name TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      playlist_type TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE lidarr_artist_id_map (
      musicbrainz_id TEXT PRIMARY KEY,
      lidarr_foreign_artist_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE library_artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_key TEXT NOT NULL UNIQUE,
      mbid TEXT,
      name TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO settings (key, value) VALUES ('schemaVersion', '3');
    INSERT INTO playlist_download_jobs (id, artist_name, track_name, playlist_id, playlist_type, status, created_at)
      VALUES ('job-aurral', 'Aurral Artist', 'Track One', 'library', 'library', 'done', 1);
    INSERT INTO playlist_download_jobs (id, artist_name, track_name, playlist_id, playlist_type, status, created_at)
      VALUES ('job-flow', 'Flow Artist', 'Track Two', 'flow-1', 'flow-1', 'failed', 2);
    INSERT INTO lidarr_artist_id_map (musicbrainz_id, lidarr_foreign_artist_id, updated_at)
      VALUES ('mbid-managed', 'lidar-id-1', 1);
    INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at)
      VALUES ('mbid:mbid-managed', 'mbid-managed', 'Managed Artist', '{"monitor":"all"}', 1, 1);
    INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at)
      VALUES ('mbid:mbid-unmanaged', 'mbid-unmanaged', 'Unmanaged Artist', '{"monitor":"all"}', 1, 1);
    INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at)
      VALUES ('name:name-only', NULL, 'Name Only Artist', '{}', 1, 1);
    INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at)
      VALUES ('mbid:mbid-indexed', 'mbid-indexed', 'Indexed Artist', '{"librarySource":"lidarr","monitored":true,"monitor":"new"}', 1, 1);
    INSERT INTO library_artists (identity_key, mbid, name, metadata_json, created_at, updated_at)
      VALUES ('mbid:mbid-aurral', 'mbid-aurral', 'Aurral Artist', '{"librarySource":"aurral"}', 1, 1);
  `);
  db.close();
  return { tempDir, dbPath };
}

const dbHelpers = {
  parseJSON: (text) => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  },
  stringifyJSON: (obj) => obj === undefined ? null : JSON.stringify(obj),
};

test("ownership migration adds manager table and job ownership columns", async () => {
  const { dbPath } = createPreV4Db();
  const { initializeSchemaOnStartup } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const db = new Database(dbPath);

  const result = initializeSchemaOnStartup(db, dbHelpers);
  assert.equal(result.migrated, true);
  assert.equal(result.schemaVersion, 4);

  const jobColumns = db.prepare("PRAGMA table_info(playlist_download_jobs)").all().map((c) => c.name);
  assert.ok(jobColumns.includes("managed_by"));
  assert.ok(jobColumns.includes("request_group_id"));

  const jobs = db.prepare("SELECT id, managed_by, request_group_id FROM playlist_download_jobs ORDER BY id").all();
  assert.deepEqual(jobs, [
    { id: "job-aurral", managed_by: "aurral", request_group_id: null },
    { id: "job-flow", managed_by: "aurral", request_group_id: null },
  ]);

  const managed = db
    .prepare(
      "SELECT entity_kind, managed_by, monitor_mode FROM library_management ORDER BY entity_id",
    )
    .all();
  assert.deepEqual(managed, [
    { entity_kind: "artist", managed_by: "lidarr", monitor_mode: "all" },
    { entity_kind: "artist", managed_by: "lidarr", monitor_mode: "new" },
  ]);

  db.close();
});

test("ownership migration is idempotent and preserves explicit manager rows", async () => {
  const { dbPath } = createPreV4Db();
  const { applyV4Migration } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const db = new Database(dbPath);

  applyV4Migration(db, dbHelpers);
  db.prepare(
    "UPDATE library_management SET monitor_mode = 'none' WHERE entity_kind = 'artist'",
  ).run();
  const second = applyV4Migration(db, dbHelpers);
  assert.equal(second.migrated, false);
  assert.equal(second.schemaVersion, 4);

  const rerun = db.prepare(
    "INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at) VALUES ('artist', 999, 'lidarr', NULL, 1, 1)",
  );
  rerun.run();

  const monitor = db.prepare("SELECT monitor_mode FROM library_management WHERE entity_kind = 'artist' AND entity_id = 1").get();
  assert.equal(monitor.monitor_mode, "none");

  const count = db.prepare("SELECT COUNT(*) AS count FROM library_management").get();
  assert.equal(count.count, 3);

  db.close();
});

test("applyV3Migration keeps its version 3 contract without ownership state", async () => {
  const { dbPath } = createPreV4Db();
  const { applyV3Migration } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const db = new Database(dbPath);
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'schemaVersion'").run();

  const result = applyV3Migration(db, dbHelpers);
  assert.equal(result.migrated, true);
  assert.equal(result.schemaVersion, 3);

  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_management'")
    .get();
  assert.equal(table, undefined);
  const jobColumns = db.prepare("PRAGMA table_info(playlist_download_jobs)").all().map((c) => c.name);
  assert.ok(!jobColumns.includes("managed_by"));

  const { initializeSchemaOnStartup } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const upgraded = initializeSchemaOnStartup(db, dbHelpers);
  assert.equal(upgraded.migrated, true);
  assert.equal(upgraded.schemaVersion, 4);
  const jobColumnsAfter = db.prepare("PRAGMA table_info(playlist_download_jobs)").all().map((c) => c.name);
  assert.ok(jobColumnsAfter.includes("managed_by"));

  db.close();
});

test("ownership migration runs on fresh databases without lidarr records", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-v4-fresh-"));
  const dbPath = path.join(tempDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const { applyV4Migration } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const result = applyV4Migration(db, dbHelpers);
  assert.equal(result.schemaVersion, 4);

  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_management'").get();
  assert.ok(table);

  const managed = db.prepare("SELECT COUNT(*) AS count FROM library_management").get();
  assert.equal(managed.count, 0);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
