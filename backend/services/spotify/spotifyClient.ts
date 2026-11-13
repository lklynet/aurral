import * as v from "valibot";
import { asAppError } from "../../../lib/errors.ts";
import { lenient, lenientText } from "../integrationData.ts";
import {
  spotifyPlaylistItemSchema,
  type SpotifyPlaylistItem,
} from "../importLists/spotifyTracks.ts";
import { SPOTIFY_API_BASE, SPOTIFY_RENEW_URI } from "./spotifyConfig.ts";
import { spotifyConnectionStore, type SpotifyConnection } from "./spotifyConnectionStore.ts";
import createCache from "../apiClients/simpleCache.ts";
import { runSharedInflight, type InflightRequests } from "../sharedInflight.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";

interface SpotifyError extends Error {
  code?: string;
  statusCode?: number;
  playlistId?: string;
  reportedTotal?: number | null;
  fetchedCount?: number;
}

const spotifyTokenSchema = v.fallback(
  v.looseObject({
    access_token: lenientText,
    accessToken: lenientText,
    refresh_token: lenientText,
    refreshToken: lenientText,
    expires_in: lenient(v.number()),
    expiresIn: lenient(v.number()),
  }),
  {},
);

const spotifyTotalSchema = lenient(v.looseObject({ total: lenient(v.number()) }));

const spotifyPlaylistSummarySchema = v.fallback(
  v.looseObject({
    images: lenient(
      v.array(
        v.fallback(v.looseObject({ url: lenientText, width: lenient(v.nullable(v.number())) }), {}),
      ),
    ),
    id: lenientText,
    name: lenientText,
    items: spotifyTotalSchema,
    tracks: spotifyTotalSchema,
  }),
  {},
);

const spotifyPageSchema = <Item extends v.GenericSchema>(item: Item) =>
  lenient(
    v.looseObject({
      items: lenient(v.array(item)),
      next: lenient(v.nullable(v.string())),
      total: lenient(v.number()),
      offset: lenient(v.number()),
    }),
  );

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
  onPage?: (page: SpotifyPageSummary) => void;
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";
export const SPOTIFY_LIKED_SONGS_ID = "liked";
const INVALID_GRANT = "invalid_grant";
const playlistTrackCache = createCache<SpotifyPlaylistItem[]>(2 * 60, 200);
const playlistTrackInflight = new Map<string, Promise<SpotifyPlaylistItem[]>>();
const playlistTrackGeneration = new Map<string, number>();
const tokenRefreshInflight: InflightRequests = new Map();

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

const createAuthRequiredError = (
  message = "Your Spotify connection expired. Connect Spotify again.",
) => {
  const error: SpotifyError = new Error(message);
  error.code = SPOTIFY_AUTH_REQUIRED_CODE;
  error.statusCode = 401;
  return error;
};

const canReadLikedSongs = (userId: number | undefined) =>
  Boolean(spotifyConnectionStore.getConnection(userId)?.scope?.includes("user-library-read"));

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
  return createAuthRequiredError();
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
  return createAuthRequiredError();
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

const SPOTIFY_TIMEOUT_MS = 15_000;
const SPOTIFY_MAX_RETRY_AFTER_SECONDS = 30;

async function renewAccessToken(refreshToken: string, signal: AbortSignal) {
  const url = new URL(SPOTIFY_RENEW_URI);
  url.searchParams.set("refresh_token", refreshToken);
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.any([signal, AbortSignal.timeout(SPOTIFY_TIMEOUT_MS)]),
  });
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
  const payload = v.parse(spotifyTokenSchema, await response.json());
  const accessToken = String(payload.access_token || payload.accessToken || "").trim();
  const nextRefreshToken = String(
    payload.refresh_token || payload.refreshToken || refreshToken,
  ).trim();
  const expiresIn = Number(payload.expires_in ?? payload.expiresIn ?? 3600);
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

async function sendSpotifyRequest(url: URL, accessToken: string) {
  const send = () =>
    fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS),
    });
  const response = await send();
  const retryAfter = response.headers.get("retry-after");
  const waitSeconds = Number(retryAfter);
  if (
    response.status !== 429 ||
    retryAfter === null ||
    !(waitSeconds >= 0 && waitSeconds <= SPOTIFY_MAX_RETRY_AFTER_SECONDS)
  ) {
    return response;
  }
  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  return send();
}

