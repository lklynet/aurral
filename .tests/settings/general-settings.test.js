import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { registerGeneral },
  { playlistManager },
  { lidarrClient },
  libraryScans,
  honker,
] = await setupIsolatedBackend(
  "general-settings",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/routes/settings/handlers/general.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/lidarrClient.js",
  "backend/services/libraryScanWorker.js",
  "backend/services/honkerDb.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

function pendingPlaylistSyncs() {
  return honker.listHonkerJobs("playback")
    .filter(({ payload }) => payload?.kind === "playback-playlist-sync")
    .map(({ payload }) => payload);
}

function clearPendingPlaylistSyncs() {
  for (const { id, payload } of honker.listHonkerJobs("playback")) {
    if (payload?.kind === "playback-playlist-sync") honker.getPlaybackTaskQueue().cancel(id);
  }
}

test("saving playback settings queues a playlist sync without waiting for the media server", async (t) => {
  clearPendingPlaylistSyncs();
  t.after(clearPendingPlaylistSyncs);
  const { JellyfinClient } = await import("../../backend/services/jellyfin.js");
  const jellyfinRequests = t.mock.method(JellyfinClient.prototype, "request", () => new Promise(() => {}));
  const scan = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});
  const { postSettings } = captureSettingsRoutes();

  const response = await postSettings({
    integrations: { jellyfin: { url: "http://jellyfin.local", apiKey: "key", userId: "user" } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.integrations.jellyfin.url, "http://jellyfin.local");
  assert.equal(dbOps.getSettings().integrations.jellyfin.url, "http://jellyfin.local");
  assert.equal(jellyfinRequests.mock.callCount(), 0);
  assert.deepEqual(pendingPlaylistSyncs(), [{ kind: "playback-playlist-sync", entityIds: null, attempt: 0 }]);
  assert.deepEqual(scan.mock.calls.map((call) => call.arguments), [[true]]);
});

test("saving unrelated settings with unchanged playback configuration skips initialization and scans", async (t) => {
  clearPendingPlaylistSyncs();
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
  assert.deepEqual(pendingPlaylistSyncs(), []);
  assert.equal(scan.mock.callCount(), 0);
});

test("NZBGet leftover deletion defaults on and keeps an opt-out across partial saves", async () => {
  const { postSettings } = captureSettingsRoutes();
  const enabled = await postSettings({ integrations: { nzbget: { enabled: true,
    url: "http://nzbget.local", priority: 5 } } });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.body.integrations.nzbget.deleteLeftovers, true);
  assert.equal(enabled.body.integrations.nzbget.priority, 5);
  await postSettings({ integrations: { nzbget: { deleteLeftovers: false } } });
  await postSettings({ integrations: { nzbget: { nzbPriority: 10 } } });
  assert.equal(dbOps.getSettings().integrations.nzbget.deleteLeftovers, false);
});

test("the maximum review wait is validated and kept across partial saves", async () => {
  const { postSettings } = captureSettingsRoutes();
  for (const invalid of [-1, 1.5, 721, "24"]) {
    assert.equal((await postSettings({ reviewTimeoutHours: invalid })).statusCode, 400, String(invalid));
  }
  assert.equal((await postSettings({ reviewTimeoutHours: 48 })).statusCode, 200);
  await postSettings({ integrations: { nzbget: { nzbPriority: 10 } } });
  assert.equal(dbOps.getSettings().reviewTimeoutHours, 48);
});

for (const key of ["jellyfin", "navidrome"]) {
  test(`refreshes playback when ${key} settings change or are cleared`, async (t) => {
    clearPendingPlaylistSyncs();
    t.after(clearPendingPlaylistSyncs);
    const scan = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});
    const { postSettings } = captureSettingsRoutes();
    for (const url of [`http://${key}.local`, ""]) {
      const response = await postSettings({ integrations: { [key]: { url } } });
      assert.equal(response.statusCode, 200);
      assert.equal(dbOps.getSettings().integrations[key].url, url);
    }
    assert.deepEqual(pendingPlaylistSyncs(), [{ kind: "playback-playlist-sync", entityIds: null, attempt: 0 }]);
    assert.equal(scan.mock.callCount(), 2);
  });
}

test("a failure to queue the Library scan or the playlist sync does not block the other or the save", async (t) => {
  clearPendingPlaylistSyncs();
  t.after(clearPendingPlaylistSyncs);
  const { logger } = await import("../../backend/services/logger.js");
  const warnings = t.mock.method(logger, "warn", () => {});
  const scan = t.mock.method(playlistManager, "scheduleScanLibrary", () => {
    throw new Error("Scan queue unavailable");
  });
  const { postSettings } = captureSettingsRoutes();
  const scanFailure = await postSettings({ integrations: { jellyfin: { url: "http://jellyfin.local" } } });
  assert.equal(scanFailure.statusCode, 200);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments), [
    ["settings", "Failed to queue Library scan:", { message: "Scan queue unavailable" }],
  ]);
  assert.deepEqual(pendingPlaylistSyncs(), [{ kind: "playback-playlist-sync", entityIds: null, attempt: 0 }]);

  scan.mock.mockImplementation(() => {});
  t.mock.method(playlistManager, "requestPlaylistSync", () => {
    throw new Error("Sync queue unavailable");
  });
  warnings.mock.resetCalls();
  const syncFailure = await postSettings({ integrations: { jellyfin: { url: "http://jellyfin.other" } } });
  assert.equal(syncFailure.statusCode, 200);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments), [
    ["settings", "Failed to queue playback playlist sync:", { message: "Sync queue unavailable" }],
  ]);
  assert.deepEqual(scan.mock.calls.map((call) => call.arguments), [[true], [true]]);
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

