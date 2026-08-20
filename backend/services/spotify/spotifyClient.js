import {
  SPOTIFY_API_BASE,
  SPOTIFY_RENEW_URI,
} from "./spotifyConfig.js";
import { spotifyConnectionStore } from "./spotifyConnectionStore.js";
import createCache from "../apiClients/simpleCache.js";
import { runSharedInflight } from "../sharedInflight.js";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";
const playlistTrackCache = createCache(2 * 60, 200);
const playlistTrackInflight = new Map();
const playlistTrackGeneration = new Map();
const tokenRefreshInflight = new Map();

const getPlaylistTrackGeneration = (userId) =>
  playlistTrackGeneration.get(String(userId)) || 0;

const bumpPlaylistTrackGeneration = (userId) => {
  const key = String(userId);
  const generation = getPlaylistTrackGeneration(key) + 1;
  playlistTrackGeneration.set(key, generation);
  return generation;
};

const playlistTrackCacheKey = (userId, playlistId) =>
  `${String(userId)}:${getPlaylistTrackGeneration(userId)}:${String(playlistId)}`;

const createAuthRequiredError = (message) => {
  const error = new Error(message);
  error.code = SPOTIFY_AUTH_REQUIRED_CODE;
  error.statusCode = 401;
  return error;
};

const invalidateConnection = (userId) => {
  spotifyConnectionStore.clearConnection(userId);
  bumpPlaylistTrackGeneration(userId);
  return createAuthRequiredError("Spotify connection expired");
};

async function renewAccessToken(refreshToken, signal) {
  const url = new URL(SPOTIFY_RENEW_URI);
  url.searchParams.set("refresh_token", refreshToken);
  const response = await fetch(url, { method: "GET", signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(body || `Spotify token refresh failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  const payload = await response.json();
  const accessToken = String(payload?.access_token || payload?.accessToken || "").trim();
  const nextRefreshToken = String(
    payload?.refresh_token || payload?.refreshToken || refreshToken,
  ).trim();
  const expiresIn = Number(payload?.expires_in ?? payload?.expiresIn ?? 3600);
  if (!accessToken) {
    throw new Error("Spotify token refresh returned no access token");
  }
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000,
  };
}

const refreshConnection = (userId, refreshToken, { force = false } = {}) =>
  runSharedInflight(
    tokenRefreshInflight,
    String(userId),
    async (signal) => {
      const latest = spotifyConnectionStore.getConnection(userId);
      if (!force && latest?.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
        return latest;
      }
      const renewed = await renewAccessToken(latest?.refreshToken || refreshToken, signal);
      return spotifyConnectionStore.updateTokens(userId, renewed);
    },
  );

async function getValidConnection(userId) {
  let connection = spotifyConnectionStore.getConnection(userId);
  if (!connection) {
    throw createAuthRequiredError("Spotify is not connected");
  }
  if (connection.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return connection;
  }
  try {
    return await refreshConnection(userId, connection.refreshToken);
  } catch (error) {
    if (error?.statusCode === 401) throw invalidateConnection(userId);
    throw error;
  }
}

async function spotifyRequest(userId, path, { searchParams, url: absoluteUrl } = {}) {
  const connection = await getValidConnection(userId);
  const url = absoluteUrl ? new URL(absoluteUrl) : new URL(`${SPOTIFY_API_BASE}${path}`);
  if (!absoluteUrl && searchParams && typeof searchParams === "object") {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  let response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "application/json",
    },
  });
  if (response.status === 401) {
    const latest = spotifyConnectionStore.getConnection(userId);
    let nextConnection;
    try {
      nextConnection =
        latest?.accessToken && latest.accessToken !== connection.accessToken
          ? latest
          : await refreshConnection(userId, connection.refreshToken, { force: true });
    } catch (error) {
      if (error?.statusCode === 401) throw invalidateConnection(userId);
      throw error;
    }
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${nextConnection.accessToken}`,
        Accept: "application/json",
      },
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 401) throw invalidateConnection(userId);
    const error = new Error(body || `Spotify request failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

async function fetchAllPages(userId, path, { searchParams, itemsKey = "items" } = {}) {
  const items = [];
  let nextUrl = null;
  while (true) {
    const payload = nextUrl
      ? await spotifyRequest(userId, null, { url: nextUrl })
      : await spotifyRequest(userId, path, { searchParams });
    const pageItems = Array.isArray(payload?.[itemsKey]) ? payload[itemsKey] : [];
    items.push(...pageItems);
    nextUrl = payload?.next || null;
    if (!nextUrl) break;
  }
  return items;
}

export const spotifyClient = {
  getProfile(userId) {
    return spotifyRequest(userId, "/me");
  },

  async listPlaylists(userId) {
    const playlists = await fetchAllPages(userId, "/me/playlists", {
      searchParams: { limit: 50 },
    });
    const connection = spotifyConnectionStore.getPublicStatus(userId);
    return {
      user: connection.displayName || "Spotify",
      playlists: playlists
        .map((playlist) => ({
          id: String(playlist?.id || "").trim(),
          name: String(playlist?.name || "").trim(),
          trackCount: Number(playlist?.tracks?.total || 0),
        }))
        .filter((playlist) => playlist.id && playlist.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  async listPlaylistTracks(userId, playlistId, { forceRefresh = false } = {}) {
    await getValidConnection(userId);
    const generation = getPlaylistTrackGeneration(userId);
    const cacheKey = playlistTrackCacheKey(userId, playlistId);
    if (!forceRefresh) {
      const cached = playlistTrackCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const inflight = playlistTrackInflight.get(cacheKey);
      if (inflight) return inflight;
    }

    const request = fetchAllPages(
      userId,
      `/playlists/${encodeURIComponent(playlistId)}/tracks`,
      {
        searchParams: {
          limit: 100,
          fields:
            "items(track(name,artists(name),album(name))),next",
        },
      },
    ).then((items) => {
      if (getPlaylistTrackGeneration(userId) !== generation) {
        throw createAuthRequiredError("Spotify connection expired");
      }
      playlistTrackCache.set(cacheKey, items);
      return items;
    });
    playlistTrackInflight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (playlistTrackInflight.get(cacheKey) === request) {
        playlistTrackInflight.delete(cacheKey);
      }
    }
  },

  clearPlaylistTrackCache(userId) {
    if (userId != null) {
      bumpPlaylistTrackGeneration(userId);
      return;
    }
    playlistTrackCache.flushAll();
    playlistTrackInflight.clear();
  },
};
