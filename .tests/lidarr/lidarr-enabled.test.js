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
const { registerMisc } = await import("../../backend/routes/library/handlers/misc.js");
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

test("root folder reads retain saved paths while lidarr is disabled", async (t) => {
  const rootPath = "/data/music";
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "saved-key",
    enabled: false,
    rootFolderPath: null,
    rootFolderPaths: [rootPath],
  });
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("disabled root-folder reads must stay local");
  });
  const routes = new Map();
  registerMisc({
    get(routePath, ...handlers) {
      routes.set(routePath, handlers.at(-1));
    },
    post() {},
    put() {},
    delete() {},
  });
  let body;
  await routes.get("/rootfolder")({}, {
    json(value) {
      body = value;
      return this;
    },
  });

  assert.deepEqual(body, [{ path: rootPath }]);
  assert.equal(request.mock.callCount(), 0);
});

test("disabled lidarr makes no network call from client requests", async () => {
  setLidarrSettings({ url: "http://127.0.0.1:9", apiKey: "saved-key", enabled: false });

  await assert.rejects(
    () => lidarrClient.request("/artist", "GET", null, true),
    /Lidarr is disabled/,
  );
});

test("discovered root paths are reused without another root-folder request", async (t) => {
  const rootPath = "/data/music";
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "saved-key",
    enabled: true,
    rootFolderPath: null,
    rootFolderPaths: [rootPath],
  });
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("root-folder discovery should be cached");
  });

  assert.deepEqual(await lidarrClient.getRootFolders(), [{ path: rootPath }]);
  assert.equal(request.mock.callCount(), 0);
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
