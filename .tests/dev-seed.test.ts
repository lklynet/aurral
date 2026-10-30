import assert from "node:assert/strict";
import * as v from "valibot";
import { afterAll, test } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { db }, { dbOps, userOps }, { createSession }, { verifyPassword }, honker, seed] =
  await setupIsolatedBackend(
    "dev-seed",
    () => import("../backend/config/db-sqlite.ts"),
    () => import("../backend/db/helpers/index.ts"),
    () => import("../backend/config/session-helpers.ts"),
    () => import("../backend/middleware/passwordHash.ts"),
    () => import("../backend/services/honkerDb.ts"),
    () => import("../backend/services/devSeed.ts"),
    () => import("../backend/services/metadataProviderBudget.ts"),
  );
honker.getHonkerDb();

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const count = (table: string) =>
  db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;

test("a seed keeps the library and loses everything that reaches real services", () => {
  const admin = userOps.createUser("lee", "real-hash", "admin", null, true, true, "real-subsonic");
  assert.ok(admin);
  createSession(admin.id);
  dbOps.updateSettings({
    integrations: { lidarr: { url: "http://lidarr.test", apiKey: "real-key" } },
  });
  dbOps.setJSONSetting("flows", [
    { id: "weekly", name: "Weekly", enabled: true, nextRunAt: 1, lidarrFeedToken: "feed" },
  ]);
  dbOps.setJSONSetting("missingTrackSearch", { enabled: true, intervalDays: 1 });
  db.prepare("INSERT INTO settings (key, value) VALUES ('shareInstanceSecret', 'secret')").run();
  db.prepare(
    "INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES ('artist', 'Artist', 0, 0)",
  ).run();

  seed.seedDatabase();
  dbOps.invalidateSettingsCache();

  assert.equal(count("sessions"), 0);
  assert.equal(count("library_artists"), 1);
  assert.equal(
    db.prepare("SELECT 1 FROM settings WHERE key = 'shareInstanceSecret'").get(),
    undefined,
  );
  const settings = dbOps.getSettings();
  assert.equal(settings.integrations.lidarr?.apiKey, undefined);
  assert.deepEqual(dbOps.getJSONSetting("flows", seed.flowsSchema), [
    { id: "weekly", name: "Weekly", enabled: false, nextRunAt: null, lidarrFeedToken: null },
  ]);
  assert.deepEqual(dbOps.getJSONSetting("missingTrackSearch", v.looseObject({})), {
    enabled: false,
    intervalDays: 1,
  });
  const user = userOps.getUserById(admin.id);
  assert.equal(user?.username, seed.SEED_LOGIN.username);
  assert.ok(user && verifyPassword(seed.SEED_LOGIN.password, user.passwordHash));
});

test("a seed refuses a table it does not know", () => {
  db.exec("CREATE TABLE new_tokens (token TEXT)");
  try {
    assert.throws(() => seed.seedDatabase(), /new_tokens/);
  } finally {
    db.exec("DROP TABLE new_tokens");
  }
});
