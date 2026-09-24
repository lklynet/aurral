import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import test from "node:test";
import { ensureUniqueLidarrArtistIdIndex } from "../../backend/config/lidarr-artist-index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const indexName = "idx_lidarr_artist_id_map_foreign_id";

function boot(dbPath, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      'const { db } = await import("./backend/config/db-sqlite.js"); db.close();',
    ], {
      cwd: repoRoot,
      env: { ...process.env, AURRAL_DB_PATH: dbPath, AURRAL_DATA_DIR: dataDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Database startup exited ${code}: ${stderr}`));
    });
  });
}

function withDatabase(name, run) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `aurral-${name}-`));
  const dbPath = path.join(dataDir, "aurral.db");
  return Promise.resolve()
    .then(() => run(dbPath, dataDir))
    .finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

function indexState(db) {
  return db.prepare("PRAGMA index_list(lidarr_artist_id_map)").all()
    .find((index) => index.name === indexName);
}

test("concurrent startup creates a unique Lidarr artist index on a fresh database", () =>
  withDatabase("artist-index-fresh", async (dbPath, dataDir) => {
    await Promise.all(Array.from({ length: 4 }, () => boot(dbPath, dataDir)));
    const db = new Database(dbPath);
    try {
      assert.equal(indexState(db)?.unique, 1);
    } finally {
      db.close();
    }
  }));

test("concurrent startup upgrades a nonunique index and preserves the winning mappings", () =>
  withDatabase("artist-index-upgrade", async (dbPath, dataDir) => {
    await boot(dbPath, dataDir);
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      DROP INDEX ${indexName};
      CREATE INDEX ${indexName} ON lidarr_artist_id_map (lidarr_foreign_artist_id);
      INSERT INTO lidarr_artist_id_map VALUES ('older', 'provider-a', 1);
      INSERT INTO lidarr_artist_id_map VALUES ('newer', 'provider-a', 2);
      INSERT INTO lidarr_artist_id_map VALUES ('tie-z', 'provider-b', 3);
      INSERT INTO lidarr_artist_id_map VALUES ('tie-a', 'provider-b', 3);
      INSERT INTO lidarr_artist_id_map VALUES ('unrelated', 'provider-c', 4);
    `);
    seedDb.close();

    await Promise.all(Array.from({ length: 4 }, () => boot(dbPath, dataDir)));
    const db = new Database(dbPath);
    try {
      assert.equal(indexState(db)?.unique, 1);
      assert.deepEqual(db.prepare(
        "SELECT musicbrainz_id, lidarr_foreign_artist_id FROM lidarr_artist_id_map ORDER BY lidarr_foreign_artist_id",
      ).all(), [
        { musicbrainz_id: "newer", lidarr_foreign_artist_id: "provider-a" },
        { musicbrainz_id: "tie-a", lidarr_foreign_artist_id: "provider-b" },
        { musicbrainz_id: "unrelated", lidarr_foreign_artist_id: "provider-c" },
      ]);
    } finally {
      db.close();
    }
  }));

test("startup keeps an existing unique index without changing the schema", () =>
  withDatabase("artist-index-repeat", async (dbPath, dataDir) => {
    await boot(dbPath, dataDir);
    const db = new Database(dbPath);
    const schemaVersion = db.pragma("schema_version", { simple: true });
    assert.equal(indexState(db)?.unique, 1);
    db.close();

    await boot(dbPath, dataDir);
    const reopened = new Database(dbPath);
    try {
      assert.equal(indexState(reopened)?.unique, 1);
      assert.equal(reopened.pragma("schema_version", { simple: true }), schemaVersion);
    } finally {
      reopened.close();
    }
  }));

test("index migration needs no write lock when the index is already unique", () =>
  withDatabase("artist-index-writer", async (dbPath, dataDir) => {
    await boot(dbPath, dataDir);
    const writer = new Database(dbPath);
    const reader = new Database(dbPath);
    reader.pragma("busy_timeout = 20");
    writer.exec("BEGIN IMMEDIATE");
    try {
      ensureUniqueLidarrArtistIdIndex(reader);
    } finally {
      writer.exec("ROLLBACK");
      reader.close();
      writer.close();
    }
    const db = new Database(dbPath);
    try {
      assert.equal(indexState(db)?.unique, 1);
    } finally {
      db.close();
    }
  }));

test("failed unique index creation restores the legacy index and mappings", () =>
  withDatabase("artist-index-rollback", async (dbPath, dataDir) => {
    await boot(dbPath, dataDir);
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      DROP INDEX ${indexName};
      CREATE INDEX ${indexName} ON lidarr_artist_id_map (lidarr_foreign_artist_id);
      INSERT INTO lidarr_artist_id_map VALUES ('first', 'provider-a', 1);
      INSERT INTO lidarr_artist_id_map VALUES ('second', 'provider-a', 2);
      CREATE TRIGGER prevent_mapping_delete BEFORE DELETE ON lidarr_artist_id_map
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    const schemaVersion = seedDb.pragma("schema_version", { simple: true });
    seedDb.close();

    await assert.rejects(boot(dbPath, dataDir), /UNIQUE constraint failed/);
    const db = new Database(dbPath);
    try {
      assert.equal(indexState(db)?.unique, 0);
      assert.equal(db.pragma("schema_version", { simple: true }), schemaVersion);
      assert.deepEqual(db.prepare(
        "SELECT musicbrainz_id FROM lidarr_artist_id_map ORDER BY musicbrainz_id",
      ).all().map(({ musicbrainz_id }) => musicbrainz_id), ["first", "second"]);
    } finally {
      db.close();
    }
  }));
