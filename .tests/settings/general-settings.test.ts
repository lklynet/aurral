import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { join } from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { api },
  { playlistManager },
  { lidarrClient },
  libraryScans,
  honker,
] = await setupIsolatedBackend(
  "general-settings",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/libraryScanWorker.ts"),
  () => import("../../backend/services/honkerDb.ts"),
);

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

function pendingPlaylistSyncs() {
  return honker
    .listHonkerJobs("playback")
    .filter(({ payload }) => payload?.kind === "playback-playlist-sync")
    .map(({ payload }) => payload);
}

function clearPendingPlaylistSyncs() {
  for (const { id, payload } of honker.listHonkerJobs("playback")) {
    if (payload?.kind === "playback-playlist-sync") honker.getPlaybackTaskQueue().cancel(id);
  }
}

test("saving playback settings queues a playlist sync without waiting for the media server", async (t: import("vite-plus/test").TestContext) => {
  clearPendingPlaylistSyncs();
  t.onTestFinished(clearPendingPlaylistSyncs);
  const { JellyfinClient } = await import("../../backend/services/jellyfin.ts");
  const jellyfinRequests = vi
    .spyOn(JellyfinClient.prototype, "request")
    .mockImplementation(() => new Promise(() => {}));
  const scan = vi.spyOn(playlistManager, "scheduleScanLibrary").mockReturnValue(0);
  const { postSettings } = captureSettingsRoutes();

  const response = await postSettings({
    integrations: { jellyfin: { url: "http://jellyfin.local", apiKey: "key", userId: "user" } },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.body != null);
  assert.ok(response.body.integrations.jellyfin != null);
  assert.equal(response.body.integrations.jellyfin.url, "http://jellyfin.local");
  assert.equal(
    requireFixture(dbOps.getSettings()!.integrations.jellyfin).url,
    "http://jellyfin.local",
  );
  assert.equal(jellyfinRequests.mock.calls.length, 0);
  assert.deepEqual(pendingPlaylistSyncs(), [
    { kind: "playback-playlist-sync", entityIds: null, attempt: 0 },
  ]);
  assert.deepEqual(
    scan.mock.calls.map((call) => call),
    [[true]],
  );
});

test("saving unrelated settings with unchanged playback configuration skips initialization and scans", async () => {
  clearPendingPlaylistSyncs();
  const scan = vi.spyOn(playlistManager, "scheduleScanLibrary").mockReturnValue(0);
  dbOps.updateSettings({
    integrations: {
      jellyfin: { url: "http://jellyfin.local", apiKey: "key", userId: "user" },
      navidrome: { url: "http://navidrome.local", username: "user", password: "password" },
    },
  });
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
  assert.equal(requireFixture(dbOps.getSettings()!.integrations.deemix).url, "http://deemix.local");

  const partial = await postSettings({ integrations: { jellyfin: { userId: "user" } } });
  assert.equal(partial.statusCode, 200);
  const unrelated = await postSettings({ dateTimeFormat: "year-first" });
  assert.equal(unrelated.statusCode, 200);
  assert.deepEqual(pendingPlaylistSyncs(), []);
  assert.equal(scan.mock.calls.length, 0);
});

test("NZBGet leftover deletion defaults on and keeps an opt-out across partial saves", async () => {
  const { postSettings } = captureSettingsRoutes();
  const enabled = await postSettings({
    integrations: { nzbget: { enabled: true, url: "http://nzbget.local", priority: 5 } },
  });
  assert.equal(enabled.statusCode, 200);
  assert.ok(enabled.body != null);
  assert.ok(enabled.body.integrations.nzbget != null);
  assert.equal(enabled.body.integrations.nzbget.deleteLeftovers, true);
  assert.ok(enabled.body != null);
  assert.ok(enabled.body.integrations.nzbget != null);
  assert.equal(enabled.body.integrations.nzbget.priority, 5);
  await postSettings({ integrations: { nzbget: { deleteLeftovers: false } } });
  await postSettings({ integrations: { nzbget: { nzbPriority: 10 } } });
  assert.equal(requireFixture(dbOps.getSettings()!.integrations.nzbget).deleteLeftovers, false);
});

test("SABnzbd leftover deletion defaults on and keeps an opt-out across partial saves", async () => {
  const { postSettings } = captureSettingsRoutes();
  const enabled = await postSettings({
    integrations: {
      sabnzbd: {
        enabled: true,
        url: "http://sabnzbd.local",
        apiKey: "test-key",
        priority: 5,
      },
    },
  });
  assert.equal(enabled.statusCode, 200);
  assert.ok(enabled.body != null);
  assert.ok(enabled.body.integrations.sabnzbd != null);
  assert.equal(enabled.body.integrations.sabnzbd.deleteLeftovers, true);
  assert.ok(enabled.body != null);
  assert.ok(enabled.body.integrations.sabnzbd != null);
  assert.equal(enabled.body.integrations.sabnzbd.priority, 5);
  await postSettings({ integrations: { sabnzbd: { deleteLeftovers: false } } });
  await postSettings({ integrations: { sabnzbd: { addPaused: true } } });
  assert.equal(requireFixture(dbOps.getSettings()!.integrations.sabnzbd).deleteLeftovers, false);
});

test("Tidarr and an indexer's known download client survive a save", async () => {
  const { postSettings } = captureSettingsRoutes();
  const saved = await postSettings({
    integrations: {
      tidarr: { enabled: true, url: "http://tidarr.local:8484/", apiKey: " tidarr-key " },
      prowlarr: {
        indexers: {
          "1": { enabled: true, priority: 5, downloadClient: "tidarr" },
          "2": { enabled: true, priority: 5, downloadClient: "qbittorrent" },
        },
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  const { tidarr, prowlarr } = dbOps.getSettings()!.integrations;
  assert.deepEqual(tidarr, {
    enabled: true,
    url: "http://tidarr.local:8484",
    apiKey: "tidarr-key",
    priority: 20,
  });
  assert.equal(prowlarr?.indexers?.["1"]?.downloadClient, "tidarr");
  assert.equal(prowlarr?.indexers?.["2"]?.downloadClient, undefined);
});

test("the maximum review wait is validated and kept across partial saves", async () => {
  const { postSettings } = captureSettingsRoutes();
  for (const invalid of [-1, 1.5, 721, "24"]) {
    assert.equal(
      (await postSettings({ reviewTimeoutHours: invalid })).statusCode,
      400,
      String(invalid),
    );
  }
  assert.equal((await postSettings({ reviewTimeoutHours: 48 })).statusCode, 200);
  await postSettings({ integrations: { nzbget: { nzbPriority: 10 } } });
  assert.equal(dbOps.getSettings().reviewTimeoutHours, 48);
});

for (const key of ["jellyfin", "navidrome"] as const) {
  test(`refreshes playback when ${key} settings change or are cleared`, async (t: import("vite-plus/test").TestContext) => {
    clearPendingPlaylistSyncs();
    t.onTestFinished(clearPendingPlaylistSyncs);
    const scan = vi.spyOn(playlistManager, "scheduleScanLibrary").mockReturnValue(0);
    const { postSettings } = captureSettingsRoutes();
    for (const url of [`http://${key}.local`, ""]) {
      const response = await postSettings({ integrations: { [key]: { url } } });
      assert.equal(response.statusCode, 200);
      assert.equal(requireFixture(dbOps.getSettings().integrations[key]).url, url);
    }
    assert.deepEqual(pendingPlaylistSyncs(), [
      { kind: "playback-playlist-sync", entityIds: null, attempt: 0 },
    ]);
    assert.equal(scan.mock.calls.length, 2);
  });
}

test("a failure to queue the Library scan or the playlist sync does not block the other or the save", async (t: import("vite-plus/test").TestContext) => {
  clearPendingPlaylistSyncs();
  t.onTestFinished(clearPendingPlaylistSyncs);
  const { logger } = await import("../../backend/services/logger.ts");
  const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const scan = vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => {
    throw new Error("Scan queue unavailable");
  });
  const { postSettings } = captureSettingsRoutes();
  const scanFailure = await postSettings({
    integrations: { jellyfin: { url: "http://jellyfin.local" } },
  });
  assert.equal(scanFailure.statusCode, 200);
  assert.deepEqual(
    warnings.mock.calls.map((call) => call),
    [["settings", "Failed to queue Library scan:", { message: "Scan queue unavailable" }]],
  );
  assert.deepEqual(pendingPlaylistSyncs(), [
    { kind: "playback-playlist-sync", entityIds: null, attempt: 0 },
  ]);

  scan.mockImplementation(() => 0);
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => {
    throw new Error("Sync queue unavailable");
  });
  warnings.mockClear();
  const syncFailure = await postSettings({
    integrations: { jellyfin: { url: "http://jellyfin.other" } },
  });
  assert.equal(syncFailure.statusCode, 200);
  assert.deepEqual(
    warnings.mock.calls.map((call) => call),
    [
      [
        "settings",
        "Failed to queue playback playlist sync:",
        { message: "Sync queue unavailable" },
      ],
    ],
  );
  assert.deepEqual(
    scan.mock.calls.map((call) => call),
    [[true], [true]],
  );
});

type SettingsBody = NonNullable<ReturnType<typeof dbOps.getSettings>> & {
  rootWarnings: { type: string }[];
};

function captureSettingsRoutes() {
  const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);
  const send = async (init?: RequestInit) => {
    const response = await app.request("/settings", init);
    const body: SettingsBody = await response.json();
    return { statusCode: response.status, body };
  };
  const postSettings = (body: unknown) =>
    send({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const getSettings = () => send();
  return { postSettings, getSettings };
}

test("the missing-track search setting keeps fields a save leaves out and never stores an unusable interval", async () => {
  const { getSettings, postSettings } = captureSettingsRoutes();

  await postSettings({ missingTrackSearch: { enabled: true, intervalDays: 3 } });
  const disabled = await postSettings({ missingTrackSearch: { enabled: false } });
  assert.equal(disabled.statusCode, 200);
  assert.deepEqual((await getSettings()).body.missingTrackSearch, {
    enabled: false,
    intervalDays: 3,
  });

  for (const intervalDays of [0, -3, "soon", null]) {
    await postSettings({ missingTrackSearch: { intervalDays } });
    const saved = dbOps.getSettings().missingTrackSearch.intervalDays;
    assert.ok(
      Number.isInteger(saved) && saved >= 1,
      `${String(intervalDays)} was stored as ${saved}`,
    );
  }
});

test("turning Lidarr off or on starts a Library scan, and other saves do not", async (t: import("vite-plus/test").TestContext) => {
  const { postSettings } = captureSettingsRoutes();
  vi.spyOn(lidarrClient, "getRootFolders").mockImplementation(async () => []);
  dbOps.updateSettings({
    integrations: { lidarr: { url: "http://127.0.0.1:18686", apiKey: "key", enabled: true } },
  });
  const scheduledScan = () => {
    const jobId = libraryScans.getScheduledLibraryScanJobId();
    const job = jobId == null ? null : honker.getLibraryScanQueue().getJob(jobId);
    return job ? JSON.parse(job.payload) : null;
  };
  const releaseTask = () =>
    honker.findActiveHonkerJob(
      "system-task",
      (payload) => payload?.kind === "lidarr-files-release",
      { payloadKind: "lidarr-files-release" },
    );
  const clearScan = () => libraryScans.clearScheduledLibraryScan();
  clearScan();
  t.onTestFinished(clearScan);

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
  assert.ok(response.body != null);
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
  assert.ok(saved.body != null);
  assert.deepEqual([...saved.body.rootWarnings], []);

  const current = await getSettings();
  assert.ok(current.body != null);
  assert.deepEqual([...current.body.rootWarnings], []);
});

test("clears saved Lidarr roots when the connection identity changes", async () => {
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
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  const refresh = vi.spyOn(lidarrClient, "getRootFolders").mockImplementation(async () => {
    throw new Error("new Lidarr is unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { url: "http://new-lidarr:8686", apiKey: "new-key" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(refresh.mock.calls.length, 1);
  assert.deepEqual(requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPaths, []);
  assert.equal(requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPath, null);
});

test("preserves saved Lidarr roots when discovery fails for the same connection", async () => {
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
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getRootFolders").mockImplementation(async () => {
    throw new Error("Lidarr is temporarily unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { rootFolderPath: "/new/default" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPaths, [
    "/old/music",
  ]);
  assert.equal(
    requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPath,
    "/new/default",
  );
});

test("preserves saved Lidarr roots for equivalent normalized connection values", async () => {
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
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getRootFolders").mockImplementation(async () => {
    throw new Error("Lidarr is temporarily unavailable");
  });

  const response = await postSettings({
    integrations: {
      lidarr: { url: "http://lidarr:8686", apiKey: "key" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPaths, [
    "/old/music",
  ]);
  assert.equal(
    requireFixture(dbOps.getSettings()!.integrations.lidarr).rootFolderPath,
    "/old/music",
  );
});

test("an integration setting Aurral can't read is ignored without losing the rest", () => {
  dbOps.setJSONSetting("integrations", {
    slskd: { url: "http://slskd.test", priority: { high: true } },
    webhooks: [{ url: "http://hook.test" }, { body: "no url" }],
    lidarr: { url: "http://lidarr.test" },
  });
  dbOps.invalidateSettingsCache();

  const { integrations } = dbOps.getSettings();
  assert.equal(integrations.slskd?.url, "http://slskd.test");
  assert.equal(integrations.slskd?.priority, undefined);
  assert.deepEqual(
    integrations.webhooks?.map(({ url }) => url),
    ["http://hook.test"],
  );
  assert.equal(integrations.lidarr?.url, "http://lidarr.test");
});

test("saving an integration setting Aurral can't read is rejected", async () => {
  const { postSettings } = captureSettingsRoutes();

  const rejected = await postSettings({
    integrations: { ticketmaster: { apiKey: "key", searchRadiusMiles: { miles: 50 } } },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(JSON.stringify(rejected.body), /ticketmaster\.searchRadiusMiles/);
  assert.equal(dbOps.getSettings().integrations.ticketmaster, undefined);

  const endless = await postSettings({
    integrations: { ticketmaster: { searchRadiusMiles: "1e309" } },
  });
  assert.equal(endless.statusCode, 400);
  assert.equal(dbOps.getSettings().integrations.ticketmaster, undefined);

  const hook = await postSettings({
    integrations: { webhooks: [{ url: "http://hook.test", body: 42 }] },
  });
  assert.equal(hook.statusCode, 400);
  assert.match(JSON.stringify(hook.body), /webhooks\.0\.body/);
  assert.equal(dbOps.getSettings().integrations.webhooks, undefined);

  const cleared = await postSettings({ integrations: { ticketmaster: { searchRadiusMiles: "" } } });
  assert.equal(cleared.statusCode, 200);
});

test("queues a news refresh only when news settings change", async () => {
  const { findActiveHonkerJob, getMaintenanceTaskQueue } =
    await import("../../backend/services/honkerDb.ts");
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

  assert.ok(news != null);
  await postSettings({
    integrations: { news: { ...news, groups: { ...news.groups, jazz: false } } },
  });
  assert.ok(queuedNewsRefresh());
  clearNewsRefresh();
});

test("the Downloads Folder cannot move into or around a read-only folder", async (t: import("vite-plus/test").TestContext) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(join(tmpdir(), "aurral-settings-read-only-"));
  t.onTestFinished(async () => {
    dbOps.setJSONSetting("readOnlyFolders", []);
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(join(folder, "Inside"));
  dbOps.setJSONSetting("readOnlyFolders", [folder]);
  const { postSettings } = captureSettingsRoutes();
  const before = dbOps.getSettings().downloadFolderPath;

  for (const rejected of [folder, join(folder, "Inside"), tmpdir()]) {
    const response = await postSettings({ downloadFolderPath: rejected });
    assert.equal(response.statusCode, 400, rejected);
  }
  dbOps.invalidateSettingsCache();
  assert.equal(dbOps.getSettings().downloadFolderPath, before);
});

test("saving Plex settings keeps the saved token and client unless the request changes them", async () => {
  const { postSettings } = captureSettingsRoutes();
  dbOps.updateSettings({
    integrations: { plex: { token: "saved-token", clientId: "saved-client", url: "http://old" } },
  });

  await postSettings({ integrations: { plex: { url: "http://new" } } });
  assert.deepEqual(dbOps.getSettings().integrations.plex, {
    token: "saved-token",
    clientId: "saved-client",
    url: "http://new",
  });

  await postSettings({ integrations: { plex: { token: "", url: "" } } });
  assert.deepEqual(dbOps.getSettings().integrations.plex, {
    token: "",
    clientId: "saved-client",
    url: "",
  });
});
