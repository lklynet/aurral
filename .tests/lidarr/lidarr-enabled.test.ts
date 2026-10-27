import { test, beforeAll, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "lidarr-enabled",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");
const { api } = await import("../../backend/routes/api.ts");
const { resolveLidarrTestCredentials, withTemporaryLidarrClient } =
  await import("../../backend/services/lidarrTestSession.ts");

function setLidarrSettings(
  lidarr: NonNullable<NonNullable<ReturnType<typeof dbOps.getSettings>>["integrations"]["lidarr"]>,
) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...(settings.integrations || {}),
      lidarr: { ...(settings.integrations?.lidarr || {}), ...lidarr },
    },
  });
}

beforeAll(() => {
  resetDatabase(db);
});

afterAll(async () => {
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

test("root folder reads retain saved paths while lidarr is disabled", async () => {
  const rootPath = "/data/music";
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "saved-key",
    enabled: false,
    rootFolderPath: null,
    rootFolderPaths: [rootPath],
  });
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("disabled root-folder reads must stay local");
  });
  const response = await signedInAs(undefined).route("/", api).request("/library/rootfolder");

  assert.deepEqual(await response.json(), [{ path: rootPath }]);
  assert.equal(request.mock.calls.length, 0);
});

test("disabled lidarr makes no network call from client requests", async () => {
  setLidarrSettings({ url: "http://127.0.0.1:9", apiKey: "saved-key", enabled: false });

  await assert.rejects(
    () => lidarrClient.request("/artist", "GET", null, true),
    /Lidarr is disabled/,
  );
});

test("discovered root paths are reused without another root-folder request", async () => {
  const rootPath = "/data/music";
  setLidarrSettings({
    url: "http://127.0.0.1:18686",
    apiKey: "saved-key",
    enabled: true,
    rootFolderPath: null,
    rootFolderPaths: [rootPath],
  });
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("root-folder discovery should be cached");
  });

  assert.deepEqual(await lidarrClient.getRootFolders(), [{ path: rootPath }]);
  assert.equal(request.mock.calls.length, 0);
});

test("saved-credential test fallback is refused while lidarr is disabled", () => {
  setLidarrSettings({ url: "http://127.0.0.1:18686", apiKey: "saved-key", enabled: false });

  assert.throws(() => resolveLidarrTestCredentials({}, lidarrClient), /Lidarr is disabled/);
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

test("library root reads survive a temporary Lidarr settings call", async () => {
  setLidarrSettings({
    url: "http://saved-lidarr:8686",
    apiKey: "saved-key",
    enabled: true,
    rootFolderPath: "/saved/music",
    rootFolderPaths: ["/saved/music"],
  });

  await withTemporaryLidarrClient(
    "http://settings-lidarr:8686",
    "temporary-key",
    async (temporaryClient) => {
      Reflect.deleteProperty(temporaryClient.config, "rootFolderPaths");
      assert.deepEqual(temporaryClient.getConfiguredRootFolderPaths(), []);
      assert.deepEqual(lidarrClient.getConfiguredRootFolderPaths(), ["/saved/music"]);
    },
  );
});
