import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

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

test("getV2MigrationStatus does not require consent for legacy v1 databases", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-v2-status-"));
  const dbPath = path.join(tempDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('weeklyFlows', '[]');
  `);
  db.close();

  const { getV2MigrationStatus } = await import(
    "../../backend/config/schema-migration-v2.js"
  );
  const reopened = new Database(dbPath);
  const status = getV2MigrationStatus(reopened, dbHelpers);
  reopened.close();

  assert.equal(status.required, false);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.legacyDetected, true);
});

test("getV2MigrationStatus reports fresh installs as not legacy", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-v2-fresh-"));
  const dbPath = path.join(tempDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE playlist_download_jobs (
      id TEXT PRIMARY KEY,
      artist_name TEXT NOT NULL,
      track_name TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.close();

  const { getV2MigrationStatus } = await import(
    "../../backend/config/schema-migration-v2.js"
  );
  const reopened = new Database(dbPath);
  const status = getV2MigrationStatus(reopened, dbHelpers);
  reopened.close();

  assert.equal(status.required, false);
  assert.equal(status.legacyDetected, false);
});
