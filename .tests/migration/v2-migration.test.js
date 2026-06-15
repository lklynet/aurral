import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

test("applyV2Migration copies weekly_flow_jobs and preserves v1 rollback data", async () => {
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

  const { applyV2Migration } = await import(
    "../../backend/config/schema-migration-v2.js"
  );
  const migratedDb = new Database(dbPath);
  const dbHelpers = {
    parseJSON: (text) => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    stringifyJSON: (obj) => {
      if (obj === undefined) return null;
      return JSON.stringify(obj);
    },
  };
  const result = applyV2Migration(migratedDb, dbHelpers);
  assert.equal(result.schemaVersion, 2);
  const secondResult = applyV2Migration(migratedDb, dbHelpers);
  assert.equal(secondResult.migrated, false);
  assert.equal(secondResult.schemaVersion, 2);

  const tables = migratedDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('weekly_flow_jobs', 'playlist_download_jobs')",
    )
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("playlist_download_jobs"));
  assert.ok(tables.includes("weekly_flow_jobs"));

  const version = migratedDb
    .prepare("SELECT value FROM settings WHERE key = 'schemaVersion'")
    .get()?.value;
  assert.equal(version, "2");

  const flows = migratedDb
    .prepare("SELECT value FROM settings WHERE key = 'flows'")
    .get()?.value;
  assert.equal(flows, "[]");
  assert.equal(
    migratedDb.prepare("SELECT value FROM settings WHERE key = 'weeklyFlows'").get()?.value,
    "[]",
  );

  const playlistWorker = JSON.parse(
    migratedDb
      .prepare("SELECT value FROM settings WHERE key = 'playlistWorker'")
      .get()?.value || "{}",
  );
  assert.equal(playlistWorker.concurrency, 2);
  assert.equal(playlistWorker.existingFileMode, "reuse");
  assert.equal(playlistWorker.preferredFormat, undefined);

  const weeklyFlowWorker = JSON.parse(
    migratedDb
      .prepare("SELECT value FROM settings WHERE key = 'weeklyFlowWorker'")
      .get()?.value || "{}",
  );
  assert.equal(weeklyFlowWorker.concurrency, 2);
  assert.equal(weeklyFlowWorker.existingFileMode, "reuse");
  assert.equal(weeklyFlowWorker.preferredFormat, "flac");

  const copiedJob = migratedDb
    .prepare("SELECT * FROM playlist_download_jobs WHERE id = 'job-1'")
    .get();
  assert.equal(copiedJob.artist_name, "Artist");
  assert.equal(copiedJob.playlist_id, "discover");

  migratedDb
    .prepare(`
      INSERT INTO playlist_download_jobs (
        id, artist_name, track_name, playlist_id, playlist_type, status, created_at
      )
      VALUES ('job-2', 'Artist 2', 'Track 2', 'discover', 'discover', 'pending', 2)
    `)
    .run();
  assert.equal(
    migratedDb.prepare("SELECT track_name FROM weekly_flow_jobs WHERE id = 'job-2'").get()
      ?.track_name,
    "Track 2",
  );

  migratedDb
    .prepare("UPDATE playlist_download_jobs SET status = 'done', final_path = '/tmp/track.flac' WHERE id = 'job-2'")
    .run();
  const mirroredJob = migratedDb
    .prepare("SELECT status, final_path FROM weekly_flow_jobs WHERE id = 'job-2'")
    .get();
  assert.equal(mirroredJob.status, "done");
  assert.equal(mirroredJob.final_path, "/tmp/track.flac");

  migratedDb.prepare("DELETE FROM playlist_download_jobs WHERE id = 'job-2'").run();
  assert.equal(
    migratedDb.prepare("SELECT id FROM weekly_flow_jobs WHERE id = 'job-2'").get(),
    undefined,
  );

  migratedDb.close();
});
