import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { spotifyConnectionStore },
  { spotifyClient },
  { logger },
  { downloadWorker },
  { downloadTracker },
  { syncStaticPlaylistImport },
  { processSystemTask },
] = await setupIsolatedBackend(
  "import-list-sync",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/spotify/spotifyConnectionStore.js",
  "backend/services/spotify/spotifyClient.js",
  "backend/services/logger.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/importLists/importListSync.js",
  "backend/services/systemTaskWorker.js",
);

const DAY_MS = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
const originalStart = downloadWorker.start;
const lastSyncAt = Date.now() - 3 * DAY_MS;
const oldTrack = { artistName: "Old Artist", trackName: "Old Song", albumName: "Old Album" };

const databaseChanges = () => db.prepare("SELECT total_changes() AS changes").get().changes;
const runScheduledSync = () => processSystemTask({ kind: "import-list-sync" });
const importLogs = (mock) =>
  mock.mock.calls
    .filter((call) => call.arguments[0] === "playlist-import")
    .map((call) => call.arguments[2]);

const createSyncedPlaylist = (name, ownerUserId, provider, externalId) =>
  flowPlaylistConfig.createStaticPlaylist({
    name,
    ownerUserId,
    tracks: [oldTrack],
    importSource: {
      provider,
      externalId,
      syncEnabled: true,
      syncIntervalHours: 24,
      lastSyncAt,
    },
  });

const connectSpotify = (userId, accessToken) =>
  spotifyConnectionStore.saveConnection(userId, {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: Date.now() + DAY_MS,
  });

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const playlistPage = (externalId) => ({
  items: [{
    item: {
      type: "track",
      name: `Song from ${externalId}`,
      artists: [{ name: "New Artist" }],
      album: { name: "New Album" },
    },
  }],
  next: null,
  total: 1,
  offset: 0,
});

const SPOTIFY_HOSTS = new Set(["api.spotify.com", "spotify.lidarr.audio"]);

const stubSpotify = (respond) => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!SPOTIFY_HOSTS.has(new URL(String(url)).hostname)) return originalFetch(url, init);
    const request = {
      url: String(url),
      token: String(init.headers?.Authorization || "").replace(/^Bearer /, ""),
    };
    requests.push(request);
    return respond(request);
  };
  return requests;
};

const playlistItemsId = (url) => url.match(/\/playlists\/([^/]+)\/items/)?.[1] || null;

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
    playlistArtwork: { style: "aurral" },
  });
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  spotifyClient.clearPlaylistTrackCache();
  downloadWorker.start = async () => false;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  downloadWorker.start = originalStart;
  downloadWorker.stop();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("disconnected providers pause synced playlists without touching them until Spotify reconnects", async (t) => {
  const warn = t.mock.method(logger, "warn", () => {});
  const error = t.mock.method(logger, "error", () => {});
  t.mock.method(logger, "info", () => {});
  const requests = stubSpotify(({ url }) => jsonResponse(playlistPage(playlistItemsId(url))));
  const spotifyPlaylists = [
    createSyncedPlaylist("2024", 7, "spotify-playlist", "spotify-2024"),
    createSyncedPlaylist("2025", 7, "spotify-playlist", "spotify-2025"),
  ];
  const listenbrainzPlaylist = createSyncedPlaylist(
    "Weekly Jams",
    7,
    "listenbrainz-createdfor",
    "weekly-jams",
  );
  const before = databaseChanges();

  await runScheduledSync();

  assert.equal(databaseChanges(), before);
  assert.deepEqual(requests, []);
  assert.deepEqual(importLogs(error), []);
  assert.deepEqual(importLogs(warn), [
    { provider: "Spotify", ownerUserId: 7, playlistCount: 2 },
    { provider: "ListenBrainz", ownerUserId: 7, playlistCount: 1 },
  ]);
  for (const playlist of [...spotifyPlaylists, listenbrainzPlaylist]) {
    const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.equal(stored.importSource.lastSyncAt, lastSyncAt);
    assert.equal(stored.importSource.lastSyncError, null);
    assert.deepEqual(stored.tracks.map((track) => track.trackName), ["Old Song"]);
  }

  await assert.rejects(
    syncStaticPlaylistImport({ playlistId: spotifyPlaylists[0].id, user: { id: 7 }, force: true }),
    (rejection) => rejection.statusCode === 401 && /Spotify is not connected/.test(rejection.message),
  );

  connectSpotify(7, "reconnected-token");
  warn.mock.resetCalls();
  error.mock.resetCalls();
  await runScheduledSync();

  assert.deepEqual(
    requests.map(({ url }) => playlistItemsId(url)).sort(),
    ["spotify-2024", "spotify-2025"],
  );
  assert.deepEqual(importLogs(error), []);
  assert.deepEqual(importLogs(warn), [
    { provider: "ListenBrainz", ownerUserId: 7, playlistCount: 1 },
  ]);
  for (const playlist of spotifyPlaylists) {
    const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.ok(stored.importSource.lastSyncAt > lastSyncAt);
    assert.equal(stored.importSource.lastSyncError, null);
    assert.deepEqual(
      stored.tracks.map((track) => track.trackName),
      [`Song from ${playlist.importSource.externalId}`],
    );
  }
  assert.equal(
    flowPlaylistConfig.getStaticPlaylist(listenbrainzPlaylist.id).importSource.lastSyncAt,
    lastSyncAt,
  );
});

