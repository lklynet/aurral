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
