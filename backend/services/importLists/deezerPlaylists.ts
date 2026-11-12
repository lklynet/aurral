import * as v from "valibot";
import { buildPlaylistTrackIdentity, dedupePlaylistTracks } from "../playlists/playlistTracks.ts";
import {
  DEEZER_HEADERS,
  deezerErrorSchema,
  deezerLimiter,
  deezerPageSchema,
  deezerPreviewPath,
  deezerTrackSchema,
} from "../apiClients/deezer.ts";
import { readMany, readOne } from "../integrationData.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import createCache from "../apiClients/simpleCache.ts";
import { asAppError } from "../../../lib/errors.ts";

const DEEZER_API_URL = "https://api.deezer.com";
const REQUEST_TIMEOUT_MS = 10_000;
const TRACK_PAGE_SIZE = 500;
const MAX_TRACKS = 2_000;
const SHELF_PLAYLISTS_PER_CATEGORY = 12;
const SHELF_MIN_PLAYLISTS = 3;
const SHELF_CONCURRENCY = 6;
const SHELF_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_RESULTS_PER_TAG = 25;
const MAX_CACHED_SEARCHES = 200;
const ARTIST_PLAYLISTS = 20;
const FAILED_SOURCE_RETRY_MS = 15 * 60 * 1000;
const FEATURED_SOURCE_ID = "genre-0";
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
  { id: 84, name: "Country" },
  { id: 85, name: "Alternative" },
  { id: 106, name: "Electro" },
  { id: 129, name: "Jazz" },
  { id: 464, name: "Metal" },
];

const SHELF_GENRES = [
  ...EDITORIAL_GENRES,
  { id: 169, name: "Soul & Funk" },
  { id: 466, name: "Folk" },
  { id: 153, name: "Blues" },
  { id: 98, name: "Classical" },
  { id: 144, name: "Reggae" },
  { id: 122, name: "Reggaeton" },
  { id: 197, name: "Latin" },
  { id: 2, name: "African" },
  { id: 16, name: "Asian" },
  { id: 75, name: "Brazilian" },
  { id: 65, name: "Mexican" },
  { id: 67, name: "Salsa" },
  { id: 71, name: "Cumbia" },
  { id: 81, name: "Indian" },
  { id: 173, name: "Film & Games" },
  { id: 186, name: "Christian" },
  { id: 95, name: "Kids" },
];

const SHELF_MOODS = [
  "Chill",
  "Focus",
  "Workout",
  "Party",
  "Feel good",
  "Sad",
  "Love",
  "Sleep",
  "Road trip",
  "Dinner",
  "Gaming",
  "Acoustic",
];

