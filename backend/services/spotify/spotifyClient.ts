import { asAppError } from "../../../lib/errors.ts";
import { SPOTIFY_API_BASE, SPOTIFY_RENEW_URI } from "./spotifyConfig.ts";
import { spotifyConnectionStore, type SpotifyConnection } from "./spotifyConnectionStore.ts";
import createCache from "../apiClients/simpleCache.ts";
import { runSharedInflight } from "../sharedInflight.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";

interface SpotifyError extends Error {
  code?: string;
  statusCode?: number;
  playlistId?: string;
  reportedTotal?: number | null;
  fetchedCount?: number;
}

interface SpotifyTokenPayload {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  expires_in?: number;
  expiresIn?: number;
}

interface SpotifyTrackItem {
  type: "track";
  name?: string;
  artists?: { name?: string }[];
  album?: { name?: string };
}

interface SpotifyEpisodeItem {
  type: "episode";
  name?: string;
}

type SpotifyTrack = SpotifyTrackItem | SpotifyEpisodeItem;

interface SpotifyPlaylistItem {
  item?: SpotifyTrack | null;
}

interface SpotifyPlaylistSummary {
  images?: { url?: string; width?: number | null; height?: number | null }[];
  id?: string;
  name?: string;
  items?: { total?: number };
  tracks?: { total?: number };
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
  total?: number;
  offset?: number;
}

interface SpotifyPageSummary {
  offset: number | null;
  total: number | null;
  itemCount: number;
}

type SpotifySearchParams = Record<string, string | number>;

interface SpotifyRequestOptions {
  searchParams?: SpotifySearchParams;
  url?: string;
}

