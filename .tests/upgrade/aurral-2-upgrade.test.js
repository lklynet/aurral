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

test("accounts keep their sign-in identities without the adoption columns", () => {
  const { db } = upgrade("stamped");
  try {
    const columns = db.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
    assert.equal(columns.includes("needs_identity_migration"), false);
    assert.equal(columns.includes("allow_identity_adoption"), false);
    assert.deepEqual(db.prepare("SELECT username FROM users ORDER BY username").pluck().all(), ["admin", "olduser", "ssouser"]);
    assert.equal(
      db.prepare("SELECT users.username FROM user_identities JOIN users ON users.id = user_identities.user_id").pluck().get(),
      "ssouser",
    );
  } finally {
    db.close();
  }
});

test("the stored single password is removed", () => {
  const { db } = upgrade("upgraded-from-1");
  try {
    const general = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'integrations'").pluck().get()).general;
    assert.deepEqual(general, {});
  } finally {
    db.close();
  }
});

test("static playlist jobs move into the Library and their tracks reference them", () => {
  const { db } = upgrade("stamped");
  try {
    const jobs = Object.fromEntries(db.prepare(`
      SELECT track_name, owner_id, queued_for_playlist, status
      FROM download_jobs WHERE upgrade_for_job_id IS NULL
    `).all().map((job) => [`${job.track_name}:${job.owner_id === "library" ? "library" : "flow"}`, job]));
    const owners = (name) => db.prepare("SELECT owner_id FROM download_jobs WHERE track_name = ? AND upgrade_for_job_id IS NULL").pluck().all(name);
    assert.deepEqual(owners("Downloaded"), ["library"]);
    assert.equal(jobs["Downloaded:library"].queued_for_playlist, 1);
    assert.equal(jobs["Queued:library"].queued_for_playlist, 1);
    assert.equal(jobs["Failed:library"].queued_for_playlist, 1);
    assert.equal(jobs["Only In Jobs:library"].queued_for_playlist, 1);
    assert.deepEqual(
      db.prepare("SELECT queued_for_playlist FROM download_jobs WHERE track_name = 'Library Done' ORDER BY queued_for_playlist").pluck().all(),
      [0, 0],
    );
    assert.equal(jobs["Flow Done:flow"].queued_for_playlist, 0);
    assert.deepEqual(owners("Gone Pending"), []);
    assert.deepEqual(owners("Gone Done"), ["library"]);

    const upgradeJob = db.prepare("SELECT owner_id, queued_for_playlist FROM download_jobs WHERE upgrade_for_job_id IS NOT NULL").get();
    assert.deepEqual(upgradeJob, { owner_id: "library", queued_for_playlist: 0 });

    const playlists = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'staticPlaylists'").pluck().get());
    const imported = playlists.find((playlist) => playlist.name === "Imported");
    const jobIdFor = (name) => db.prepare("SELECT id FROM download_jobs WHERE track_name = ? AND upgrade_for_job_id IS NULL AND queued_for_playlist = 1").pluck().get(name);
    assert.deepEqual(
      imported.tracks.map((track) => [track.trackName, Boolean(track.jobId)]),
      [["Downloaded", true], ["Queued", true], ["Failed", true], ["Library Done", true], ["Only In Jobs", true]],
    );
    assert.equal(imported.tracks[0].jobId, jobIdFor("Downloaded"));
    assert.equal(new Set(imported.tracks.map((track) => track.membershipId)).size, 5);
    const copied = playlists.find((playlist) => playlist.name === "Copied");
    assert.equal(copied.tracks[0].jobId, jobIdFor("Downloaded"));

    const pipeline = db.prepare("SELECT payload FROM _honker_live WHERE queue = 'slskd-pipeline'").pluck().all().map((payload) => JSON.parse(payload));
    assert.deepEqual(pipeline.map((payload) => [payload.jobId, payload.ownerId, payload.ownerGeneration]), [[jobIdFor("Queued"), "library", 0]]);
    assert.deepEqual(db.prepare("SELECT job_id, owner_id FROM download_provider_work").all(), [{ job_id: jobIdFor("Queued"), owner_id: "library" }]);
    const flowId = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'flows'").pluck().get())[0].id;
    assert.deepEqual(db.prepare("SELECT owner_id FROM download_owner_cancellations ORDER BY owner_id").pluck().all(), [flowId]);
  } finally {
    db.close();
  }
});

test("queued work, permissions, and notification settings move to their current names", () => {
  const { db } = upgrade("stamped");
  try {
    const operations = db.prepare("SELECT queue, payload FROM _honker_live WHERE queue != 'slskd-pipeline' ORDER BY id").all()
      .map((row) => [row.queue, JSON.parse(row.payload).kind]);
    assert.deepEqual(operations, [["playlist-operation", "static-playlist-update"], ["system-task", "file-reuse-repair"]]);
    assert.deepEqual(
      db.prepare("SELECT key, value FROM settings WHERE key GLOB '*OperationTokens*' ORDER BY key").all(),
      [{ key: "playlistOperationTokens:flow%3A2c860b40-aa75-46bc-90e1-a02c8af0bb7d", value: '"fixture-flow-token"' }],
    );
    for (const permissions of db.prepare("SELECT permissions FROM users").pluck().all()) {
      assert.equal(Object.hasOwn(JSON.parse(permissions), "accessFlow"), false);
      assert.equal(typeof JSON.parse(permissions).accessPlaylists, "boolean");
    }
    const integrations = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'integrations'").pluck().get());
    assert.equal(integrations.gotify.notifyFlowDone, true);
    assert.equal(integrations.webhookEvents.notifyFlowDone, true);
    assert.equal(JSON.stringify(integrations).includes("notifyWeeklyFlowDone"), false);
  } finally {
    db.close();
  }
});

test("discovery drops the shared ListenBrainz genre sections and keeps its other data", () => {
  const loaded = fixture("stamped");
  const before = new Database(loaded.dbPath);
  const insert = before.prepare(
    "INSERT OR REPLACE INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?)",
  );
  insert.run("fallbackGenres", JSON.stringify([{ name: "Rock", artists: [{ name: "Queen" }] }]), "2026-01-01");
  insert.run("fallbackGenrePools", JSON.stringify({ Rock: [{ name: "Queen" }] }), "2026-01-01");
  insert.run("topTags", JSON.stringify(["Rock", "Pop"]), "2026-01-01");
  insert.run("provider", "listenbrainz-fallback", "2026-01-01");
  insert.run("globalTop", JSON.stringify([{ name: "Trending" }]), "2026-01-01");
  insert.run("user:1:topGenres", JSON.stringify(["shoegaze"]), "2026-01-01");
  before.close();
  const db = openAurralDatabase({ dbPath: loaded.dbPath, dataDir: loaded.dataDir, env: { DOWNLOAD_FOLDER: loaded.downloadRoot } });
  try {
    const rows = Object.fromEntries(
      db.prepare("SELECT key, value FROM discovery_cache").all().map((row) => [row.key, row.value]),
    );
    for (const key of ["fallbackGenres", "fallbackGenrePools", "topTags"]) assert.equal(Object.hasOwn(rows, key), false, key);
    assert.equal(rows.provider, "listenbrainz");
    assert.ok(rows.globalTop);
    assert.ok(rows["user:1:topGenres"]);
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
