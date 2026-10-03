import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openAurralDatabase, StartupRefusal } from "../../backend/config/databaseStartup.js";
import { loadAurral2Fixture } from "../helpers/aurral2Fixture.js";

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(name) {
  const loaded = loadAurral2Fixture(name);
  roots.push(loaded.root);
  return loaded;
}

function upgrade(name) {
  const loaded = fixture(name);
  const db = openAurralDatabase({
    dbPath: loaded.dbPath,
    dataDir: loaded.dataDir,
    env: { DOWNLOAD_FOLDER: loaded.downloadRoot },
  });
  return { ...loaded, db };
}

function describeSchema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_honker%' ESCAPE '\\' AND name NOT LIKE 'library_search_%' AND name != 'library_entity_genres' ORDER BY name")
    .all()
    .map(({ name }) => name);
  return Object.fromEntries(tables.map((table) => [
    table,
    {
      columns: db.prepare(`PRAGMA table_info("${table}")`).all()
        .map(({ name, type, notnull, dflt_value: defaultValue, pk }) => ({ name, type, notnull, defaultValue, pk }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      indexes: db.prepare(`PRAGMA index_list("${table}")`).all()
        .filter(({ origin }) => origin === "c")
        .map(({ name, unique }) => ({ name, unique }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
  ]));
}

function freshSchema() {
  const root = mkdtempSync(path.join(tmpdir(), "aurral-fresh-"));
  roots.push(root);
  const db = openAurralDatabase({ dbPath: path.join(root, "aurral.db"), dataDir: root, env: {} });
  try {
    return describeSchema(db);
  } finally {
    db.close();
  }
}

for (const name of ["stamped", "upgraded-from-1"]) {
  test(`the ${name} fixture upgrades to the same schema as a fresh install`, () => {
    const { db } = upgrade(name);
    try {
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get().value, "5");
      assert.deepEqual(describeSchema(db), freshSchema());
    } finally {
      db.close();
    }
  });
}

test("playlist artwork moves out of the Aurral 2 folder", () => {
  const { db, downloadRoot } = upgrade("upgraded-from-1");
  db.close();

  assert.deepEqual(readdirSync(path.join(downloadRoot, "_playlists")).sort(), ["Discover.jpg", "Mix.jpg"]);
  assert.equal(readFileSync(path.join(downloadRoot, "_playlists", "Discover.jpg"), "utf8"), "fixture:downloads/aurral-weekly-flow/_playlists/Discover.jpg");
  assert.equal(existsSync(path.join(downloadRoot, "aurral-weekly-flow")), false);
});

test("settings that only older releases read are removed", () => {
  const { db } = upgrade("upgraded-from-1");
  try {
    const integrations = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'integrations'").pluck().get());
    assert.equal(integrations.soulseek, undefined);
    assert.equal(integrations.musicbrainz, undefined);
    assert.equal(integrations.coverArtArchive, undefined);
    assert.ok(integrations.metadata);
    const keys = db.prepare("SELECT key FROM settings").pluck().all();
    for (const key of ["weeklyFlows", "weeklyFlowWorker", "storedDataMigration", "aurral3Readiness"]) {
      assert.equal(keys.includes(key), false, key);
    }
    assert.ok(keys.includes("flows"));
    assert.ok(keys.includes("playlistWorker"));
  } finally {
    db.close();
  }
});

test("covers cached from the old cover host are cleared", () => {
  const { db } = upgrade("stamped");
  try {
    assert.deepEqual(
      db.prepare("SELECT image_url FROM images_cache ORDER BY image_url").pluck().all(),
      ["https://images.example.invalid/kept.jpg"],
    );
  } finally {
    db.close();
  }
});

test("a database with Downloads Folder files waiting for review is refused unchanged", () => {
  const { dbPath, dataDir } = fixture("review");
  const before = readFileSync(dbPath);

  assert.throws(
    () => openAurralDatabase({ dbPath, dataDir, env: {} }),
    (error) => error instanceof StartupRefusal,
  );
  assert.deepEqual(readFileSync(dbPath), before);
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get().value, "4");
  db.close();
});
