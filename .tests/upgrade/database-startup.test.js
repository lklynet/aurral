import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openAurralDatabase, StartupRefusal } from "../../backend/config/databaseStartup.js";

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function createPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "aurral-startup-"));
  roots.push(root);
  const dataDir = path.join(root, "config");
  mkdirSync(dataDir);
  return {
    dataDir,
    dbPath: path.join(dataDir, "aurral.db"),
    legacyContainerDataDir: path.join(root, "app", "backend", "data"),
  };
}

function writeDatabase(dbPath, settings = {}, extraSql = "") {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(settings)) insert.run(key, value);
  if (extraSql) db.exec(extraSql);
  db.close();
}

const stampedSettings = {
  schemaVersion: "4",
  aurral3Readiness: JSON.stringify({ version: 1, ready: true, blockers: [] }),
  "migration:play-album-stats-v2": "1",
  storedDataMigration: JSON.stringify({ version: 1 }),
  onboardingComplete: "true",
};

function open(paths, options = {}) {
  return openAurralDatabase({ ...paths, env: {}, ...options });
}

function readSettings(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

function backups(paths) {
  return readdirSync(paths.dataDir).filter((name) => name.startsWith("aurral-2-backup-"));
}

test("a fresh install creates schema 5 without a backup", () => {
  const paths = createPaths();
  const db = open(paths);
  db.close();

  assert.equal(readSettings(paths.dbPath).schemaVersion, "5");
  assert.deepEqual(backups(paths), []);
});

test("a stamped Aurral 2 database is backed up before it moves to schema 5", () => {
  const paths = createPaths();
  writeDatabase(paths.dbPath, stampedSettings);

  const db = open(paths, { now: Date.UTC(2026, 9, 3, 12, 30, 5) });
  db.close();

  assert.deepEqual(backups(paths), ["aurral-2-backup-20261003T123005.db"]);
  const backup = readSettings(path.join(paths.dataDir, backups(paths)[0]));
  assert.equal(backup.schemaVersion, "4");
  assert.equal(backup["migration:play-album-stats-v2"], "1");
  const upgraded = readSettings(paths.dbPath);
  assert.equal(upgraded.schemaVersion, "5");
  assert.equal(upgraded.onboardingComplete, "true");
  assert.equal(upgraded["migration:play-album-stats-v2"], undefined);
  assert.equal(upgraded.aurral3Readiness, undefined);
  assert.equal(upgraded.storedDataMigration, undefined);

  const reopened = open(paths);
  reopened.close();
  assert.equal(backups(paths).length, 1);
});

test("a failed upgrade leaves the database at schema 4", () => {
  const paths = createPaths();
  writeDatabase(paths.dbPath, stampedSettings, "CREATE TABLE idx_sessions_token (id INTEGER)");

  assert.throws(() => open(paths));

  const settings = readSettings(paths.dbPath);
  assert.equal(settings.schemaVersion, "4");
  assert.equal(settings["migration:play-album-stats-v2"], "1");
});

for (const [name, settings] of [
  ["an unstamped Aurral 2 database", { schemaVersion: "4" }],
  ["a database whose readiness check found blockers", {
    schemaVersion: "4",
    aurral3Readiness: JSON.stringify({ version: 1, ready: false, blockers: [{ kind: "download-folder" }] }),
  }],
  ["a database from before schema 4", { onboardingComplete: "true" }],
]) {
  test(`${name} is refused without changes`, () => {
    const paths = createPaths();
    writeDatabase(paths.dbPath, settings);
    const before = readFileSync(paths.dbPath);

    assert.throws(() => open(paths), (error) => error instanceof StartupRefusal && /aurral:2/.test(error.message));

    assert.deepEqual(readFileSync(paths.dbPath), before);
    assert.deepEqual(readdirSync(paths.dataDir), ["aurral.db"]);
  });
}

test("a database from a newer release is refused", () => {
  const paths = createPaths();
  writeDatabase(paths.dbPath, { schemaVersion: "6" });

  assert.throws(() => open(paths), (error) => error instanceof StartupRefusal && /newer Aurral release/.test(error.message));
  assert.equal(readSettings(paths.dbPath).schemaVersion, "6");
});

for (const variable of ["WEEKLY_FLOW_FOLDER", "PLAYLIST_FOLDER"]) {
  test(`${variable} is refused before a database exists`, () => {
    const paths = createPaths();

    assert.throws(
      () => open(paths, { env: { [variable]: "/data/old" } }),
      (error) => error instanceof StartupRefusal && /DOWNLOAD_FOLDER/.test(error.message),
    );
    assert.equal(existsSync(paths.dbPath), false);
  });
}

test("data left in the old container folder is refused", () => {
  const paths = createPaths();
  mkdirSync(paths.legacyContainerDataDir, { recursive: true });
  writeFileSync(path.join(paths.legacyContainerDataDir, "aurral.db"), "");

  assert.throws(() => open(paths), (error) => error instanceof StartupRefusal && /\/config/.test(error.message));
  assert.equal(existsSync(paths.dbPath), false);
});

test("the old container folder is refused as the data folder", () => {
  const paths = createPaths();

  assert.throws(
    () => open({ ...paths, dataDir: paths.legacyContainerDataDir }),
    (error) => error instanceof StartupRefusal && /\/config/.test(error.message),
  );
});
