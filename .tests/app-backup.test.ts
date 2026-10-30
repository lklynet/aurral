import assert from "node:assert/strict";
import { createWriteStream, openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { afterAll, test } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { db }, { userOps }, { createSession }, backup, { applyStagedRestore }, zip] =
  await setupIsolatedBackend(
    "app-backup",
    () => import("../backend/config/db-sqlite.ts"),
    () => import("../backend/db/helpers/index.ts"),
    () => import("../backend/config/session-helpers.ts"),
    () => import("../backend/services/appBackup.ts"),
    () => import("../backend/config/stagedRestore.ts"),
    () => import("../backend/services/zip.ts"),
  );

const artworkDir = path.join(state.dataDir, "custom-artwork");
const restoreDir = path.join(state.dataDir, "restore");

afterAll(async () => {
  await cleanupIsolatedState(state);
});

async function saveBackup() {
  const { plan, release } = await backup.createBackup();
  const file = path.join(state.baseDir, "backup.zip");
  try {
    await pipeline(zip.zipStream(plan), createWriteStream(file));
  } finally {
    await release();
  }
  return file;
}

async function writeZip(name: string, files: { name: string; path: string }[]) {
  const file = path.join(state.baseDir, name);
  await pipeline(zip.zipStream(await zip.planZip(files)), createWriteStream(file));
  return file;
}

const upload = async (file: string) => (await openAsBlob(file)).stream();

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

test("a restored backup brings back the database and custom artwork without sessions", async () => {
  const admin = userOps.createUser("backup-admin", "hash", "admin");
  assert.ok(admin);
  createSession(admin.id);
  db.prepare("INSERT INTO settings (key, value) VALUES ('backup-test', 'before')").run();
  await fs.mkdir(artworkDir, { recursive: true });
  await fs.writeFile(path.join(artworkDir, "cover.image"), "original artwork");

  const file = await saveBackup();

  db.prepare("UPDATE settings SET value = 'after' WHERE key = 'backup-test'").run();
  await fs.writeFile(path.join(artworkDir, "cover.image"), "changed artwork");
  await fs.mkdir(path.join(state.dataDir, "library-artwork", "album-1"), { recursive: true });

  await backup.stageRestore(await upload(file));
  const previous = applyStagedRestore(state.dataDir, state.dbPath);

  const restored = new Database(state.dbPath, { readonly: true });
  try {
    const value = restored.prepare("SELECT value FROM settings WHERE key = 'backup-test'");
    assert.equal(value.pluck().get(), "before");
    assert.equal(restored.prepare("SELECT username FROM users").pluck().get(), "backup-admin");
    assert.equal(restored.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 0);
  } finally {
    restored.close();
  }
  assert.equal(await fs.readFile(path.join(artworkDir, "cover.image"), "utf8"), "original artwork");
  assert.ok(previous);
  assert.equal(
    await fs.readFile(path.join(previous, "custom-artwork", "cover.image"), "utf8"),
    "changed artwork",
  );
  assert.ok(await exists(path.join(previous, path.basename(state.dbPath))));
  assert.equal(await exists(path.join(state.dataDir, "library-artwork")), false);
  assert.equal(await exists(restoreDir), false);
});

test("restore extracts only the database and custom artwork", async () => {
  const database = path.join(state.baseDir, "snapshot.db");
  await db.backup(database);
  const payload = path.join(state.baseDir, "payload");
  await fs.writeFile(payload, "payload");
  const file = await writeZip("crafted.zip", [
    { name: "aurral.db", path: database },
    { name: "custom-artwork/kept.image", path: payload },
    { name: "custom-artwork/../escape", path: payload },
    { name: "../escape", path: payload },
    { name: "image-proxy/cached.jpg", path: payload },
  ]);

  await backup.stageRestore(await upload(file));

  assert.deepEqual(await fs.readdir(path.join(restoreDir, "custom-artwork")), ["kept.image"]);
  assert.deepEqual((await fs.readdir(restoreDir)).sort(), ["aurral.db", "custom-artwork"]);
  assert.equal(await exists(path.join(state.dataDir, "escape")), false);
  assert.equal(await exists(path.join(state.baseDir, "escape")), false);
  await fs.rm(restoreDir, { recursive: true });
});

test("restore rejects files that are not Aurral backups and stages nothing", async () => {
  const text = path.join(state.baseDir, "notes.txt");
  await fs.writeFile(text, "not a backup");
  const textAsDatabase = await writeZip("text-database.zip", [{ name: "aurral.db", path: text }]);
  const withoutDatabase = await writeZip("no-database.zip", [
    { name: "custom-artwork/cover.image", path: text },
  ]);
  const otherApp = path.join(state.baseDir, "other-app.db");
  const other = new Database(otherApp);
  other.exec("CREATE TABLE settings (name TEXT); CREATE TABLE users (id INTEGER)");
  other.close();
  const otherAppDatabase = await writeZip("other-app.zip", [{ name: "aurral.db", path: otherApp }]);

  await assert.rejects(backup.stageRestore(await upload(text)), backup.BackupError);
  for (const file of [textAsDatabase, withoutDatabase, otherAppDatabase]) {
    await assert.rejects(backup.stageRestore(await upload(file)), {
      message: "This file is not an Aurral backup.",
    });
  }
  assert.equal(await exists(restoreDir), false);
});

test("boot ignores a restore that never finished staging", async () => {
  await fs.mkdir(path.join(restoreDir, "custom-artwork"), { recursive: true });
  await fs.writeFile(path.join(restoreDir, "aurral.db.partial"), "partial");
  const live = await fs.readFile(state.dbPath);

  assert.equal(applyStagedRestore(state.dataDir, state.dbPath), null);

  assert.equal(await exists(restoreDir), false);
  assert.deepEqual(await fs.readFile(state.dbPath), live);
});
