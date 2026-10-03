import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const db = openAurralDatabase({ dbPath: loaded.dbPath, dataDir: loaded.dataDir, env: {} });
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