const SHELF_DECADES = ["60s", "70s", "80s", "90s", "2000s", "2010s"];

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const deezerPlaylistSchema = v.looseObject({
  id: v.number(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  nb_tracks: v.optional(v.number()),
  picture_xl: v.nullish(v.string()),
  picture_big: v.nullish(v.string()),
  user: v.optional(v.looseObject({ id: v.optional(v.number()), name: v.optional(v.string()) })),
  creator: v.optional(v.looseObject({ name: v.optional(v.string()) })),
});

type DeezerPlaylist = v.InferOutput<typeof deezerPlaylistSchema>;

type SearchedPlaylists = { editors: PlaylistSummary[]; others: PlaylistSummary[] };
type CachedSource = { playlists: PlaylistSummary[] | null; error: unknown; expiresAt: number };

const sourceCache = new Map<string, CachedSource>();
const sourceRequests = new Map<string, Promise<PlaylistSummary[]>>();
const tagSearchCache = new Map<string, SearchedPlaylists & { expiresAt: number }>();
const artistPlaylistCache = createCache<PlaylistSummary[]>(SHELF_TTL_MS / 1000, 500);

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
    response = await deezerLimiter.schedule(() =>
      fetch(url, {
        headers: { Accept: "application/json", ...DEEZER_HEADERS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );
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
    artworkUrl: playlist.picture_big || playlist.picture_xl || null,
    curator: String(playlist.user?.name || playlist.creator?.name || "").trim() || null,
  };
};

type PlaylistSummary = NonNullable<ReturnType<typeof normalizePlaylistSummary>>;

type DeezerTrack = v.InferOutput<typeof deezerTrackSchema>;

const normalizeTracks = (rows: DeezerTrack[]) => {
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
      preview_url: deezerPreviewPath(row.id),
      artworkUrl: row?.album?.cover_medium || null,
      deezerAlbumId: row?.album?.id ? String(row.album.id) : null,
    });
    positions.push(position);
  }
  const seen = new Set<string>();
  for (const [index, track] of raw.entries()) {
    const identity = buildPlaylistTrackIdentity(track);
    if (seen.has(identity)) {
      stats.duplicate += 1;
      excluded.push({
        position: positions[index] ?? 0,
        reason: "duplicate",
        artistName: track.artistName,
        trackName: track.trackName,
      });
    }
    seen.add(identity);
  }
  const deezerFields = new Map<
    string,
    Pick<(typeof raw)[number], "preview_url" | "artworkUrl" | "deezerAlbumId">
  >();
  for (const { preview_url, artworkUrl, deezerAlbumId, ...track } of raw) {
    const identity = buildPlaylistTrackIdentity(track);
    if (!deezerFields.has(identity)) {
      deezerFields.set(identity, { preview_url, artworkUrl, deezerAlbumId });
    }
  }
  const tracks = dedupePlaylistTracks(raw).map((track) => ({
    ...track,
    ...deezerFields.get(buildPlaylistTrackIdentity(track))!,
  }));
  excluded.sort((left, right) => left.position - right.position);
  return { tracks, stats, excluded };
};

export async function getDeezerPlaylist(value: unknown) {
  const id = validateDeezerPlaylistId(value);
  const playlist = await deezerRequest(deezerPlaylistSchema, `/playlist/${id}`);
  const summary = normalizePlaylistSummary(playlist);
  if (!summary) {
    throw providerError("The Deezer playlist is unavailable", 404, "DEEZER_PLAYLIST_NOT_FOUND");
  }
  const rows: DeezerTrack[] = [];
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
  return {
    ...summary,
    artworkUrl: playlist.picture_xl || summary.artworkUrl,
    ...normalizeTracks(rows.slice(0, MAX_TRACKS)),
  };
}

type ShelfSource = {
  id: string;
  name: string;
  group: "genre" | "mood" | "decade";
  load: () => Promise<PlaylistSummary[]>;
};

const SHELF_SOURCES: ShelfSource[] = [
  ...SHELF_GENRES.map((genre) => ({
    id: `genre-${genre.id}`,
    name: genre.name,
    group: "genre" as const,
    load: async () =>
      (
        await deezerList(deezerPlaylistSchema, `/chart/${genre.id}/playlists`, {
          limit: SHELF_PLAYLISTS_PER_CATEGORY * 2,
        })
      ).items
        .map(normalizePlaylistSummary)
        .filter((playlist) => playlist !== null),
  })),
  ...SHELF_MOODS.map((name) => ({
    id: `mood-${slug(name)}`,
    name,
    group: "mood" as const,
    load: () => searchEditorialPlaylists(name),
  })),
  ...SHELF_DECADES.map((name) => ({
    id: `decade-${slug(name)}`,
    name,
    group: "decade" as const,
    load: () => searchEditorialPlaylists(name),
  })),
];

function refreshSource(source: ShelfSource) {
  const pending = sourceRequests.get(source.id);
  if (pending) return pending;
  const request = source
    .load()
    .then(
      (playlists) => {
        sourceCache.set(source.id, {
          playlists,
          error: null,
          expiresAt: Date.now() + SHELF_TTL_MS,
        });
        return playlists;
      },
      (error: unknown) => {
        sourceCache.set(source.id, {
          playlists: sourceCache.get(source.id)?.playlists ?? null,
          error,
          expiresAt: Date.now() + FAILED_SOURCE_RETRY_MS,
        });
        throw error;
      },
    )
    .finally(() => sourceRequests.delete(source.id));
  sourceRequests.set(source.id, request);
  return request;
}

