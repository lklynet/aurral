import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, , { spotifyConnectionStore }, { spotifyClient }] =
  await setupIsolatedBackend(
    "spotify-client",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/spotify/spotifyConnectionStore.js",
    "backend/services/spotify/spotifyClient.js",
  );

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  resetDatabase(db);
  spotifyClient.clearPlaylistTrackCache();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await cleanupIsolatedState(isolatedState);
});

test("invalid Spotify credentials clear the connection after refresh cannot recover", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "expired-access-token",
    refreshToken: "expired-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 2) {
      return new Response(JSON.stringify({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      error: { status: 401, message: "Missing/invalid/expired access token" },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    spotifyClient.listPlaylists(7),
    (error) => error?.code === "SPOTIFY_AUTH_REQUIRED" && error?.statusCode === 401,
  );
  assert.equal(requestCount, 3);
  assert.equal(spotifyConnectionStore.getPublicStatus(7).connected, false);
});

test("pending track requests cannot repopulate cache after invalidation", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "expired-access-token",
    refreshToken: "expired-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  let resolveTracks;
  let resolveTracksStarted;
  const tracksStarted = new Promise((resolve) => {
    resolveTracksStarted = resolve;
  });
  const pendingTracks = new Promise((resolve) => {
    resolveTracks = resolve;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveTracksStarted();
      return pendingTracks;
    }
    return new Response(JSON.stringify({
      error: { status: 401, message: "Missing/invalid/expired access token" },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  const pendingRequest = spotifyClient.listPlaylistTracks(7, "playlist");
  await tracksStarted;
  await assert.rejects(
    spotifyClient.listPlaylists(7),
    (error) => error?.code === "SPOTIFY_AUTH_REQUIRED" && error?.statusCode === 401,
  );
  resolveTracks(new Response(JSON.stringify({ items: [], next: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    pendingRequest,
    (error) => error?.code === "SPOTIFY_AUTH_REQUIRED" && error?.statusCode === 401,
  );
  await assert.rejects(
    spotifyClient.listPlaylistTracks(7, "playlist"),
    (error) => error?.code === "SPOTIFY_AUTH_REQUIRED" && error?.statusCode === 401,
  );
  assert.equal(requestCount, 3);
});

test("playlist fetch follows every current Spotify page without a client-side size cap", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const offset = Number(new URL(url).searchParams.get("offset") || 0);
    const total = 1001;
    const pageSize = Math.min(50, total - offset);
    return new Response(JSON.stringify({
      items: Array.from({ length: pageSize }, (_, index) => ({
        item: { name: `Song ${offset + index}` },
      })),
      total,
      offset,
      next: offset + pageSize < total
        ? `https://api.spotify.com/v1/playlists/playlist/items?offset=${offset + pageSize}&limit=50`
        : null,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const items = await spotifyClient.listPlaylistTracks(7, "playlist", { forceRefresh: true });
  assert.equal(items.length, 1001);
  assert.equal(items.at(-1).item.name, "Song 1000");
  assert.equal(urls.length, 21);
  assert.equal(new URL(urls[0]).pathname, "/v1/playlists/playlist/items");
  assert.equal(new URL(urls[0]).searchParams.get("limit"), "50");
  assert.match(new URL(urls[0]).searchParams.get("fields"), /items\(item\(/);
  assert.equal(new URL(urls[0]).searchParams.get("additional_types"), "episode");
  assert.match(new URL(urls[0]).searchParams.get("fields"), /\btotal\b/);
  assert.match(new URL(urls[0]).searchParams.get("fields"), /\boffset\b/);
});

test("playlist fetch rejects a response that stops before Spotify's declared total", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{ item: { name: "Only Song" } }],
    total: 1001,
    offset: 0,
    next: null,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    spotifyClient.listPlaylistTracks(7, "playlist", { forceRefresh: true }),
    (error) => error?.code === "SPOTIFY_INCOMPLETE_PLAYLIST" &&
      error?.statusCode === 502 &&
      /1 of 1001/.test(error.message),
  );
});

test("playlist listing reads the current Spotify items total", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{ id: "playlist", name: "Large Playlist", items: { total: 1001 } }],
    next: null,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const result = await spotifyClient.listPlaylists(7);
  assert.deepEqual(result.playlists, [{ id: "playlist", name: "Large Playlist", trackCount: 1001 }]);
});

test("stale refresh failures cannot clear a newly connected account", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  let resolveRefresh;
  let resolveRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const pendingRefresh = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({
        error: { status: 401, message: "Missing/invalid/expired access token" },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
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
  resolveRefresh(new Response(JSON.stringify({
    error: { status: 401, message: "Missing/invalid/expired refresh token" },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }));

  await assert.rejects(
    request,
    (error) => error?.code === "SPOTIFY_AUTH_REQUIRED" && error?.statusCode === 401,
  );
  assert.equal(spotifyConnectionStore.getConnection(7).refreshToken, "new-refresh-token");
  assert.equal(requestCount, 2);
});
