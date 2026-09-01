import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { registerGeneral }, { playlistManager }] =
  await setupIsolatedBackend(
    "general-settings",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/routes/settings/handlers/general.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test.after(() => cleanupIsolatedState(isolatedState));

test("schedules the library scan after playlist initialization settles", async () => {
  const events = [];
  let releaseInitialization;
  const initialization = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  const originalUpdateConfig = playlistManager.updateConfig;
  const originalEnsureSmartPlaylists = playlistManager.ensureSmartPlaylists;
  const originalScheduleScanLibrary = playlistManager.scheduleScanLibrary;

  try {
    playlistManager.updateConfig = () => {};
    playlistManager.ensureSmartPlaylists = async () => {
      events.push("ensure-start");
      await initialization;
      events.push("ensure-end");
    };
    playlistManager.scheduleScanLibrary = () => {
      events.push("scan");
    };

    const routes = {};
    registerGeneral({
      get(path, ...handlers) {
        routes[`GET ${path}`] = handlers.at(-1);
      },
      post(path, ...handlers) {
        routes[`POST ${path}`] = handlers.at(-1);
      },
    });

    let statusCode = 200;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    const handlerPromise = routes["POST /"](
      {
        body: { integrations: { jellyfin: { url: "", apiKey: "", userId: "" } } },
        user: { id: 1 },
      },
      response,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["ensure-start"]);

    releaseInitialization();
    await handlerPromise;
    assert.equal(statusCode, 200);
    assert.ok(responseBody);
    assert.deepEqual(events, ["ensure-start", "ensure-end", "scan"]);
  } finally {
    playlistManager.updateConfig = originalUpdateConfig;
    playlistManager.ensureSmartPlaylists = originalEnsureSmartPlaylists;
    playlistManager.scheduleScanLibrary = originalScheduleScanLibrary;
  }
});

function captureSettingsRoutes() {
  const routes = {};
  registerGeneral({
    get(path, ...handlers) {
      routes[`GET ${path}`] = handlers.at(-1);
    },
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers.at(-1);
    },
  });
  const makeResponse = () => {
    let state = { statusCode: 200, body: null };
    return {
      get statusCode() {
        return state.statusCode;
      },
      get body() {
        return state.body;
      },
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    };
  };
  const postSettings = async (body) => {
    const response = makeResponse();
    await routes["POST /"]({ body, user: { id: 1 } }, response);
    return response;
  };
  const getSettings = async () => {
    const response = makeResponse();
    await routes["GET /"]({}, response);
    return response;
  };
  return { postSettings, getSettings };
}

test("saves overlapping roots with an equal overlap warning", async () => {
  const { postSettings } = captureSettingsRoutes();
  const sharedRoot = join(isolatedState.baseDir, "roots", "shared");
  dbOps.updateSettings({
    downloadFolderPath: sharedRoot,
    integrations: {
      lidarr: { url: "http://127.0.0.1:18686", apiKey: "key", rootFolderPath: sharedRoot },
    },
  });

  const response = await postSettings({
    integrations: {
      lidarr: { rootFolderPath: sharedRoot },
    },
  });

  assert.equal(response.statusCode, 200);
  const warnings = response.body.rootWarnings;
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, "equal");
  assert.match(warnings[0].message, /rename, import, or delete/);
});

test("does not warn about lidarr roots while lidarr is disabled", async () => {
  const { getSettings, postSettings } = captureSettingsRoutes();
  const sharedRoot = join(isolatedState.baseDir, "roots", "disabled-shared");
  dbOps.updateSettings({
    downloadFolderPath: sharedRoot,
    integrations: {
      lidarr: {
        url: "http://127.0.0.1:18686",
        apiKey: "key",
        enabled: false,
        rootFolderPath: sharedRoot,
      },
    },
  });

  const saved = await postSettings({
    integrations: {
      lidarr: { rootFolderPath: sharedRoot },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.rootWarnings, []);

  const current = await getSettings();
  assert.deepEqual(current.body.rootWarnings, []);
});
