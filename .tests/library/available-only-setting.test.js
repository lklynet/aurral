import assert from "node:assert/strict";
import test from "node:test";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { resolveAvailableOnly }] = await setupIsolatedBackend(
  "available-only-setting",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/routes/library/handlers/libraryIndex.js",
);

const saveLidarr = (lidarr) => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: { lidarr } });
  return dbOps.getSettings();
};

const connected = (extra = {}) =>
  saveLidarr({ enabled: true, url: "http://lidarr:8686", apiKey: "key", ...extra });

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("explicit availableOnly query param overrides the configured default", () => {
  assert.equal(resolveAvailableOnly("true", connected({ availableOnly: false })), true);
  assert.equal(resolveAvailableOnly("false", connected({ availableOnly: true })), false);
  assert.equal(resolveAvailableOnly("true", saveLidarr({})), true);
});

test("with Lidarr connected, the setting decides and defaults to on", () => {
  assert.equal(resolveAvailableOnly(undefined, connected({ availableOnly: true })), true);
  assert.equal(resolveAvailableOnly(undefined, connected({ availableOnly: false })), false);
  assert.equal(resolveAvailableOnly(undefined, connected()), true);
});

test("with Lidarr turned off or missing an API key, nothing is hidden", () => {
  assert.equal(resolveAvailableOnly(undefined, connected({ enabled: false, availableOnly: true })), false);
  assert.equal(resolveAvailableOnly(undefined, saveLidarr({ availableOnly: true })), false);
});
