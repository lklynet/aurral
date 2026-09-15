import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { lidarrClient }, { withTemporaryLidarrClient }, { registerLidarr }] = await setupIsolatedBackend(
  "lidarr-test-session",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/lidarrClient.js",
  "backend/services/lidarrTestSession.js",
  "backend/routes/settings/handlers/lidarr.js",
);

const routes = new Map();
registerLidarr({ get(route, handler) { routes.set(route, handler); }, post() {} });

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { lidarr: {
      enabled: true,
      url: "http://saved-lidarr:8686",
      apiKey: "saved-key",
      rootFolderPath: "/saved/music",
      rootFolderPaths: ["/saved/music"],
    } },
    onboardingComplete: true,
  });
  lidarrClient._holdConfig = false;
  lidarrClient.updateConfig();
  lidarrClient._rootFoldersCache = null;
});

test.after(async () => {
  lidarrClient._httpAgent.destroy();
  lidarrClient._httpsAgent.destroy();
  db.close();
  await cleanupIsolatedState(state);
});

for (const query of [{}, { url: "http://test-lidarr:8686/", apiKey: " test-key " }]) {
  test(`Settings root folder lookup succeeds with ${query.url ? "provided" : "saved"} credentials`, async (t) => {
    const originalUrl = lidarrClient.config.url;
    const originalKey = lidarrClient.config.apiKey;
    const originalApiPath = lidarrClient.apiPath;
    const request = t.mock.method(lidarrClient, "request", async (endpoint) => {
      assert.equal(endpoint, "/rootFolder");
      assert.equal(lidarrClient.config.url, query.url ? "http://test-lidarr:8686" : originalUrl);
      assert.equal(lidarrClient.config.apiKey, query.url ? "test-key" : originalKey);
      assert.equal(lidarrClient.config.rootFolderPath, null);
      assert.deepEqual(lidarrClient.getConfiguredRootFolderPaths(), []);
      return [{ id: 1, path: "/test/music" }];
    });
    const response = { statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await routes.get("/lidarr/root-folders")({ query }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body[0].path, "/test/music");
    assert.equal(request.mock.callCount(), 1);
    assert.equal(lidarrClient.config.url, originalUrl);
    assert.equal(lidarrClient.config.apiKey, originalKey);
    assert.equal(lidarrClient.apiPath, originalApiPath);
    assert.equal(lidarrClient._holdConfig, false);
  });
}

for (const fails of [false, true]) {
  test(`temporary root defaults and original configuration survive ${fails ? "failure" : "success"}`, async () => {
    const original = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;
    const operation = withTemporaryLidarrClient("http://temporary-lidarr:8686/", " temporary-key ", async (client) => {
      assert.equal(client.config.rootFolderPath, null);
      assert.deepEqual(client.config.rootFolderPaths, []);
      assert.deepEqual(client.getConfiguredRootFolderPaths(), []);
      assert.equal(client._holdConfig, true);
      assert.equal(client.apiPath, "/api/v1");
      if (fails) throw new Error("Lidarr request failed");
      return "success";
    });
    if (fails) await assert.rejects(operation, /Lidarr request failed/);
    else assert.equal(await operation, "success");
    assert.deepEqual(lidarrClient.config, original);
    assert.equal(lidarrClient.apiPath, originalApiPath);
    assert.equal(lidarrClient._holdConfig, false);
  });
}
