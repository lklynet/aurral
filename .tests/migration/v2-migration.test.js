import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

function createPreMigrationDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-v2-"));
  const dbPath = path.join(tempDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE weekly_flow_jobs (
      id TEXT PRIMARY KEY,
      artist_name TEXT NOT NULL,
      track_name TEXT NOT NULL,
      playlist_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO settings (key, value) VALUES ('weeklyFlows', '[]');
    INSERT INTO settings (key, value) VALUES ('sharedFlowPlaylists', '[]');
    INSERT INTO settings (key, value) VALUES ('weeklyFlowWorker', '{"concurrency":2,"preferredFormat":"flac","retryCycleMinutes":15,"existingFileMode":"reuse"}');
    INSERT INTO weekly_flow_jobs (id, artist_name, track_name, playlist_type, status, created_at)
    VALUES ('job-1', 'Artist', 'Track', 'discover', 'pending', 1);
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

test("v2 migration creates playlist_download_jobs table and stores schema version", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  const result = applyV2Migration(db, dbHelpers);
  assert.equal(result.schemaVersion, 2);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('weekly_flow_jobs', 'playlist_download_jobs')",
  ).all().map((row) => row.name);
  assert.ok(tables.includes("playlist_download_jobs"));
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_slskd_transfer_history_created_at'",
      )
      .get(),
  );

  const version = db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get()?.value;
  assert.equal(version, "2");

  db.close();
});

test("v2 migration is idempotent", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  applyV2Migration(db, dbHelpers);
  const secondResult = applyV2Migration(db, dbHelpers);

  assert.equal(secondResult.migrated, false);
  assert.equal(secondResult.schemaVersion, 2);

  db.close();
});

test("v2 migration renames settings keys", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  applyV2Migration(db, dbHelpers);

  const flows = db.prepare("SELECT value FROM settings WHERE key = 'flows'").get()?.value;
  assert.equal(flows, "[]");
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key = 'weeklyFlows'").get()?.value,
    "[]",
  );

  db.close();
});

test("v2 migration splits weeklyFlowWorker settings into playlistWorker and weeklyFlowWorker", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  applyV2Migration(db, dbHelpers);

  const playlistWorker = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key = 'playlistWorker'").get()?.value || "{}",
  );
  assert.equal(playlistWorker.concurrency, 2);
  assert.equal(playlistWorker.existingFileMode, "reuse");
  assert.equal(playlistWorker.preferredFormat, undefined);

  const weeklyFlowWorker = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key = 'weeklyFlowWorker'").get()?.value || "{}",
  );
  assert.equal(weeklyFlowWorker.concurrency, 2);
  assert.equal(weeklyFlowWorker.existingFileMode, "reuse");
  assert.equal(weeklyFlowWorker.preferredFormat, "flac");

  db.close();
});

test("v2 migration copies existing jobs from weekly_flow_jobs to playlist_download_jobs", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  applyV2Migration(db, dbHelpers);

  const copiedJob = db.prepare("SELECT * FROM playlist_download_jobs WHERE id = 'job-1'").get();
  assert.equal(copiedJob.artist_name, "Artist");
  assert.equal(copiedJob.playlist_id, "discover");

  db.close();
});

test("v2 migration drops weekly_flow_jobs after copying data", async () => {
  const { dbPath } = createPreMigrationDb();
  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const db = new Database(dbPath);

  applyV2Migration(db, dbHelpers);

  const legacyTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'weekly_flow_jobs'",
    )
    .get();
  assert.equal(legacyTable, undefined);
  assert.ok(
    db.prepare("SELECT id FROM playlist_download_jobs WHERE id = 'job-1'").get(),
  );

  db.close();
});

test("v2 migration survives legacy playlist_download_jobs sync triggers", async () => {
  const { dbPath } = createPreMigrationDb();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE playlist_download_jobs (
      id TEXT PRIMARY KEY,
      artist_name TEXT NOT NULL,
      track_name TEXT NOT NULL,
      album_name TEXT,
      reason TEXT,
      artist_mbid TEXT,
      album_mbid TEXT,
      track_mbid TEXT,
      release_year TEXT,
      duration_ms INTEGER,
      track_number INTEGER,
      album_track_count INTEGER,
      album_track_titles TEXT,
      artist_aliases TEXT,
      playlist_id TEXT NOT NULL,
      playlist_type TEXT,
      status TEXT NOT NULL,
      staging_path TEXT,
      final_path TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    )
    VALUES ('job-1', 'Artist', 'Track', 'discover', 'discover', 'pending', 1);
    CREATE TRIGGER sync_playlist_download_jobs_ai_weekly_flow_jobs
    AFTER INSERT ON playlist_download_jobs
    BEGIN
      INSERT INTO weekly_flow_jobs (
        id, artist_name, track_name, playlist_type, status, created_at
      )
      VALUES (
        NEW.id, NEW.artist_name, NEW.track_name, NEW.playlist_type, NEW.status, NEW.created_at
      );
    END;
  `);
  db.close();

  const { applyV2Migration } = await import("../../backend/config/schema-migration-v2.js");
  const reopened = new Database(dbPath);
  assert.doesNotThrow(() => applyV2Migration(reopened, dbHelpers));
  assert.equal(
    reopened
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'weekly_flow_jobs'",
      )
      .get(),
    undefined,
  );
  assert.ok(
    reopened.prepare("SELECT id FROM playlist_download_jobs WHERE id = 'job-1'").get(),
  );
  reopened.close();
});

test("startup applies the consolidated v3 migration once", async () => {
  const { dbPath } = createPreMigrationDb();
  const { initializeSchemaOnStartup } = await import(
    "../../backend/config/schema-migration-v2.js",
  );
  const db = new Database(dbPath);
  db.prepare("INSERT INTO settings (key, value) VALUES ('schemaVersion', '2')").run();

  const result = initializeSchemaOnStartup(db, dbHelpers);
  assert.equal(result.migrated, true);
  assert.equal(result.schemaVersion, 3);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'weekly_flow_jobs'",
      )
      .get(),
    undefined,
  );

  db.exec("CREATE TABLE weekly_flow_jobs (id TEXT PRIMARY KEY)");
  const secondResult = initializeSchemaOnStartup(db, dbHelpers);
  assert.equal(secondResult.migrated, false);
  assert.equal(secondResult.schemaVersion, 3);
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'weekly_flow_jobs'",
      )
      .get(),
  );

  db.close();
});
