import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { SCHEMA_VERSION, missingUpgradeSteps } from "./upgrade-gate.ts";
import { migrateToJobQueue } from "./job-queue-migration.ts";
import { migrate } from "./migrations.ts";
import { initializeLibrarySearchIndex } from "./library-search-index.ts";
import { initializeLibraryGenreIndex } from "./library-genre-index.ts";
import { syncDownloadFolderPath } from "../services/downloadFolderConfig.ts";
import { databaseOnlyInLegacyDataDir, ensureDataDir, resolveAurralDbPath } from "./data-dir.ts";
import { asAppError } from "../../lib/errors.ts";
import * as v from "valibot";
import { logger } from "../services/logger.ts";

if (databaseOnlyInLegacyDataDir()) {
  console.error(
    "Aurral's database is in /app/backend/data, but Aurral 3 only reads /config. Mount that folder at /config instead, then start Aurral again.",
  );
  process.exit(1);
}

const DATA_DIR = ensureDataDir();

const DB_PATH = resolveAurralDbPath();

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const missingSteps = missingUpgradeSteps(db);
if (missingSteps.length) {
  console.error(
    [
      "Aurral 3 can't open this database yet. It was last used by an Aurral 2 that didn't finish upgrading it.",
      "Start ghcr.io/lklynet/aurral:2 with this data folder, wait a few minutes for it to finish starting up, then start Aurral 3 again.",
      "Aurral 3 didn't change anything.",
      `Missing: ${missingSteps.join(", ")}`,
    ].join("\n"),
  );
  process.exit(1);
}

for (let attempt = 0; attempt < 5; attempt++) {
  try {
    if (db.pragma("journal_mode", { simple: true }) !== "wal") {
      db.pragma("journal_mode = WAL");
    }
    break;
  } catch (error) {
    const failure = asAppError(error);
    if (!String(failure?.code || "").startsWith("SQLITE_BUSY") || attempt === 4) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
db.pragma("synchronous = NORMAL");
// Worker processes share this file. A deferred transaction that reads before it writes
// fails with SQLITE_BUSY without waiting when another process writes first.
const createTransaction = db.transaction.bind(db);
db.transaction = ((fn) => createTransaction(fn).immediate) as typeof db.transaction;
db.pragma("cache_size = -2000");
db.pragma("mmap_size = 25165824");
db.pragma("temp_store = FILE");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
db.prepare(
  "INSERT INTO settings (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(String(SCHEMA_VERSION));

migrateToJobQueue(db, DATA_DIR);
migrate(db);

db.exec(`
  DELETE FROM settings WHERE key LIKE 'activeDownloadAttempt:%'
    AND NOT EXISTS (
      SELECT 1 FROM download_jobs
      WHERE id = substr(settings.key, length('activeDownloadAttempt:') + 1) AND status != 'done'
    );
`);
initializeLibraryGenreIndex(db);
initializeLibrarySearchIndex(db);

export const dbHelpers = {
  parseJSON: (text: string | null | undefined): unknown => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  readJSON<Schema extends v.GenericSchema>(
    schema: Schema,
    text: string | null | undefined,
    source: string,
  ): v.InferOutput<Schema> | null {
    const value: unknown = dbHelpers.parseJSON(text);
    if (value == null) return null;
    const result = v.safeParse(schema, value);
    if (result.success) return result.output;
    logger.warn("database", "Ignored stored data Aurral can't read", {
      source,
      issue: v.summarize(result.issues),
    });
    return null;
  },

  stringifyJSON: (obj: unknown) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

const existingDownloadFolder = db
  .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
  .get("downloadFolderPath");
syncDownloadFolderPath(existingDownloadFolder?.value || null);

const databaseRevisionStmt = db.prepare<[], { data_version: number; changes: number }>(
  "SELECT data_version, total_changes() AS changes FROM pragma_data_version",
);

const dataVersionStmt = db.prepare<[], { data_version: number }>(
  "SELECT data_version FROM pragma_data_version",
);

export function getDatabaseDataVersion() {
  return dataVersionStmt.get()!.data_version;
}

export function getDatabaseRevision() {
  const { data_version, changes } = databaseRevisionStmt.get()!;
  return `${data_version}:${changes}`;
}

export { db };
