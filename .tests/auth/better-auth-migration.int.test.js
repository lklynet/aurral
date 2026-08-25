import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";
import {
  assertBetterAuthCoreSchema,
  readBetterAuthAccount,
  requestBetterAuth,
} from "../helpers/betterAuthFixtures.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "better-auth-migration",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let server;
const legacyPassword = "legacy-password";

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: true, integrations: {} });

  const legacyHash = bcrypt.hashSync(legacyPassword, 4);
  const legacyUser = userOps.createUser("legacy@example.com", legacyHash, "user");
  db.prepare(
    `INSERT INTO play_events
      (user_id, track_id, title, artist, played_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    legacyUser.id,
    "legacy-track",
    "Legacy Track",
    "Legacy Artist",
    Date.now(),
    "migration-test",
    Date.now(),
  );

  process.env.BETTER_AUTH_SECRET = "aurral-test-secret-for-better-auth";
  server = await startServerProcess();
});

test.after(async () => {
  await server?.stop();
  delete process.env.BETTER_AUTH_SECRET;
  await cleanupIsolatedState(isolatedState);
});

test("migrates legacy bcrypt credentials into Better Auth without changing numeric app IDs", async () => {
  assertBetterAuthCoreSchema(db);

  const legacyUser = db
    .prepare('SELECT id FROM "users" WHERE username = ?')
    .get("legacy@example.com");
  const migratedUser = db
    .prepare('SELECT * FROM "users" WHERE email = ?')
    .get("legacy@example.com");
  assert.ok(migratedUser);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM "users" WHERE email = ?').get("legacy@example.com").count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user'")
      .get().count,
    0,
  );
  assert.equal(Number(migratedUser.id), legacyUser.id);
  assert.equal(Number.isInteger(legacyUser.id), true);
  assert.equal(migratedUser.email, "legacy@example.com");
  assert.ok(String(migratedUser.name).trim());

  const credentialAccounts = readBetterAuthAccount(db, migratedUser.id).filter(
    (account) => account.provider_id === "credential",
  );
  assert.equal(credentialAccounts.length, 1);
  const credential = credentialAccounts[0];
  assert.equal(credential.issuer, "local:credential");
  assert.equal(String(credential.account_id), String(migratedUser.id));
  assert.equal(await bcrypt.compare(legacyPassword, credential.password), true);

  for (const table of ["lastfm_link_states", "subsonic_stars", "play_events", "inbox_items"]) {
    const foreignKeys = db.pragma(`foreign_key_list(${table})`);
    assert.equal(
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "users" && foreignKey.from === "user_id" && foreignKey.to === "id",
      ),
      true,
      `${table}.user_id must continue referencing users.id`,
    );
  }

  const appData = db
    .prepare('SELECT user_id, track_id FROM "play_events" WHERE track_id = ?')
    .get("legacy-track");
  assert.equal(appData.user_id, legacyUser.id);
  assert.equal(Number(migratedUser.id), appData.user_id);

  const login = await requestBetterAuth(server, "/sign-in/email", {
    method: "POST",
    body: { email: "legacy@example.com", password: legacyPassword },
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.payload));
  assert.ok(login.authToken);
  assert.equal(String(login.payload.user.id), String(legacyUser.id));
  assert.equal(await bcrypt.compare(legacyPassword, credential.password), true);
});