async function loadSource(source: ShelfSource) {
  const cached = sourceCache.get(source.id);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.playlists) return cached.playlists;
    throw cached.error;
  }
  if (cached?.playlists) {
    refreshSource(source).catch(() => {});
    return cached.playlists;
  }
  return refreshSource(source);
}

export type ShelfScope = "featured" | "all";

export async function getEditorialShelf(scope: ShelfScope = "all") {
  const sources =
    scope === "featured"
      ? SHELF_SOURCES.filter((source) => source.id === FEATURED_SOURCE_ID)
      : SHELF_SOURCES;
  const results = await mapWithConcurrency(sources, SHELF_CONCURRENCY, (source) =>
    loadSource(source).then(
      (playlists) => ({ ok: true as const, playlists }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
  );
  const firstFailure = results.find((result) => !result.ok);
  if (firstFailure && !firstFailure.ok && results.every((result) => !result.ok)) {
    throw firstFailure.reason;
  }
  const seen = new Set<string>();
  const categories = [];
  for (const [index, result] of results.entries()) {
    const source = sources[index];
    if (!source || !result.ok) continue;
    const playlists = result.playlists
      .filter((playlist) => !seen.has(playlist.id))
      .slice(0, SHELF_PLAYLISTS_PER_CATEGORY);
    if (playlists.length < SHELF_MIN_PLAYLISTS) continue;
    for (const playlist of playlists) seen.add(playlist.id);
    categories.push({ id: source.id, name: source.name, group: source.group, playlists });
  }
  return categories;
}

const curatorName = (playlist: DeezerPlaylist) =>
  String(playlist.user?.name || playlist.creator?.name || "");

const isEditorPlaylist = (playlist: DeezerPlaylist) => /deezer/i.test(curatorName(playlist));

const artistPlaylistRank = (playlist: DeezerPlaylist) =>
  /deezer artist editor/i.test(curatorName(playlist)) ? 0 : isEditorPlaylist(playlist) ? 1 : 2;

export async function getDeezerArtistPlaylists(artistId: string) {
  const cached = artistPlaylistCache.get(artistId);
  if (cached) return cached;
  const { items } = await deezerList(deezerPlaylistSchema, `/artist/${artistId}/playlists`, {
    limit: ARTIST_PLAYLISTS,
  }).catch((error: unknown) => {
    if (asAppError(error)?.code === "DEEZER_PLAYLIST_NOT_FOUND") return { items: [] };
    throw error;
  });
  const playlists = items
    .toSorted((left, right) => artistPlaylistRank(left) - artistPlaylistRank(right))
    .map(normalizePlaylistSummary)
    .filter((playlist) => playlist !== null);
  artistPlaylistCache.set(artistId, playlists);
  return playlists;
}

export async function searchDeezerPlaylists(term: unknown): Promise<SearchedPlaylists> {
  const key = String(term || "")
    .trim()
    .toLowerCase();
  if (!key) return { editors: [], others: [] };
  const cached = tagSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const { items } = await deezerList(deezerPlaylistSchema, "/search/playlist", {
    q: key,
    limit: SEARCH_RESULTS_PER_TAG,
  });
  const searched: SearchedPlaylists = { editors: [], others: [] };
  for (const item of items) {
    const playlist = normalizePlaylistSummary(item);
    if (playlist) searched[isEditorPlaylist(item) ? "editors" : "others"].push(playlist);
  }
  tagSearchCache.set(key, { ...searched, expiresAt: Date.now() + SHELF_TTL_MS });
  const [oldest] = tagSearchCache.keys();
  if (oldest !== undefined && tagSearchCache.size > MAX_CACHED_SEARCHES) {
    tagSearchCache.delete(oldest);
  }
  return searched;
}

export const searchEditorialPlaylists = async (term: unknown) =>
  (await searchDeezerPlaylists(term)).editors;