interface FetchAllPagesOptions {
  searchParams?: SpotifySearchParams;
  itemsKey?: "items";
  onPage?: (page: SpotifyPageSummary) => void;
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";
const INVALID_GRANT = "invalid_grant";
const playlistTrackCache = createCache(2 * 60, 200);
const playlistTrackInflight = new Map();
const playlistTrackGeneration = new Map();
const tokenRefreshInflight = new Map();

const getPlaylistTrackGeneration = (userId: number | string | undefined) =>
  playlistTrackGeneration.get(String(userId)) || 0;

const bumpPlaylistTrackGeneration = (userId: number | undefined) => {
  const key = String(userId);
  const generation = getPlaylistTrackGeneration(key) + 1;
  playlistTrackGeneration.set(key, generation);
  return generation;
};

const playlistTrackCacheKey = (userId: number | undefined, playlistId: string) =>
  `${String(userId)}:${getPlaylistTrackGeneration(userId)}:${String(playlistId)}`;

const createAuthRequiredError = (message: string) => {
  const error: SpotifyError = new Error(message);
  error.code = SPOTIFY_AUTH_REQUIRED_CODE;
  error.statusCode = 401;
  return error;
};

const createIncompletePlaylistError = (
  playlistId: string,
  reportedTotal: number | null,
  fetchedCount: number,
) => {
  const message =
    reportedTotal == null
      ? "Spotify did not report a playlist item total"
      : `Spotify returned ${fetchedCount} of ${reportedTotal} playlist items`;
  const error: SpotifyError = new Error(message);
  error.code = "SPOTIFY_INCOMPLETE_PLAYLIST";
  error.statusCode = 502;
  error.playlistId = playlistId;
  error.reportedTotal = reportedTotal;
  error.fetchedCount = fetchedCount;
  return error;
};

const disconnect = (userId: number | undefined, connection: SpotifyConnection, reason: unknown) => {
  if (spotifyConnectionStore.clearConnectionIfMatches(userId, connection)) {
    bumpPlaylistTrackGeneration(userId);
    logger.warn("spotify", "Spotify ended the connection; the user must connect again", {
      userId,
      reason: safeLogDiagnostic(reason),
    });
  }
  return createAuthRequiredError("Spotify connection expired");
};

const requireReconnect = (
  userId: number | undefined,
  connection: SpotifyConnection,
  reason: unknown,
) => {
  if (spotifyConnectionStore.setReconnectRequired(userId, connection, true)) {
    logger.warn("spotify", "Spotify rejected the connection; asking the user to reconnect", {
      userId,
      reason: safeLogDiagnostic(reason),
    });
  }
  return createAuthRequiredError("Spotify connection expired");
};

const refreshFailure = (
  userId: number | undefined,
  connection: SpotifyConnection,
  error: unknown,
) => {
  const failure = asAppError(error);
  if (failure?.code === INVALID_GRANT) return disconnect(userId, connection, error);
  if (failure?.statusCode === 401) return requireReconnect(userId, connection, error);
  return error;
};

async function renewAccessToken(refreshToken: string, signal: AbortSignal) {
  const url = new URL(SPOTIFY_RENEW_URI);
  url.searchParams.set("refresh_token", refreshToken);
  const response = await fetch(url, { method: "GET", signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error: SpotifyError = new Error(
      body || `Spotify token refresh failed (${response.status})`,
    );
    error.statusCode = response.status;
    if (response.status === 400 && /"error"\s*:\s*"invalid_grant"/.test(body)) {
      error.code = INVALID_GRANT;
    }
    throw error;
  }
  const payload: SpotifyTokenPayload = await response.json();
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

const refreshConnection = (
  userId: number | undefined,
  refreshToken: string,
  { force = false }: { force?: boolean } = {},
): Promise<SpotifyConnection> =>
  runSharedInflight(tokenRefreshInflight, String(userId), async (signal: AbortSignal) => {
    const latest = spotifyConnectionStore.getConnection(userId);
    if (!force && latest && latest.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
      return latest;
    }
    const renewed = await renewAccessToken(latest?.refreshToken || refreshToken, signal);
    const current = spotifyConnectionStore.getConnection(userId);
    if (!current) throw createAuthRequiredError("Spotify is not connected");
    if (
      current.accessToken !== latest?.accessToken ||
      current.refreshToken !== latest?.refreshToken
    ) {
      return current;
    }
    return spotifyConnectionStore.updateTokens(userId, renewed)!;
  });

async function getValidConnection(userId: number | undefined) {
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
    throw refreshFailure(userId, connection, error);
  }
}

async function spotifyRequest(
  userId: number | undefined,
  path: string | null,
  { searchParams, url: absoluteUrl }: SpotifyRequestOptions = {},
) {
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
  let nextConnection = connection;
  if (response.status === 401) {
    const latest = spotifyConnectionStore.getConnection(userId);
    try {
      nextConnection =
        latest?.accessToken && latest.accessToken !== connection.accessToken
          ? latest
          : await refreshConnection(userId, connection.refreshToken, { force: true });
    } catch (error) {
      throw refreshFailure(userId, connection, error);
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
    const error: SpotifyError = new Error(body || `Spotify request failed (${response.status})`);
    error.statusCode = response.status;
    if (response.status === 401) throw requireReconnect(userId, nextConnection, error);
    throw error;
  }
  if (
    nextConnection.reconnectRequired &&
    spotifyConnectionStore.setReconnectRequired(userId, nextConnection, false)
  ) {
    logger.info("spotify", "Spotify accepted the connection again", { userId });
  }
  if (response.status === 204) return null;
  return response.json();
}

async function fetchAllPages<T>(
  userId: number | undefined,
  path: string,
  { searchParams, itemsKey = "items", onPage }: FetchAllPagesOptions = {},
): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = null;
  while (true) {
    const payload: SpotifyPage<T> = nextUrl
      ? await spotifyRequest(userId, null, { url: nextUrl })
      : await spotifyRequest(userId, path, { searchParams });
    const pageItems = Array.isArray(payload?.[itemsKey]) ? payload[itemsKey] : [];
    onPage?.({
      offset:
        payload?.offset != null && Number.isFinite(Number(payload.offset))
          ? Number(payload.offset)
          : null,
      total:
        payload?.total != null && Number.isFinite(Number(payload.total))
          ? Number(payload.total)
          : null,
      itemCount: pageItems.length,
    });
    items.push(...pageItems);
    nextUrl = payload?.next || null;
    if (!nextUrl) break;
  }
  return items;
}

export const spotifyClient = {
  getProfile(userId: number) {
    return spotifyRequest(userId, "/me");
  },

  async listPlaylists(userId: number) {
    const playlists = await fetchAllPages<SpotifyPlaylistSummary | null>(userId, "/me/playlists", {
      searchParams: { limit: 50 },
    });
    const connection = spotifyConnectionStore.getPublicStatus(userId);
    return {
      user: connection.displayName || "Spotify",
      playlists: playlists
        .map((playlist) => ({
          id: String(playlist?.id || "").trim(),
          name: String(playlist?.name || "").trim(),
          trackCount: Number(playlist?.items?.total ?? playlist?.tracks?.total ?? 0),
        }))
        .filter((playlist) => playlist.id && playlist.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  async getPlaylistArtworkUrl(userId: number | undefined, playlistId: string) {
    const playlist: SpotifyPlaylistSummary = await spotifyRequest(
      userId,
      `/playlists/${encodeURIComponent(playlistId)}`,
      { searchParams: { fields: "images" } },
    );
    return (
      [...(playlist.images || [])]
        .sort((left, right) => (right.width || 0) - (left.width || 0))
        .find((image) => image.url)?.url || null
    );
  },

  async listPlaylistTracks(
    userId: number | undefined,
    playlistId: string,
    { forceRefresh = false }: { forceRefresh?: boolean } = {},
  ): Promise<(SpotifyPlaylistItem | null)[]> {
    await getValidConnection(userId);
    const generation = getPlaylistTrackGeneration(userId);
    const cacheKey = playlistTrackCacheKey(userId, playlistId);
    if (!forceRefresh) {
      const cached = playlistTrackCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const inflight = playlistTrackInflight.get(cacheKey);
      if (inflight) return inflight;
    }

    const pages: SpotifyPageSummary[] = [];
    const request = fetchAllPages<SpotifyPlaylistItem | null>(
      userId,
      `/playlists/${encodeURIComponent(playlistId)}/items`,
      {
        searchParams: {
          limit: 50,
          additional_types: "episode",
          fields: "items(item(type,name,artists(name),album(name))),next,total,offset",
        },
        onPage: (page) => pages.push(page),
      },
    ).then((items) => {
      if (getPlaylistTrackGeneration(userId) !== generation) {
        throw createAuthRequiredError("Spotify connection expired");
      }
      const reportedTotal = pages[0]?.total ?? null;
      const pageTotalsDiffer = pages.some((page) => page.total !== reportedTotal);
      if (reportedTotal == null || pageTotalsDiffer || reportedTotal !== items.length) {
        logger.warn("playlist-import", "Spotify playlist response incomplete", {
          playlistId,
          spotifyReportedTotal: reportedTotal,
          fetchedEntryCount: items.length,
          pageCount: pages.length,
          pages,
        });
        throw createIncompletePlaylistError(playlistId, reportedTotal, items.length);
      }
      logger.info("playlist-import", "Spotify playlist fetch completed", {
        playlistId,
        spotifyReportedTotal: reportedTotal,
        fetchedEntryCount: items.length,
        pageCount: pages.length,
      });
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

  clearPlaylistTrackCache(userId?: number | null) {
    if (userId != null) {
      bumpPlaylistTrackGeneration(userId);
      return;
    }
    playlistTrackCache.flushAll();
    playlistTrackInflight.clear();
  },
};
