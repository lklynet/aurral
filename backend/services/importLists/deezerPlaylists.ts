import * as v from "valibot";
import {
  buildPlaylistTrackIdentity,
  dedupePlaylistTracks,
} from "../playlists/flowPlaylistConfig.ts";
import {
  deezerErrorSchema,
  deezerPageSchema,
  deezerPreviewPath,
  deezerTrackSchema,
} from "../apiClients/deezer.ts";
import { readMany, readOne } from "../integrationData.ts";

const DEEZER_API_URL = "https://api.deezer.com";
const REQUEST_TIMEOUT_MS = 10_000;
const TRACK_PAGE_SIZE = 500;
const MAX_TRACKS = 2_000;
const SHELF_PLAYLISTS_PER_GENRE = 8;
const SHELF_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_RESULTS_PER_TAG = 25;
const PARTIAL_SHELF_TTL_MS = 15 * 60 * 1000;
const PLAYLIST_ID_PATTERN = /^\d{1,20}$/;
const DEEZER_NO_DATA_CODE = 800;
const DEEZER_QUOTA_CODE = 4;

export const EDITORIAL_GENRES = [
  { id: 0, name: "Popular" },
  { id: 132, name: "Pop" },
  { id: 116, name: "Rap/Hip Hop" },
  { id: 152, name: "Rock" },
  { id: 113, name: "Dance" },
  { id: 165, name: "R&B" },
  { id: 85, name: "Alternative" },
  { id: 106, name: "Electro" },
  { id: 129, name: "Jazz" },
  { id: 464, name: "Metal" },
];