test("a Spotify connection revoked mid-run pauses that owner's remaining playlists only", async (t) => {
  const warn = t.mock.method(logger, "warn", () => {});
  const error = t.mock.method(logger, "error", () => {});
  t.mock.method(logger, "info", () => {});
  connectSpotify(7, "revoked-token");
  connectSpotify(8, "working-token");
  const requests = stubSpotify(({ url, token }) => {
    if (token === "working-token") return jsonResponse(playlistPage(playlistItemsId(url)));
    return jsonResponse({ error: { status: 401, message: "Invalid access token" } }, 401);
  });
  const revoked = [
    createSyncedPlaylist("Revoked A", 7, "spotify-playlist", "revoked-a"),
    createSyncedPlaylist("Revoked B", 7, "spotify-playlist", "revoked-b"),
    createSyncedPlaylist("Revoked C", 7, "spotify-playlist", "revoked-c"),
  ];
  const otherOwner = createSyncedPlaylist("Other Owner", 8, "spotify-playlist", "other-owner");

  await runScheduledSync();

  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, false);
  assert.equal(
    requests.filter(({ token }) => token !== "working-token").length,
    2,
  );
  assert.deepEqual(importLogs(error).map((details) => details.playlistId), [revoked[0].id]);
  assert.deepEqual(importLogs(warn), [
    { provider: "Spotify", ownerUserId: 7, playlistCount: 2 },
  ]);
  for (const playlist of revoked.slice(1)) {
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlist.id).importSource.lastSyncError, null);
  }
  const synced = flowPlaylistConfig.getStaticPlaylist(otherOwner.id);
  assert.ok(synced.importSource.lastSyncAt > lastSyncAt);
  assert.deepEqual(synced.tracks.map((track) => track.trackName), ["Song from other-owner"]);
});

test("a sync that keeps failing the same way does not rewrite the playlist each run", async (t) => {
  const error = t.mock.method(logger, "error", () => {});
  t.mock.method(logger, "warn", () => {});
  connectSpotify(7, "access-token");
  stubSpotify(() => new Response("Spotify is unavailable", { status: 503 }));
  const playlist = createSyncedPlaylist("Unavailable", 7, "spotify-playlist", "unavailable");

  await runScheduledSync();
  const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
  assert.equal(stored.importSource.lastSyncError, "Spotify is unavailable");
  assert.equal(stored.importSource.lastSyncAt, lastSyncAt);
  const before = databaseChanges();

  await runScheduledSync();

  assert.equal(databaseChanges(), before);
  assert.equal(importLogs(error).length, 2);
  assert.equal(
    flowPlaylistConfig.getStaticPlaylist(playlist.id).importSource.lastSyncError,
    "Spotify is unavailable",
  );
});
