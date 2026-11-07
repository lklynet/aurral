import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.ts";

function bootDb() {
  vi.resetModules();
  return import("../../backend/config/db-sqlite.ts");
}

test("reboot clears needs_identity_migration for a user whose identity was already linked before the flag existed", async () => {
  const paths = await createIsolatedStateDir("identity-migration-reconciliation");
  applyIsolatedBackendEnv(paths);

  const { db: firstBootDb } = await bootDb();
  const insertUser = firstBootDb.prepare(
    "INSERT INTO users (username, password_hash, role, is_protected, role_source, has_local_password) VALUES (?, ?, ?, 0, 'oidc', 0)",
  );
  const result = insertUser.run("gordon.may", "system-provisioned", "admin");
  const userId = result.lastInsertRowid;

  firstBootDb
    .prepare(
      "INSERT INTO user_identities (user_id, provider_type, provider_key, subject, linked_at) VALUES (?, 'oidc', 'https://idp.example/', 'subject-1', ?)",
    )
    .run(userId, Date.now());

  firstBootDb
    .prepare(
      "UPDATE users SET needs_identity_migration = 1, allow_identity_adoption = 1 WHERE id = ?",
    )
    .run(userId);
  firstBootDb.close();

  const { db: secondBootDb } = await bootDb();
  const row = secondBootDb
    .prepare<
      unknown[],
      {
        needs_identity_migration: import("../../backend/db/rows.ts").UsersRow["needs_identity_migration"];
        allow_identity_adoption: import("../../backend/db/rows.ts").UsersRow["allow_identity_adoption"];
      }
    >("SELECT needs_identity_migration, allow_identity_adoption FROM users WHERE id = ?")
    .get(userId);

  assert.ok(row != null);
  assert.equal(
    row.needs_identity_migration,
    0,
    "an account that already has a linked identity must not stay flagged as needing SSO adoption",
  );
  assert.ok(row != null);
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

  firstBootDb.prepare("UPDATE users SET needs_identity_migration = 1 WHERE id = ?").run(userId);
  firstBootDb.close();

  const { db: secondBootDb } = await bootDb();
  const row = secondBootDb
    .prepare<
      unknown[],
      {
        needs_identity_migration: import("../../backend/db/rows.ts").UsersRow["needs_identity_migration"];
      }
    >("SELECT needs_identity_migration FROM users WHERE id = ?")
    .get(userId);

  assert.ok(row != null);
  assert.equal(
    row.needs_identity_migration,
    1,
    "an account with no linked identity yet must stay flagged so it can still be claimed",
  );
  secondBootDb.close();

  await cleanupIsolatedState(paths);
});
