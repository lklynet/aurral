import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { SCHEMA_VERSION, createSchema } from "./databaseSchema.js";
import { moveAurral2Files, upgradeFromAurral2 } from "./aurral2Upgrade.js";
import { StartupRefusal } from "./startupRefusal.js";

export const LEGACY_CONTAINER_DATA_DIR = "/app/backend/data";
const AURRAL_2_SCHEMA_VERSION = 4;

export { StartupRefusal };

function refuseOldConfiguration({ dataDir, env, legacyContainerDataDir }) {
  if (env.WEEKLY_FLOW_FOLDER || env.PLAYLIST_FOLDER) {
    throw new StartupRefusal(
      "WEEKLY_FLOW_FOLDER or PLAYLIST_FOLDER is set. Aurral 3.0 reads only DOWNLOAD_FOLDER. Rename the variable to DOWNLOAD_FOLDER, then start Aurral again.",
    );
  }
  const legacyDatabase = path.join(legacyContainerDataDir, "aurral.db");
  if (path.resolve(dataDir) === path.resolve(legacyContainerDataDir) || fs.existsSync(legacyDatabase)) {
    throw new StartupRefusal(
      `Found Aurral data in ${legacyContainerDataDir}. Aurral 3.0 keeps its data in /config. Mount the same folder at /config instead, then start Aurral again.`,
    );
  }
}

function readSetting(db, key) {
  const hasSettings = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get();
  return hasSettings ? db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value : undefined;
}

function isStamped(db) {
  try {
    return JSON.parse(readSetting(db, "aurral3Readiness") || "null")?.ready === true;
  } catch {
    return false;
  }
}

function hasTables(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get(),
  );
}

function backupPathFor(dbPath, now) {
  const time = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return path.join(path.dirname(dbPath), `aurral-2-backup-${time}.db`);
}

function configureConnection(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (db.pragma("journal_mode", { simple: true }) !== "wal") {
        db.pragma("journal_mode = WAL");
      }
      break;
    } catch (error) {
      if (!String(error?.code || "").startsWith("SQLITE_BUSY") || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -24000");
  db.pragma("mmap_size = 25165824");
  db.pragma("temp_store = MEMORY");
}

export function openAurralDatabase({
  dbPath,
  dataDir,
  env = process.env,
  legacyContainerDataDir = LEGACY_CONTAINER_DATA_DIR,
  now = Date.now(),
  log = () => {},
} = {}) {
  refuseOldConfiguration({ dataDir, env, legacyContainerDataDir });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    const version = Number(readSetting(db, "schemaVersion") || 0);
    if (hasTables(db) && version !== SCHEMA_VERSION) {
      if (version > SCHEMA_VERSION) {
        throw new StartupRefusal(
          `This database comes from a newer Aurral release (schema ${version}). Run that release or a newer one.`,
        );
      }
      if (version !== AURRAL_2_SCHEMA_VERSION || !isStamped(db)) {
        throw new StartupRefusal(
          "This database is not ready for Aurral 3.0, and Aurral did not change it. Run the ghcr.io/lklynet/aurral:2 image until Settings > System > Aurral 3.0 shows Ready for Aurral 3.0, then start Aurral 3.0 again.",
        );
      }
    }
    configureConnection(db);
    const createTransaction = db.transaction.bind(db);
    // Worker processes share this file. A deferred transaction that reads before it writes
    // fails with SQLITE_BUSY without waiting when another process writes first.
    db.transaction = (fn) => createTransaction(fn).immediate;
    if (hasTables(db) && version === AURRAL_2_SCHEMA_VERSION) {
      const backupPath = backupPathFor(dbPath, now);
      db.prepare("VACUUM INTO ?").run(backupPath);
      log(`Backed up the Aurral 2 database to ${backupPath}`);
      moveAurral2Files(db, { dataDir, env, log });
      db.transaction(() => {
        if (Number(readSetting(db, "schemaVersion")) !== AURRAL_2_SCHEMA_VERSION) return;
        upgradeFromAurral2(db, { now });
        createSchema(db);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schemaVersion', ?)")
          .run(String(SCHEMA_VERSION));
      })();
      log(`Upgraded the database to schema ${SCHEMA_VERSION}`);
    } else {
      db.transaction(() => {
        createSchema(db);
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('schemaVersion', ?)")
          .run(String(SCHEMA_VERSION));
      })();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
