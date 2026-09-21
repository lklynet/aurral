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

test("playlist track fetch follows every page of Spotify's current items endpoint", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        items: [{ item: { name: "First" } }],
        next: "https://api.spotify.com/v1/playlists/playlist/items?offset=50&limit=50",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      items: [{ item: { name: "Second" } }],
      next: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const items = await spotifyClient.listPlaylistTracks(7, "playlist");
  assert.deepEqual(items.map((entry) => entry.item.name), ["First", "Second"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].pathname, "/v1/playlists/playlist/items");
  assert.equal(requests[0].searchParams.get("limit"), "50");
  assert.match(requests[0].searchParams.get("fields"), /item\(type,name/);
  assert.equal(requests[1].searchParams.get("offset"), "50");
});

test("playlist track fetch falls back for a followed playlist the items endpoint cannot read", async () => {
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (requests.length === 1) return new Response("Forbidden", { status: 403 });
    return new Response(JSON.stringify({
      items: [{ track: { name: "Followed Playlist Track" } }],
      next: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const items = await spotifyClient.listPlaylistTracks(7, "followed-playlist");
  assert.equal(items[0].track.name, "Followed Playlist Track");
  assert.equal(requests[0].pathname, "/v1/playlists/followed-playlist/items");
  assert.equal(requests[1].pathname, "/v1/playlists/followed-playlist/tracks");
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
