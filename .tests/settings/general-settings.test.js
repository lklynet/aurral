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

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

for (const fails of [false, true]) {
  test(`saves settings before slow playback initialization ${fails ? "fails" : "finishes"}`, async (t) => {
    const events = [];
    const { logger } = await import("../../backend/services/logger.js");
    const warnings = t.mock.method(logger, "warn", () => {});
    let releaseInitialization;
    const initialization = new Promise((resolve) => {
      releaseInitialization = resolve;
    });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    t.mock.method(playlistManager, "updateConfig", () => {});
    t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {
      events.push("ensure-start");
      markStarted();
      await initialization;
      events.push("ensure-end");
      if (fails) throw new Error("Jellyfin library unavailable");
    });
    t.mock.method(playlistManager, "scheduleScanLibrary", (force) => {
      assert.equal(force, true);
      events.push("scan");
    });
    const { postSettings } = captureSettingsRoutes();
    let response;
    const handlerPromise = postSettings({
      integrations: { jellyfin: { url: "http://jellyfin.local", apiKey: "key", userId: "user" } },
    }).then((saved) => { response = saved; });

    try {
      await started;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events, ["ensure-start"]);
      assert.ok(response, "settings response must not wait for the Jellyfin library");
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.integrations.jellyfin.url, "http://jellyfin.local");
      assert.equal(dbOps.getSettings().integrations.jellyfin.url, "http://jellyfin.local");
    } finally {
      releaseInitialization();
      await handlerPromise;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events, ["ensure-start", "ensure-end", "scan"]);
    assert.equal(warnings.mock.callCount(), fails ? 1 : 0);
    if (fails) {
      assert.deepEqual(warnings.mock.calls[0].arguments, [
        "settings", "Failed to initialize playback playlists:",
        { message: "Jellyfin library unavailable" },
      ]);
    }
  });
}

test("saving unrelated settings with unchanged playback configuration skips initialization and scans", async (t) => {
  const update = t.mock.method(playlistManager, "updateConfig", () => {});
  const ensure = t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  const scan = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});
  dbOps.updateSettings({ integrations: {
    jellyfin: { url: "http://jellyfin.local", apiKey: "key", userId: "user" },
    navidrome: { url: "http://navidrome.local", username: "user", password: "password" },
  } });
  const { postSettings } = captureSettingsRoutes();
  const current = dbOps.getSettings();
  const response = await postSettings({
    integrations: {
      ...current.integrations,
      jellyfin: { userId: "user", apiKey: "key", url: "http://jellyfin.local" },
      deemix: { enabled: true, url: "http://deemix.local", bitrate: 9 },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(dbOps.getSettings().integrations.deemix.url, "http://deemix.local");

  const partial = await postSettings({ integrations: { jellyfin: { userId: "user" } } });
  assert.equal(partial.statusCode, 200);
  const unrelated = await postSettings({ dateTimeFormat: "year-first" });
  assert.equal(unrelated.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(update.mock.callCount(), 0);
  assert.equal(ensure.mock.callCount(), 0);
  assert.equal(scan.mock.callCount(), 0);
});

for (const key of ["jellyfin", "navidrome"]) {
  test(`refreshes playback when ${key} settings change or are cleared`, async (t) => {
    const update = t.mock.method(playlistManager, "updateConfig", () => {});
    const ensure = t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
    const scan = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});
    const { postSettings } = captureSettingsRoutes();
    for (const url of [`http://${key}.local`, ""]) {
      const response = await postSettings({ integrations: { [key]: { url } } });
      assert.equal(response.statusCode, 200);
      assert.equal(dbOps.getSettings().integrations[key].url, url);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(update.mock.callCount(), 2);
    assert.equal(ensure.mock.callCount(), 2);
    assert.equal(scan.mock.callCount(), 2);
  });
}

test("logs background scan scheduling failures without failing the settings save", async (t) => {
  const { logger } = await import("../../backend/services/logger.js");
  const warnings = t.mock.method(logger, "warn", () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", () => {
    throw new Error("Scan queue unavailable");
  });
  const { postSettings } = captureSettingsRoutes();
  const response = await postSettings({ integrations: { jellyfin: { url: "http://jellyfin.local" } } });
  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings.mock.calls[0].arguments, [
    "settings", "Failed to schedule playback library scan:",
    { message: "Scan queue unavailable" },
  ]);
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
