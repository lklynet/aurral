import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeEach, afterAll, vi, type MockInstance } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { lidarrClient, LidarrClient },
  { withTemporaryLidarrClient },
  { api },
] = await setupIsolatedBackend(
  "lidarr-test-session",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/lidarrTestSession.ts"),
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {
      lidarr: {
        enabled: true,
        url: "http://saved-lidarr:8686",
        apiKey: "saved-key",
        rootFolderPath: "/saved/music",
        rootFolderPaths: ["/saved/music"],
      },
    },
    onboardingComplete: true,
  });
  lidarrClient._holdConfig = false;
  lidarrClient.updateConfig();
  lidarrClient._rootFoldersCache = null;
});

afterAll(async () => {
  lidarrClient._httpAgent.destroy();
  lidarrClient._httpsAgent.destroy();
  lidarrClient._httpsInsecureAgent.destroy();
  db.close();
  await cleanupIsolatedState(state);
});

for (const query of [{}, { url: "http://test-lidarr:8686/", apiKey: " test-key " }]) {
  test(`Settings root folder lookup succeeds with ${query.url ? "provided" : "saved"} credentials`, async () => {
    const originalUrl = lidarrClient.config.url;
    const originalKey = lidarrClient.config.apiKey;
    const originalApiPath = lidarrClient.apiPath;
    const savedSettings = dbOps.getSettings().integrations.lidarr;
    const savedCache = { data: [{ path: "/cached/saved/music" }], at: Date.now() };
    lidarrClient._rootFoldersCache = savedCache;
    const request = vi.spyOn(LidarrClient.prototype, "request").mockImplementation(async function (
      this: InstanceType<typeof LidarrClient>,
      endpoint,
    ) {
      assert.equal(endpoint, "/rootFolder");
      assert.notEqual(this, lidarrClient);
      assert.equal(this.config.url, query.url ? "http://test-lidarr:8686" : originalUrl);
      assert.equal(this.config.apiKey, query.url ? "test-key" : originalKey);
      assert.equal(this.config.rootFolderPath, null);
      assert.deepEqual(this.getConfiguredRootFolderPaths(), []);
      return [{ id: 1, path: "/test/music" }];
    });
    const search = query.url ? `?${new URLSearchParams(query)}` : "";
    const response = await app.request(`/settings/lidarr/root-folders${search}`);
    assert.equal(response.status, 200);
    const body: { path: string }[] = await response.json();
    assert.equal(body[0].path, "/test/music");
    assert.equal(request.mock.calls.length, 1);
    assert.equal(lidarrClient.config.url, originalUrl);
    assert.equal(lidarrClient.config.apiKey, originalKey);
    assert.equal(lidarrClient.apiPath, originalApiPath);
    assert.equal(lidarrClient._holdConfig, false);
    assert.deepEqual(dbOps.getSettings().integrations.lidarr, savedSettings);
    assert.equal(lidarrClient._rootFoldersCache, savedCache);
  });
}

for (const fails of [false, true]) {
  test(`temporary root defaults and original configuration survive ${fails ? "failure" : "success"}`, async () => {
    const original = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;
    const agentCleanup: MockInstance<() => void>[] = [];
    const operation = withTemporaryLidarrClient(
      "http://temporary-lidarr:8686/",
      " temporary-key ",
      async (client) => {
        assert.notEqual(client, lidarrClient);
        for (const agent of [client._httpAgent, client._httpsAgent, client._httpsInsecureAgent]) {
          agentCleanup.push(vi.spyOn(agent, "destroy"));
        }
        assert.equal(client.config.rootFolderPath, null);
        assert.deepEqual([...client.config.rootFolderPaths], []);
        assert.deepEqual(client.getConfiguredRootFolderPaths(), []);
        assert.equal(client._holdConfig, true);
        assert.equal(client.apiPath, "/api/v1");
        if (fails) throw new Error("Lidarr request failed");
        return "success";
      },
    );
    if (fails) await assert.rejects(operation, /Lidarr request failed/);
    else assert.equal(await operation, "success");
    assert.deepEqual(lidarrClient.config, original);
    assert.equal(lidarrClient.apiPath, originalApiPath);
    assert.equal(lidarrClient._holdConfig, false);
    for (const cleanup of agentCleanup) assert.equal(cleanup.mock.calls.length, 1);
  });
}

test("normal root folder discovery still persists the saved server's paths", async () => {
  vi.spyOn(lidarrClient, "request").mockImplementation(async () => [{ path: "/saved/new-music" }]);
  await lidarrClient.getRootFolders({ forceRefresh: true });
  assert.deepEqual(requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPaths, [
    "/saved/new-music",
  ]);
});

test("a failed temporary session does not persist roots discovered before the failure", async () => {
  const savedSettings = dbOps.getSettings().integrations.lidarr;
  vi.spyOn(LidarrClient.prototype, "request").mockImplementation(async () => [
    { path: "/temporary/music" },
  ]);
  await assert.rejects(
    withTemporaryLidarrClient("http://temporary-lidarr:8686", "key", async (client) => {
      await client.getRootFolders({ forceRefresh: true });
      assert.deepEqual(client.getConfiguredRootFolderPaths(), ["/temporary/music"]);
      throw new Error("Later operation failed");
    }),
    /Later operation failed/,
  );
  assert.deepEqual(dbOps.getSettings().integrations.lidarr, savedSettings);
});

test("overlapping temporary lookups keep their credentials and cached roots separate", async () => {
  const savedConfig = { ...lidarrClient.config };
  const savedSettings = dbOps.getSettings().integrations.lidarr;
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  vi.spyOn(LidarrClient.prototype, "request").mockImplementation(async function (
    this: InstanceType<typeof LidarrClient>,
  ) {
    if (this.config.apiKey === "first") {
      markFirstStarted();
      await firstPaused;
    }
    assert.equal(this.config.url, `http://${this.config.apiKey}-lidarr:8686`);
    return [{ path: `/${this.config.apiKey}/music` }];
  });
  const first = withTemporaryLidarrClient("http://first-lidarr:8686", "first", async (client) => {
    await client.getRootFolders();
    return client.getRootFolders();
  });
  await firstStarted;
  try {
    const second = await withTemporaryLidarrClient(
      "http://second-lidarr:8686",
      "second",
      (client) => client.getRootFolders(),
    );
    assert.deepEqual(second, [{ path: "/second/music" }]);
    assert.deepEqual(lidarrClient.config, savedConfig);
  } finally {
    releaseFirst();
    assert.deepEqual(await first, [{ path: "/first/music" }]);
  }
  assert.deepEqual(dbOps.getSettings().integrations.lidarr, savedSettings);
  assert.deepEqual(lidarrClient.config, savedConfig);
});
