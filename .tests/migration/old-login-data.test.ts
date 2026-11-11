import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

const bootDb = () => {
  vi.resetModules();
  return import("../../backend/config/db-sqlite.ts");
};

test("starting drops the SSO adoption columns and keeps the users", async () => {
  const paths = await createIsolatedStateDir("old-login-columns");
  applyIsolatedBackendEnv(paths);
  try {
    const { db: before } = await bootDb();
    before.exec(`
      PRAGMA user_version = 0;
      ALTER TABLE users ADD COLUMN needs_identity_migration INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN allow_identity_adoption INTEGER NOT NULL DEFAULT 0;
      INSERT INTO users (username, password_hash, needs_identity_migration, allow_identity_adoption)
        VALUES ('gordon', 'hash', 1, 1);
    `);
    before.close();

    const { db } = await bootDb();
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(users)")
      .all()
      .map((column) => column.name);
    assert.equal(columns.includes("needs_identity_migration"), false);
    assert.equal(columns.includes("allow_identity_adoption"), false);
    assert.deepEqual(db.prepare("SELECT username FROM users").all(), [{ username: "gordon" }]);
    db.close();
  } finally {
    await cleanupIsolatedState(paths);
  }
});

test("starting removes the login stored in integration settings once", async () => {
  const paths = await createIsolatedStateDir("old-login-settings");
  applyIsolatedBackendEnv(paths);
  try {
    const { db: before } = await bootDb();
    before.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('integrations', ?)").run(
      JSON.stringify({
        general: { authUser: "owner", authPassword: "first-password", apiKey: "kept" },
        slskd: { url: "http://slskd" },
      }),
    );
    before.prepare("DELETE FROM settings WHERE key = 'migration:settings-login-v1'").run();
    before.pragma("user_version = 0");
    before.close();

    const { db } = await bootDb();
    const stored = db
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'integrations'")
      .get();
    assert.deepEqual(JSON.parse(stored?.value ?? "null"), {
      general: { apiKey: "kept" },
      slskd: { url: "http://slskd" },
    });
    db.close();
  } finally {
    await cleanupIsolatedState(paths);
  }
});
