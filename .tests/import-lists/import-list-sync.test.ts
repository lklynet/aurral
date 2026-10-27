import { requireFixture } from "../playlists/fixtures.ts";
import { test, beforeEach, afterAll, afterEach, vi, type MockInstance } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

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
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/spotify/spotifyConnectionStore.ts"),
  () => import("../../backend/services/spotify/spotifyClient.ts"),
  () => import("../../backend/services/logger.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/importLists/importListSync.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
const originalStart = downloadWorker.start;
const lastSyncAt = Date.now() - 3 * DAY_MS;
const oldTrack = { artistName: "Old Artist", trackName: "Old Song", albumName: "Old Album" };

const databaseChanges = () =>
  requireFixture(db.prepare<[], { changes: number }>("SELECT total_changes() AS changes").get())
    .changes;
const runScheduledSync = () => processSystemTask({ kind: "import-list-sync" });
const importLogs = (mock: MockInstance<typeof logger.warn>): { playlistId?: string }[] =>
  mock.mock.calls.filter((call) => call[0] === "playlist-import").map((call) => call[2] ?? {});

const createSyncedPlaylist = (
  name: string,
  ownerUserId: number,
  provider: string,
  externalId: string,
) =>
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

const connectSpotify = (userId: number, accessToken: string) =>
  spotifyConnectionStore.saveConnection(userId, {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: Date.now() + DAY_MS,
  });

const jsonResponse = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const playlistPage = (externalId: string | null) => ({
  items: [
    {
      item: {
        type: "track",
        name: `Song from ${externalId}`,
        artists: [{ name: "New Artist" }],
        album: { name: "New Album" },
      },
    },
  ],
  next: null,
  total: 1,
  offset: 0,
});

const SPOTIFY_HOSTS = new Set(["api.spotify.com", "spotify.lidarr.audio"]);

const stubSpotify = (
  respond: (request: { url: string; token: string }) => Response | Promise<Response>,
) => {
  const requests: { url: string; token: string }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!SPOTIFY_HOSTS.has(new URL(String(url)).hostname)) return originalFetch(url, init);
    const request = {
      url: String(url),
      token: (new Headers(init.headers).get("Authorization") ?? "").replace(/^Bearer /, ""),
    };
    requests.push(request);
    return respond(request);
  };
  return requests;
};

const playlistItemsId = (url: string) => url.match(/\/playlists\/([^/]+)\/items/)?.[1] || null;

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
  });
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  spotifyClient.clearPlaylistTrackCache();
  downloadWorker.start = async () => false;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  downloadWorker.start = originalStart;
  downloadWorker.stop();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("disconnected providers pause synced playlists without touching them until Spotify reconnects", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
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
  assert.deepEqual([...requests], []);
  assert.deepEqual(importLogs(error), []);
  assert.deepEqual(importLogs(warn), [
    { provider: "Spotify", ownerUserId: 7, playlistCount: 2 },
    { provider: "ListenBrainz", ownerUserId: 7, playlistCount: 1 },
  ]);
  for (const playlist of [...spotifyPlaylists, listenbrainzPlaylist]) {
    const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.ok(stored != null);
    assert.ok(stored.importSource != null);
    assert.equal(stored.importSource.lastSyncAt, lastSyncAt);
    assert.ok(stored.importSource != null);
    assert.equal(stored.importSource.lastSyncError, null);
    assert.deepEqual(
      stored.tracks.map((track) => track.trackName),
      ["Old Song"],
    );
  }

  await assert.rejects(
    syncStaticPlaylistImport({ playlistId: spotifyPlaylists[0].id, user: { id: 7 }, force: true }),
    (rejection: { statusCode?: number; message: string }) =>
      rejection.statusCode === 401 && /Spotify is not connected/.test(rejection.message),
  );

  connectSpotify(7, "reconnected-token");
  warn.mockClear();
  error.mockClear();
  await runScheduledSync();

  assert.deepEqual(
    requests
      .map(({ url }) => playlistItemsId(url))
      .filter(Boolean)
      .sort(),
    ["spotify-2024", "spotify-2025"],
  );
  assert.deepEqual(importLogs(error), []);
  assert.deepEqual(importLogs(warn), [
    { provider: "ListenBrainz", ownerUserId: 7, playlistCount: 1 },
  ]);
  for (const playlist of spotifyPlaylists) {
    const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.ok(stored != null);
    assert.ok(stored.importSource != null);
    assert.ok(stored.importSource.lastSyncAt != null);
    assert.ok(stored.importSource.lastSyncAt > lastSyncAt);
    assert.ok(stored.importSource != null);
    assert.equal(stored.importSource.lastSyncError, null);
    assert.ok(playlist.importSource != null);
    assert.deepEqual(
      stored.tracks.map((track) => track.trackName),
      [`Song from ${playlist.importSource.externalId}`],
    );
  }
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(listenbrainzPlaylist.id)!.importSource)
      .lastSyncAt,
    lastSyncAt,
  );
});

test("a Spotify rejection pauses that owner's remaining playlists until Spotify accepts them again", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
  connectSpotify(7, "revoked-token");
  connectSpotify(8, "working-token");
  let spotifyAcceptsEveryToken = false;
  const requests = stubSpotify(({ url, token }) => {
    if (token === "working-token" || spotifyAcceptsEveryToken) {
      return jsonResponse(playlistPage(playlistItemsId(url)));
    }
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
  assert.equal(requests.filter(({ token }) => token !== "working-token").length, 2);
  assert.deepEqual(
    importLogs(error).map((details) => details.playlistId),
    [revoked[0].id],
  );
  assert.deepEqual(importLogs(warn), [{ provider: "Spotify", ownerUserId: 7, playlistCount: 2 }]);
  for (const playlist of revoked.slice(1)) {
    assert.equal(
      requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)!.importSource).lastSyncError,
      null,
    );
  }
  const synced = flowPlaylistConfig.getStaticPlaylist(otherOwner.id);
  assert.ok(synced != null);
  assert.ok(synced.importSource != null);
  assert.ok(synced.importSource.lastSyncAt != null);
  assert.ok(synced.importSource.lastSyncAt > lastSyncAt);
  assert.deepEqual(
    synced.tracks.map((track) => track.trackName),
    ["Song from other-owner"],
  );

  spotifyAcceptsEveryToken = true;
  await runScheduledSync();

  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, true);
  for (const playlist of revoked) {
    assert.deepEqual(
      flowPlaylistConfig.getStaticPlaylist(playlist.id)!.tracks.map((track) => track.trackName),
      [`Song from ${requireFixture(playlist.importSource).externalId}`],
    );
  }
});

test("a sync that keeps failing the same way does not rewrite the playlist each run", async () => {
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  connectSpotify(7, "access-token");
  stubSpotify(() => new Response("Spotify is unavailable", { status: 503 }));
  const playlist = createSyncedPlaylist("Unavailable", 7, "spotify-playlist", "unavailable");

  await runScheduledSync();
  const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
  assert.ok(stored != null);
  assert.ok(stored.importSource != null);
  assert.equal(stored.importSource.lastSyncError, "Spotify is unavailable");
  assert.ok(stored.importSource != null);
  assert.equal(stored.importSource.lastSyncAt, lastSyncAt);
  const before = databaseChanges();

  await runScheduledSync();

  assert.equal(databaseChanges(), before);
  assert.equal(importLogs(error).length, 2);
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)!.importSource).lastSyncError,
    "Spotify is unavailable",
  );
});
