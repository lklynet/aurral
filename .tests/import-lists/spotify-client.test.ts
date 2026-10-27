import { requireFixture } from "../playlists/fixtures.ts";
import { asAppError } from "../../lib/errors.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, , { spotifyConnectionStore }, { spotifyClient }] =
  await setupIsolatedBackend(
    "spotify-client",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/spotify/spotifyConnectionStore.ts"),
    () => import("../../backend/services/spotify/spotifyClient.ts"),
  );

const originalFetch = globalThis.fetch;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const rejectedAccessToken = () =>
  jsonResponse(401, { error: { status: 401, message: "Invalid access token" } });
const endedRefreshToken = () =>
  jsonResponse(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
const isAuthRequired = (error: unknown) =>
  asAppError(error)?.code === "SPOTIFY_AUTH_REQUIRED" && asAppError(error)?.statusCode === 401;

beforeEach(() => {
  resetDatabase(db);
  spotifyClient.clearPlaylistTrackCache();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await cleanupIsolatedState(isolatedState);
});

test("Spotify rejecting a refreshed token asks for a reconnect until a request succeeds", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "rejected-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const responses = [
    rejectedAccessToken(),
    jsonResponse(200, { access_token: "refreshed-access-token", expires_in: 3600 }),
    rejectedAccessToken(),
  ];
  globalThis.fetch = async () => responses.shift()!;

  await assert.rejects(spotifyClient.listPlaylists(7), isAuthRequired);
  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, false);
  assert.equal(spotifyConnectionStore.getConnection(7)!.accessToken, "refreshed-access-token");

  globalThis.fetch = async () => jsonResponse(200, { items: [], next: null });
  await spotifyClient.listPlaylists(7);
  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, true);
});

test("Spotify ending the sign-in disconnects Spotify", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "expired-access-token",
    refreshToken: "ended-refresh-token",
    expiresAt: Date.now() - 1000,
  });
  globalThis.fetch = async () => endedRefreshToken();

  await assert.rejects(spotifyClient.listPlaylists(7), isAuthRequired);
  assert.equal(spotifyConnectionStore.getConnection(7), null);
});

test("pending track requests cannot repopulate cache after invalidation", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "expired-access-token",
    refreshToken: "expired-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  let resolveTracks!: (value: Response) => void;
  let resolveTracksStarted!: () => void;
  const tracksStarted = new Promise<void>((resolve) => {
    resolveTracksStarted = resolve;
  });
  const pendingTracks = new Promise<Response>((resolve) => {
    resolveTracks = resolve;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveTracksStarted();
      return pendingTracks;
    }
    return requestCount === 2 ? rejectedAccessToken() : endedRefreshToken();
  };

  const pendingRequest = spotifyClient.listPlaylistTracks(7, "playlist");
  await tracksStarted;
  await assert.rejects(
    spotifyClient.listPlaylists(7),
    (error) =>
      asAppError(error)?.code === "SPOTIFY_AUTH_REQUIRED" && asAppError(error)?.statusCode === 401,
  );
  resolveTracks(
    new Response(JSON.stringify({ items: [], next: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    pendingRequest,
    (error) =>
      asAppError(error)?.code === "SPOTIFY_AUTH_REQUIRED" && asAppError(error)?.statusCode === 401,
  );
  await assert.rejects(
    spotifyClient.listPlaylistTracks(7, "playlist"),
    (error) =>
      asAppError(error)?.code === "SPOTIFY_AUTH_REQUIRED" && asAppError(error)?.statusCode === 401,
  );
  assert.equal(requestCount, 3);
});

test("playlist fetch follows every current Spotify page without a client-side size cap", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get("offset") || 0);
    const total = 1001;
    const pageSize = Math.min(50, total - offset);
    return new Response(
      JSON.stringify({
        items: Array.from({ length: pageSize }, (_, index) => ({
          item: { name: `Song ${offset + index}` },
        })),
        total,
        offset,
        next:
          offset + pageSize < total
            ? `https://api.spotify.com/v1/playlists/playlist/items?offset=${offset + pageSize}&limit=50`
            : null,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const items = await spotifyClient.listPlaylistTracks(7, "playlist", { forceRefresh: true });
  assert.equal(items.length, 1001);
  assert.equal(requireFixture(items.at(-1)!.item).name, "Song 1000");
  assert.equal(urls.length, 21);
  assert.equal(new URL(urls[0]).pathname, "/v1/playlists/playlist/items");
  assert.equal(new URL(urls[0]).searchParams.get("limit"), "50");
  assert.match(new URL(urls[0]).searchParams.get("fields")!, /items\(item\(/);
  assert.equal(new URL(urls[0]).searchParams.get("additional_types"), "episode");
  assert.match(new URL(urls[0]).searchParams.get("fields")!, /\btotal\b/);
  assert.match(new URL(urls[0]).searchParams.get("fields")!, /\boffset\b/);
});

test("playlist fetch rejects a response that stops before Spotify's declared total", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        items: [{ item: { name: "Only Song" } }],
        total: 1001,
        offset: 0,
        next: null,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  await assert.rejects(
    spotifyClient.listPlaylistTracks(7, "playlist", { forceRefresh: true }),
    (error: Error) =>
      asAppError(error)?.code === "SPOTIFY_INCOMPLETE_PLAYLIST" &&
      asAppError(error)?.statusCode === 502 &&
      /1 of 1001/.test(error.message),
  );
});

test("playlist listing reads the current Spotify items total", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        items: [{ id: "playlist", name: "Large Playlist", items: { total: 1001 } }],
        next: null,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  const result = await spotifyClient.listPlaylists(7);
  assert.deepEqual(result.playlists, [
    { id: "playlist", name: "Large Playlist", trackCount: 1001 },
  ]);
});

test("stale refresh failures cannot clear a newly connected account", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  let resolveRefresh!: (value: Response) => void;
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const pendingRefresh = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(
        JSON.stringify({
          error: { status: 401, message: "Missing/invalid/expired access token" },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
    resolveRefreshStarted();
    return pendingRefresh;
  };

  const request = spotifyClient.listPlaylists(7);
  await refreshStarted;
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  resolveRefresh(endedRefreshToken());

  await assert.rejects(request, isAuthRequired);
  assert.equal(spotifyConnectionStore.getConnection(7)!.refreshToken, "new-refresh-token");
  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, true);
  assert.equal(requestCount, 2);
});

test("Spotify playlist artwork uses the largest available source image", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  });
  globalThis.fetch = async () =>
    jsonResponse(200, {
      images: [
        { url: "https://images.example.test/small.jpg", width: 100 },
        { url: "https://images.example.test/original.jpg", width: 1000 },
      ],
    });
  assert.equal(
    await spotifyClient.getPlaylistArtworkUrl(7, "playlist"),
    "https://images.example.test/original.jpg",
  );
  globalThis.fetch = async () => jsonResponse(200, { images: [] });
  assert.equal(await spotifyClient.getPlaylistArtworkUrl(7, "playlist"), null);
});