async function spotifyRequest(
  userId: number | undefined,
  path: string | null,
  { searchParams, url: absoluteUrl }: SpotifyRequestOptions = {},
): Promise<unknown> {
  const connection = await getValidConnection(userId);
  const url = absoluteUrl ? new URL(absoluteUrl) : new URL(`${SPOTIFY_API_BASE}${path}`);
  if (!absoluteUrl && searchParams && typeof searchParams === "object") {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  let response = await sendSpotifyRequest(url, connection.accessToken);
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
    response = await sendSpotifyRequest(url, nextConnection.accessToken);
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

async function fetchAllPages<Item extends v.GenericSchema>(
  userId: number | undefined,
  path: string,
  item: Item,
  { searchParams, onPage }: FetchAllPagesOptions = {},
) {
  const pageSchema = spotifyPageSchema(item);
  const items: v.InferOutput<Item>[] = [];
  let nextUrl: string | null = null;
  while (true) {
    const response: unknown = nextUrl
      ? await spotifyRequest(userId, null, { url: nextUrl })
      : await spotifyRequest(userId, path, { searchParams });
    const payload = v.parse(pageSchema, response);
    const pageItems = payload?.items ?? [];
    onPage?.({
      offset: payload?.offset ?? null,
      total: payload?.total ?? null,
      itemCount: pageItems.length,
    });
    items.push(...pageItems);
    nextUrl = payload?.next || null;
    if (!nextUrl) break;
  }
  return items;
}

export const spotifyClient = {
  async listPlaylists(userId: number) {
    const playlists = await fetchAllPages(userId, "/me/playlists", spotifyPlaylistSummarySchema, {
      searchParams: { limit: 50 },
    });
    const liked = canReadLikedSongs(userId)
      ? v.parse(
          spotifyPageSchema(v.unknown()),
          await spotifyRequest(userId, "/me/tracks", { searchParams: { limit: 1 } }),
        )
      : null;
    const connection = spotifyConnectionStore.getPublicStatus(userId);
    return {
      user: connection.displayName || "Spotify",
      playlists: [
        {
          id: SPOTIFY_LIKED_SONGS_ID,
          name: "Liked Songs",
          trackCount: liked?.total,
        },
        ...playlists
          .map((playlist) => ({
            id: String(playlist.id || "").trim(),
            name: String(playlist.name || "").trim(),
            trackCount: Number(playlist.items?.total ?? playlist.tracks?.total ?? 0),
          }))
          .filter((playlist) => playlist.id && playlist.name)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ],
    };
  },

  async getPlaylistArtworkUrl(userId: number | undefined, playlistId: string) {
    if (playlistId === SPOTIFY_LIKED_SONGS_ID) return null;
    const playlist = v.parse(
      spotifyPlaylistSummarySchema,
      await spotifyRequest(userId, `/playlists/${encodeURIComponent(playlistId)}`, {
        searchParams: { fields: "images" },
      }),
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
  ): Promise<SpotifyPlaylistItem[]> {
    await getValidConnection(userId);
    if (playlistId === SPOTIFY_LIKED_SONGS_ID && !canReadLikedSongs(userId)) {
      throw createAuthRequiredError("Connect Spotify again to import Liked Songs.");
    }
    const generation = getPlaylistTrackGeneration(userId);
    const cacheKey = playlistTrackCacheKey(userId, playlistId);
    if (!forceRefresh) {
      const cached = playlistTrackCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const inflight = playlistTrackInflight.get(cacheKey);
      if (inflight) return inflight;
    }

    const pages: SpotifyPageSummary[] = [];
    const onPage = (page: SpotifyPageSummary) => pages.push(page);
    const request = (
      playlistId === SPOTIFY_LIKED_SONGS_ID
        ? fetchAllPages(userId, "/me/tracks", spotifyPlaylistItemSchema, {
            searchParams: { limit: 50 },
            onPage,
          })
        : fetchAllPages(
            userId,
            `/playlists/${encodeURIComponent(playlistId)}/items`,
            spotifyPlaylistItemSchema,
            {
              searchParams: {
                limit: 50,
                additional_types: "episode",
                fields:
                  "items(item(type,name,duration_ms,artists(name),album(name))),next,total,offset",
              },
              onPage,
            },
          )
    ).then((items) => {
      if (getPlaylistTrackGeneration(userId) !== generation) {
        throw createAuthRequiredError();
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
