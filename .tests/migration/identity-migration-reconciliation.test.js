import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "url";
import { join } from "path";
import Database from "better-sqlite3";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const dbModuleUrl = pathToFileURL(
  join(process.cwd(), "backend/config/db-sqlite.js"),
).href;

async function bootDb() {
  return import(`${dbModuleUrl}?boot=${Date.now()}-${Math.random()}`);
}

test("identity upgrade protects the historical recovery admin, expires ambiguous sessions, and enables cascades", async () => {
  const paths = await createIsolatedStateDir("identity-migration-security");
  applyIsolatedBackendEnv(paths);

  const legacyDb = new Database(paths.dbPath);
  legacyDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      permissions TEXT,
      discover_layout TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  legacyDb.prepare("INSERT INTO settings (key, value) VALUES ('integrations', ?)").run(
    JSON.stringify({ general: { authUser: "recovery-admin", authPassword: "encrypted-or-plain" } }),
  );
  const userId = legacyDb.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('recovery-admin', 'legacy-hash', 'admin')",
  ).run().lastInsertRowid;
  legacyDb.prepare(
    "INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, 'legacy-session', ?, ?)",
  ).run(userId, Date.now(), Date.now() + 60_000);
  legacyDb.close();

  const { db } = await bootDb();
  const migrated = db.prepare(
    "SELECT is_protected, has_local_password FROM users WHERE id = ?",
  ).get(userId);
  assert.equal(migrated.is_protected, 1);
  assert.equal(migrated.has_local_password, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);

  db.prepare(
    "INSERT INTO user_identities (user_id, provider_type, provider_key, subject, linked_at) VALUES (?, 'oidc', 'issuer', 'subject', ?)",
  ).run(userId, Date.now());
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_identities").get().count, 0);
  db.close();
  await cleanupIsolatedState(paths);
});

test("reboot clears needs_identity_migration for a user whose identity was already linked before the flag existed", async () => {
  const paths = await createIsolatedStateDir("identity-migration-reconciliation");
  applyIsolatedBackendEnv(paths);

  const { db: firstBootDb } = await bootDb();
  const insertUser = firstBootDb.prepare(
    "INSERT INTO users (username, password_hash, role, is_protected, role_source, has_local_password) VALUES (?, ?, ?, 0, 'oidc', 0)",
  );
  const result = insertUser.run("gordon.may", "system-provisioned", "admin");
  const userId = result.lastInsertRowid;

  firstBootDb.prepare(
    "INSERT INTO user_identities (user_id, provider_type, provider_key, subject, linked_at) VALUES (?, 'oidc', 'https://idp.example/', 'subject-1', ?)",
  ).run(userId, Date.now());

  firstBootDb.prepare(
    "UPDATE users SET needs_identity_migration = 1, allow_identity_adoption = 1 WHERE id = ?",
  ).run(userId);
  firstBootDb.close();

  const { db: secondBootDb } = await bootDb();
  const row = secondBootDb
    .prepare(
      "SELECT needs_identity_migration, allow_identity_adoption FROM users WHERE id = ?",
    )
    .get(userId);

  assert.equal(
    row.needs_identity_migration,
    0,
    "an account that already has a linked identity must not stay flagged as needing SSO adoption",
  );
  assert.equal(
    row.allow_identity_adoption,
    0,
    "adoption approval must be cleared once an identity is already linked, so it can't be reused unexpectedly",
  );
  secondBootDb.close();

  await cleanupIsolatedState(paths);
});

test("reboot leaves needs_identity_migration set for a legacy account with no linked identity yet", async () => {
  const paths = await createIsolatedStateDir("identity-migration-reconciliation-legacy");
  applyIsolatedBackendEnv(paths);

  const { db: firstBootDb } = await bootDb();
  const insertUser = firstBootDb.prepare(
    "INSERT INTO users (username, password_hash, role, is_protected, role_source, has_local_password) VALUES (?, ?, ?, 0, 'local', 0)",
  );
  const result = insertUser.run("jody.may", "some-hash", "user");
  const userId = result.lastInsertRowid;

  firstBootDb.prepare(
    "UPDATE users SET needs_identity_migration = 1 WHERE id = ?",
  ).run(userId);
  firstBootDb.close();

  const { db: secondBootDb } = await bootDb();
  const row = secondBootDb
    .prepare("SELECT needs_identity_migration FROM users WHERE id = ?")
    .get(userId);

  assert.equal(
    row.needs_identity_migration,
    1,
    "an account with no linked identity yet must stay flagged so it can still be claimed",
  );
  secondBootDb.close();

  await cleanupIsolatedState(paths);
});
