import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "lidarr-enabled",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

const { lidarrClient } = await import("../../backend/services/lidarrClient.js");
const { resolveLidarrTestCredentials } = await import(
  "../../backend/services/lidarrTestSession.js"
);

function setLidarrSettings(lidarr) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...(settings.integrations || {}),
      lidarr: { ...(settings.integrations?.lidarr || {}), ...lidarr },
    },
  });
}

test.before(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("legacy settings with an api key and no enabled value stay enabled", () => {
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "legacy-key",
    enabled: undefined,
  });

  assert.equal(lidarrClient.isEnabled(), true);
  assert.equal(lidarrClient.isConfigured(), true);
  assert.equal(lidarrClient.getConfig().apiKey, "legacy-key");
});

test("an explicit false disables lidarr without clearing saved settings", () => {
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "saved-key",
    enabled: false,
  });

  assert.equal(lidarrClient.isEnabled(), false);
  assert.equal(lidarrClient.isConfigured(), false);
  assert.equal(lidarrClient.getConfig().url, "http://127.0.0.1:18686");
  assert.equal(lidarrClient.getConfig().apiKey, "saved-key");
});

test("disabled lidarr makes no network call from client requests", async () => {
  setLidarrSettings({ url: "http://127.0.0.1:9", apiKey: "saved-key", enabled: false });

  await assert.rejects(
    () => lidarrClient.request("/artist", "GET", null, true),
    /Lidarr is disabled/,
  );
});

test("saved-credential test fallback is refused while lidarr is disabled", () => {
  setLidarrSettings({ url: "http://127.0.0.1:18686", apiKey: "saved-key", enabled: false });

  assert.throws(
    () => resolveLidarrTestCredentials({}, lidarrClient),
    /Lidarr is disabled/,
  );
});

test("explicitly provided test credentials still work while lidarr is disabled", () => {
  const resolved = resolveLidarrTestCredentials(
    { url: "http://lan-host:8686", apiKey: "provided-key" },
    lidarrClient,
  );
  assert.equal(resolved.usingProvided, true);
  assert.equal(resolved.apiKey, "provided-key");
});

test("re-enabling restores configured behavior without losing settings", () => {
  setLidarrSettings({ enabled: true });

  assert.equal(lidarrClient.isEnabled(), true);
  assert.equal(lidarrClient.isConfigured(), true);
  assert.equal(lidarrClient.getConfig().apiKey, "saved-key");
});