test("the missing-track search setting keeps fields a save leaves out and never stores an unusable interval", async () => {
  const { getSettings, postSettings } = captureSettingsRoutes();

  await postSettings({ missingTrackSearch: { enabled: true, intervalDays: 3 } });
  const disabled = await postSettings({ missingTrackSearch: { enabled: false } });
  assert.equal(disabled.statusCode, 200);
  assert.deepEqual((await getSettings()).body.missingTrackSearch, { enabled: false, intervalDays: 3 });

  for (const intervalDays of [0, -3, "soon", null]) {
    await postSettings({ missingTrackSearch: { intervalDays } });
    const saved = dbOps.getSettings().missingTrackSearch.intervalDays;
    assert.ok(Number.isInteger(saved) && saved >= 1, `${String(intervalDays)} was stored as ${saved}`);
  }
});

test("turning Lidarr off or on starts a Library scan, and other saves do not", async (t) => {
  const { postSettings } = captureSettingsRoutes();
  t.mock.method(lidarrClient, "getRootFolders", async () => []);
  dbOps.updateSettings({
    integrations: { lidarr: { url: "http://127.0.0.1:18686", apiKey: "key", enabled: true } },
  });
  const scheduledScan = () => {
    const jobId = libraryScans.getScheduledLibraryScanJobId();
    const job = jobId == null ? null : honker.getLibraryScanQueue().getJob(jobId);
    return job ? JSON.parse(job.payload) : null;
  };
  const releaseTask = () => honker.findActiveHonkerJob(
    "system-task",
    (payload) => payload?.kind === "lidarr-files-release",
    { payloadKind: "lidarr-files-release" },
  );
  const clearScan = () => libraryScans.clearScheduledLibraryScan();
  clearScan();
  t.after(clearScan);

  await postSettings({ integrations: { lidarr: { insecure: true } } });
  assert.equal(scheduledScan(), null);

  await postSettings({ integrations: { lidarr: { enabled: false } } });
  assert.equal(scheduledScan()?.includeLidarr, false);
  assert.notEqual(releaseTask(), null);
  clearScan();

  await postSettings({ integrations: { lidarr: { enabled: true } } });
  assert.equal(scheduledScan()?.includeLidarr, true);
});

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

test("clears saved Lidarr roots when the connection identity changes", async (t) => {
  const { postSettings } = captureSettingsRoutes();
  dbOps.updateSettings({
    integrations: {
      lidarr: {
        url: "http://old-lidarr:8686",
        apiKey: "old-key",
        rootFolderPath: "/old/music",
        rootFolderPaths: ["/old/music", "/old/other"],
      },
    },
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  const refresh = t.mock.method(lidarrClient, "getRootFolders", async () => {
    throw new Error("new Lidarr is unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { url: "http://new-lidarr:8686", apiKey: "new-key" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(refresh.mock.callCount(), 1);
  assert.deepEqual(dbOps.getSettings().integrations.lidarr.rootFolderPaths, []);
  assert.equal(dbOps.getSettings().integrations.lidarr.rootFolderPath, null);
});

test("preserves saved Lidarr roots when discovery fails for the same connection", async (t) => {
  const { postSettings } = captureSettingsRoutes();
  dbOps.updateSettings({
    integrations: {
      lidarr: {
        url: "http://lidarr:8686",
        apiKey: "key",
        rootFolderPath: "/old/music",
        rootFolderPaths: ["/old/music"],
      },
    },
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getRootFolders", async () => {
    throw new Error("Lidarr is temporarily unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { rootFolderPath: "/new/default" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(dbOps.getSettings().integrations.lidarr.rootFolderPaths, ["/old/music"]);
  assert.equal(dbOps.getSettings().integrations.lidarr.rootFolderPath, "/new/default");
});

test("preserves saved Lidarr roots for equivalent normalized connection values", async (t) => {
  const { postSettings } = captureSettingsRoutes();
  dbOps.updateSettings({
    integrations: {
      lidarr: {
        url: "http://lidarr:8686/",
        apiKey: " key ",
        rootFolderPath: "/old/music",
        rootFolderPaths: ["/old/music"],
      },
    },
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getRootFolders", async () => {
    throw new Error("Lidarr is temporarily unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { url: "http://lidarr:8686", apiKey: "key" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(dbOps.getSettings().integrations.lidarr.rootFolderPaths, ["/old/music"]);
  assert.equal(dbOps.getSettings().integrations.lidarr.rootFolderPath, "/old/music");
});

test("queues a news refresh only when news settings change", async () => {
  const { findActiveHonkerJob, getMaintenanceTaskQueue } = await import(
    "../../backend/services/honkerDb.js"
  );
  const queuedNewsRefresh = () =>
    findActiveHonkerJob("system-task-maintenance", (payload) => payload?.kind === "news-refresh");
  const clearNewsRefresh = () => {
    for (let job = queuedNewsRefresh(); job; job = queuedNewsRefresh()) {
      getMaintenanceTaskQueue().cancel(job.id);
    }
  };
  const { getSettings, postSettings } = captureSettingsRoutes();
  const news = (await getSettings()).body.integrations.news;
  clearNewsRefresh();

  await postSettings({ integrations: { news } });
  assert.equal(queuedNewsRefresh(), null);

  await postSettings({ integrations: { news: { ...news, groups: { ...news.groups, jazz: false } } } });
  assert.ok(queuedNewsRefresh());
  clearNewsRefresh();
});