export const deezerPlaylistSchema = v.looseObject({
  id: v.number(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  nb_tracks: v.optional(v.number()),
  picture_xl: v.optional(v.string()),
  picture_big: v.optional(v.string()),
  user: v.optional(v.looseObject({ name: v.optional(v.string()) })),
  creator: v.optional(v.looseObject({ name: v.optional(v.string()) })),
});

type DeezerPlaylist = v.InferOutput<typeof deezerPlaylistSchema>;

type EditorialGenres = Awaited<ReturnType<typeof loadShelf>>["genres"];

let shelfCache: { genres: EditorialGenres; expiresAt: number } | null = null;
let shelfRequest: Promise<EditorialGenres> | null = null;
const tagSearchCache = new Map<string, { playlists: PlaylistSummary[]; expiresAt: number }>();

const providerError = (message: string, statusCode: number, code: string) => {
  const error: Error & { statusCode?: number; code?: string } = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export function validateDeezerPlaylistId(value: unknown) {
  const id = String(value ?? "").trim();
  if (PLAYLIST_ID_PATTERN.test(id)) return id;
  throw providerError("Enter a valid Deezer playlist", 400, "DEEZER_PLAYLIST_INVALID");
}

export async function deezerRequest<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  params: Record<string, string | number> = {},
) {
  const url = new URL(`${DEEZER_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw providerError("Deezer could not be reached", 502, "DEEZER_UNAVAILABLE");
  }
  if (response.status === 429) {
    throw providerError(
      "Deezer is rate limiting requests; try again later",
      429,
      "DEEZER_RATE_LIMITED",
    );
  }
  if (!response.ok) {
    throw providerError(`Deezer request failed (${response.status})`, 502, "DEEZER_UNAVAILABLE");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw providerError("Deezer returned an unreadable response", 502, "DEEZER_UNAVAILABLE");
  }
  const failure = v.safeParse(deezerErrorSchema, body);
  if (failure.success) {
    const { code } = failure.output.error;
    if (code === DEEZER_NO_DATA_CODE) {
      throw providerError("The Deezer playlist is unavailable", 404, "DEEZER_PLAYLIST_NOT_FOUND");
    }
    if (code === DEEZER_QUOTA_CODE) {
      throw providerError(
        "Deezer is rate limiting requests; try again later",
        429,
        "DEEZER_RATE_LIMITED",
      );
    }
    throw providerError("Deezer returned an error", 502, "DEEZER_UNAVAILABLE");
  }
  return readOne(schema, body, { service: "Deezer", endpoint: path });
}

export async function deezerList<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  params: Record<string, string | number> = {},
) {
  const page = await deezerRequest(deezerPageSchema, path, params);
  return {
    items: readMany(schema, page.data, { service: "Deezer", endpoint: path }),
    received: page.data.length,
    next: page.next,
  };
}

const normalizePlaylistSummary = (playlist: DeezerPlaylist) => {
  const id = String(playlist.id);
  const name = String(playlist.title || "").trim();
  if (!PLAYLIST_ID_PATTERN.test(id) || !name) return null;
  return {
    id,
    name,
    description: String(playlist.description || "").trim() || null,
    trackCount: Number(playlist.nb_tracks) || 0,
    artworkUrl: playlist.picture_xl || playlist.picture_big || null,
    curator: String(playlist.user?.name || playlist.creator?.name || "").trim() || null,
  };
};

type PlaylistSummary = NonNullable<ReturnType<typeof normalizePlaylistSummary>>;

const normalizeTracks = (rows: v.InferOutput<typeof deezerTrackSchema>[]) => {
  const stats = {
    sourceItems: rows.length,
    unavailable: 0,
    podcast: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const excluded = [];
  const raw = [];
  const positions = [];
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    const artistName = String(row?.artist?.name || "").trim();
    const trackName = String(row?.title || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      excluded.push({ position, reason: "incomplete", trackName: trackName || null });
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: String(row?.album?.title || "").trim() || null,
      durationMs: Number(row?.duration) > 0 ? Number(row.duration) * 1000 : null,
      preview_url: row?.preview && row.id ? deezerPreviewPath(row.id) : null,
      artworkUrl: row?.album?.cover_medium || null,
      deezerAlbumId: row?.album?.id ? String(row.album.id) : null,
    });
    positions.push(position);
  }
  const seen = new Set();
  for (const [index, track] of raw.entries()) {
    const identity = buildPlaylistTrackIdentity(track);
    if (seen.has(identity)) {
      stats.duplicate += 1;
      excluded.push({
        position: positions[index],
        reason: "duplicate",
        artistName: track.artistName,
        trackName: track.trackName,
      });
    }
    seen.add(identity);
  }
  const deezerFields = new Map();
  for (const { preview_url, artworkUrl, deezerAlbumId, ...track } of raw) {
    const identity = buildPlaylistTrackIdentity(track);
    if (!deezerFields.has(identity)) {
      deezerFields.set(identity, { preview_url, artworkUrl, deezerAlbumId });
    }
  }
  const tracks = dedupePlaylistTracks(raw).map((track) => ({
    ...track,
    ...deezerFields.get(buildPlaylistTrackIdentity(track)),
  }));
  excluded.sort((left, right) => left.position - right.position);
  return { tracks, stats, excluded };
};

export async function getDeezerPlaylist(value: unknown) {
  const id = validateDeezerPlaylistId(value);
  const summary = normalizePlaylistSummary(
    await deezerRequest(deezerPlaylistSchema, `/playlist/${id}`),
  );
  if (!summary) {
    throw providerError("The Deezer playlist is unavailable", 404, "DEEZER_PLAYLIST_NOT_FOUND");
  }
  const rows: v.InferOutput<typeof deezerTrackSchema>[] = [];
  let index = 0;
  while (index < MAX_TRACKS) {
    const page = await deezerList(deezerTrackSchema, `/playlist/${id}/tracks`, {
      index,
      limit: TRACK_PAGE_SIZE,
    });
    rows.push(...page.items);
    index += page.received;
    if (page.received === 0 || !page.next) break;
  }
  return { ...summary, ...normalizeTracks(rows.slice(0, MAX_TRACKS)) };
}

async function loadShelf() {
  const results = await Promise.allSettled(
    EDITORIAL_GENRES.map((genre) =>
      deezerList(deezerPlaylistSchema, `/chart/${genre.id}/playlists`, {
        limit: SHELF_PLAYLISTS_PER_GENRE * 2,
      }),
    ),
  );
  if (results.every((result) => result.status === "rejected")) throw results[0].reason;
  const seen = new Set();
  const genres = [];
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue;
    const playlists = [];
    for (const entry of result.value.items) {
      const playlist = normalizePlaylistSummary(entry);
      if (!playlist || seen.has(playlist.id)) continue;
      seen.add(playlist.id);
      playlists.push(playlist);
      if (playlists.length >= SHELF_PLAYLISTS_PER_GENRE) break;
    }
    if (playlists.length > 0) genres.push({ ...EDITORIAL_GENRES[index], playlists });
  }
  const complete = results.every((result) => result.status === "fulfilled");
  return { genres, ttlMs: complete ? SHELF_TTL_MS : PARTIAL_SHELF_TTL_MS };
}

export async function getEditorialShelf() {
  if (shelfCache && shelfCache.expiresAt > Date.now()) return shelfCache.genres;
  if (!shelfRequest) {
    shelfRequest = loadShelf()
      .then(({ genres, ttlMs }) => {
        shelfCache = { genres, expiresAt: Date.now() + ttlMs };
        return genres;
      })
      .catch((error) => {
        if (shelfCache) return shelfCache.genres;
        throw error;
      })
      .finally(() => {
        shelfRequest = null;
      });
  }
  return shelfRequest;
}

const isEditorPlaylist = (playlist: DeezerPlaylist) =>
  /deezer/i.test(String(playlist.user?.name || playlist.creator?.name || ""));

export async function searchEditorialPlaylists(tag: unknown) {
  const key = String(tag || "")
    .trim()
    .toLowerCase();
  if (!key) return [];
  const cached = tagSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.playlists;
  const { items } = await deezerList(deezerPlaylistSchema, "/search/playlist", {
    q: key,
    limit: SEARCH_RESULTS_PER_TAG,
  });
  const playlists = items
    .filter(isEditorPlaylist)
    .map(normalizePlaylistSummary)
    .filter((playlist): playlist is PlaylistSummary => playlist !== null);
  tagSearchCache.set(key, { playlists, expiresAt: Date.now() + SHELF_TTL_MS });
  return playlists;
}
