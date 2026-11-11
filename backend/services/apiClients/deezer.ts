import * as v from "valibot";
import { http, type HttpOptions } from "../../../lib/http.ts";
import { readMany, readOne } from "../integrationData.ts";
import createCache from "./simpleCache.ts";
import createRateLimiter from "./rateLimiter.ts";
import { createOutagePause } from "./outagePause.ts";

const DEEZER_API_URL = "https://api.deezer.com";
const DEEZER_NO_DATA_CODE = 800;

export const deezerErrorSchema = v.looseObject({
  error: v.looseObject({ code: v.optional(v.number()) }),
});

export const deezerPageSchema = v.looseObject({
  data: v.array(v.unknown()),
  next: v.optional(v.string()),
});

export const deezerArtistSchema = v.looseObject({
  id: v.number(),
  name: v.optional(v.string()),
  picture_xl: v.nullish(v.string()),
  picture_big: v.nullish(v.string()),
  picture_medium: v.nullish(v.string()),
  nb_fan: v.optional(v.number()),
});

export const deezerTrackSchema = v.looseObject({
  id: v.number(),
  title: v.string(),
  title_short: v.optional(v.string()),
  preview: v.optional(v.string()),
  isrc: v.optional(v.string()),
  duration: v.optional(v.number()),
  rank: v.optional(v.number()),
  track_position: v.optional(v.number()),
  disk_number: v.optional(v.number()),
  artist: v.optional(v.looseObject({ name: v.optional(v.string()) })),
  album: v.optional(
    v.looseObject({
      id: v.optional(v.number()),
      title: v.optional(v.string()),
      cover_medium: v.nullish(v.string()),
      cover_xl: v.nullish(v.string()),
    }),
  ),
});

const deezerAlbumSchema = v.looseObject({
  id: v.number(),
  title: v.optional(v.string()),
  record_type: v.optional(v.string()),
  release_date: v.optional(v.string()),
  cover_xl: v.nullish(v.string()),
  cover_big: v.nullish(v.string()),
  cover_medium: v.nullish(v.string()),
  fans: v.optional(v.number()),
});

type NumericField = string | number | null | undefined;

interface TrackLike {
  trackPosition?: NumericField;
  track_position?: NumericField;
  trackNumber?: NumericField;
  tracknumber?: NumericField;
  position?: NumericField;
  mediumNumber?: NumericField;
  mediumnumber?: NumericField;
  disk_number?: NumericField;
  diskNumber?: NumericField;
  durationMs?: NumericField;
  duration_ms?: NumericField;
  durationms?: NumericField;
  length?: NumericField;
  title?: string | null;
  trackName?: string | null;
  trackname?: string | null;
}

type DeezerArtistId = string | number | null;

type DeezerTrack = v.InferOutput<typeof deezerTrackSchema>;
type DeezerArtist = v.InferOutput<typeof deezerArtistSchema>;
type DeezerAlbum = v.InferOutput<typeof deezerAlbumSchema>;

function createDeezerCache<Value>(ttlSeconds: number, maxEntries?: number) {
  const cache = createCache<Value>(ttlSeconds, maxEntries);
  const inflight = new Map<string, Promise<Value>>();
  const load = async (key: string, fetch: () => Promise<Value>) => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = fetch().then((value) => {
      cache.set(key, value);
      return value;
    });
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  };
  return { ...cache, load };
}

const deezerArtistPhoto = (artist: DeezerArtist) => {
  const url = artist.picture_xl || artist.picture_big || artist.picture_medium;
  return url && !url.includes("/images/artist//") ? url : null;
};

const toArtist = (artist: DeezerArtist) => ({
  id: artist.id,
  name: artist.name || null,
  imageUrl: deezerArtistPhoto(artist),
});

const toRelatedArtist = (artist: DeezerArtist) => {
  const name = artist.name?.trim();
  return name ? [{ name, image: deezerArtistPhoto(artist) }] : [];
};

const toTopTrack = (track: DeezerTrack) => ({
  id: String(track.id),
  title: track.title,
  album: track.album?.title ?? null,
  artworkUrl: track.album?.cover_medium ?? null,
  preview_url: deezerPreviewPath(track.id),
  duration_ms: (track.duration || 0) * 1000,
});

const toTopListTrack = (track: DeezerTrack, artistName: string) => ({
  name: track.title.trim(),
  artistName: String(track.artist?.name || "").trim() || artistName,
  albumName: String(track.album?.title || "").trim() || null,
  mbid: null,
  durationMs: track.duration ? track.duration * 1000 : null,
  popularity: Number(track.rank) || 0,
  previewUrl: track.preview ? deezerPreviewPath(track.id) : null,
  artworkUrl: track.album?.cover_medium ?? null,
  deezerAlbumId: track.album?.id ? String(track.album.id) : null,
});

const toAlbum = (album: DeezerAlbum) => {
  const title = album.title || "";
  const releaseDate = album.release_date || "";
  return {
    id: album.id,
    title,
    "first-release-date": releaseDate ? releaseDate.slice(0, 4) : null,
    "primary-type": normalizeDeezerPrimaryType(album.record_type),
    "secondary-types": [],
    _coverUrl: album.cover_xl || album.cover_big || album.cover_medium || null,
    fans: album.fans ?? 0,
    _normalizedTitle: normalizeTitle(title),
    _releaseDate: releaseDate,
  };
};

const toAlbumTrack = (track: DeezerTrack, index: number) => ({
  id: String(track.id),
  mbid: String(track.id),
  title: track.title,
  trackName: track.title,
  trackNumber: track.track_position || index + 1,
  position: track.track_position || index + 1,
  mediumNumber: track.disk_number || null,
  length: track.duration ? track.duration * 1000 : null,
  duration_ms: track.duration ? track.duration * 1000 : null,
  rank: track.rank ?? 0,
  preview_url: track.preview ? deezerPreviewPath(track.id) : null,
});

const artistCache = createDeezerCache<ReturnType<typeof toArtist> | null>(3600);
const relatedArtistCache = createDeezerCache<ReturnType<typeof toRelatedArtist>>(3600);
const topTrackCache = createDeezerCache<ReturnType<typeof toTopTrack>[]>(3600);
const topTrackListCache = createDeezerCache<ReturnType<typeof toTopListTrack>[]>(3600);
const albumCache = createDeezerCache<ReturnType<typeof toAlbum>[]>(3600);
const albumTrackCache = createDeezerCache<ReturnType<typeof toAlbumTrack>[]>(3600);
const previewAlbumCache = createCache<ReturnType<typeof toAlbumTrack>[]>(6 * 3600);
const previewLinkCache = createDeezerCache<string | null>(5 * 60);
const trackSearchCache = createCache<DeezerTrack[]>(10 * 60, 500);

export function clearDeezerCaches() {
  for (const cache of [
    artistCache,
    relatedArtistCache,
    topTrackCache,
    topTrackListCache,
    albumCache,
    albumTrackCache,
    previewAlbumCache,
    previewLinkCache,
    trackSearchCache,
  ])
    cache.flushAll();
}
export const deezerLimiter = createRateLimiter(110);
const deezerPause = createOutagePause("Deezer");

type DeezerRequest = Pick<HttpOptions, "query" | "signal"> & { timeoutMs: number };

async function deezerGet<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  config: DeezerRequest,
) {
  const { data } = await deezerPause.run(() => http.get(`${DEEZER_API_URL}${path}`, config));
  const failure = v.safeParse(deezerErrorSchema, data);
  if (!failure.success) return readOne(schema, data, { service: "Deezer", endpoint: path });
  if (failure.output.error.code === DEEZER_NO_DATA_CODE) return null;
  throw new Error(`Deezer returned an error for ${path}`);
}

async function deezerList<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  config: DeezerRequest,
) {
  const page = await deezerGet(deezerPageSchema, path, config);
  return page ? readMany(schema, page.data, { service: "Deezer", endpoint: path }) : [];
}

export const deezerPreviewPath = (trackId: string | number) => `/api/deezer/preview/${trackId}.mp3`;

export function getDeezerPreviewLink(trackId: string) {
  return previewLinkCache.load(trackId, async () => {
    const track = await deezerGet(deezerTrackSchema, `/track/${trackId}`, { timeoutMs: 3000 });
    return track?.preview || (track && (await findPlayableCopy(track))?.preview) || null;
  });
}

const nameKey = (value: unknown) =>
  normalizeTitle(value) ||
  String(value ?? "")
    .trim()
    .toLowerCase();

const isSameRelease = (candidate: DeezerTrack, track: DeezerTrack) =>
  candidate.title.toLowerCase() === track.title.toLowerCase() &&
  [
    [candidate.artist?.name, track.artist?.name],
    [candidate.album?.title, track.album?.title],
  ].every(([left, right]) => nameKey(left) && nameKey(left) === nameKey(right));

async function findPlayableCopy(track: DeezerTrack) {
  const isrc = track.isrc && /^[A-Z0-9]{12}$/i.test(track.isrc) ? track.isrc : null;
  if (isrc) {
    const byIsrc = await deezerLimiter.schedule(() =>
      deezerGet(deezerTrackSchema, `/track/isrc:${isrc}`, { timeoutMs: 3000 }),
    );
    if (byIsrc?.preview) return byIsrc;
  }
  if (!track.artist?.name) return null;
  const candidates = await deezerLimiter.schedule(() =>
    deezerList(deezerTrackSchema, "/search", {
      query: { q: `${track.artist?.name} ${track.title}`, limit: 10 },
      timeoutMs: 3000,
    }),
  );
  return (
    candidates.find(
      (candidate) =>
        candidate.preview && ((isrc && candidate.isrc === isrc) || isSameRelease(candidate, track)),
    ) ?? null
  );
}

const artistNameKey = (value: unknown) => {
  const name = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return (
    name
      .replace(/^the\s+/, "")
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, "") || name
  );
};

export async function searchDeezerTracks(
  query: string,
  { limit = 10, signal }: { limit?: number; signal?: AbortSignal } = {},
) {
  const cacheKey = `${limit}:${query.trim().toLowerCase()}`;
  const cached = trackSearchCache.get(cacheKey);
  if (cached) return cached;
  const tracks = await deezerLimiter.schedule(
    () =>
      deezerList(deezerTrackSchema, "/search/track", {
        query: { q: query.trim(), limit },
        timeoutMs: 3000,
        signal,
      }),
    { signal, priority: 1 },
  );
  trackSearchCache.set(cacheKey, tracks);
  return tracks;
}

export async function getDeezerArtist(
  artistName: string,
  { throwOnError = false }: { throwOnError?: boolean } = {},
) {
  const wanted = artistNameKey(artistName);
  if (!wanted) return null;
  const cacheKey = `name:${artistName.toLowerCase().trim()}`;

  try {
    return await artistCache.load(cacheKey, async () => {
      const artists = await deezerLimiter.schedule(() =>
        deezerList(deezerArtistSchema, "/search/artist", {
          query: { q: artistName, limit: 10 },
          timeoutMs: 5000,
        }),
      );
      const match = artists.find((artist) => artistNameKey(artist.name) === wanted);
      return match ? toArtist(match) : null;
    });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

export async function getDeezerArtistById(
  artistId: DeezerArtistId,
  { throwOnError = false }: { throwOnError?: boolean } = {},
) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `id:${normalizedId}`;

  try {
    return await artistCache.load(cacheKey, async () => {
      const data = await deezerGet(deezerArtistSchema, `/artist/${normalizedId}`, {
        timeoutMs: 3000,
      });
      return data ? toArtist(data) : null;
    });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

async function getDeezerArtistTopTracksById(artistId: DeezerArtistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];

  return topTrackCache.load(normalizedId, async () => {
    const top = await deezerList(deezerTrackSchema, `/artist/${normalizedId}/top`, {
      query: { limit: 6 },
      timeoutMs: 3000,
    });
    return top
      .filter((track) => track.preview)
      .slice(0, 6)
      .map(toTopTrack);
  });
}

export async function deezerGetRelatedArtists(
  artistId: DeezerArtistId,
  { limit = 25 }: { limit?: number } = {},
) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  return relatedArtistCache.load(`${normalizedId}:${safeLimit}`, async () => {
    const rows = await deezerLimiter.schedule(() =>
      deezerList(deezerArtistSchema, `/artist/${normalizedId}/related`, {
        query: { limit: safeLimit },
        timeoutMs: 5000,
      }),
    );
    return rows.flatMap(toRelatedArtist);
  });
}

export async function deezerGetArtistTopTrackList(
  artistName: string,
  { limit = 25 }: { limit?: number } = {},
) {
  const artist = await getDeezerArtist(artistName, { throwOnError: true });
  if (!artist) return [];
  const artistId = String(artist.id);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  return topTrackListCache.load(`${artistId}:${safeLimit}`, async () => {
    const top = await deezerLimiter.schedule(() =>
      deezerList(deezerTrackSchema, `/artist/${artistId}/top`, {
        query: { limit: safeLimit },
        timeoutMs: 5000,
      }),
    );
    return top
      .filter((track) => track.title.trim())
      .map((track) => toTopListTrack(track, artistName));
  });
}

export async function deezerGetArtistTopTracks(artistName: string) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];
    return await getDeezerArtistTopTracksById(artist.id);
  } catch (e) {
    return [];
  }
}

export async function deezerGetArtistTopTracksById(artistId: DeezerArtistId) {
  try {
    return await getDeezerArtistTopTracksById(artistId);
  } catch {
    return [];
  }
}

export function selectDeezerTrackPreview(
  candidates: v.InferOutput<typeof deezerTrackSchema>[],
  { artistName, trackName }: { artistName: string; trackName: string },
) {
  const targetArtist = normalizeTitle(artistName);
  const targetTrack = normalizeTitle(trackName);
  if (!targetArtist || !targetTrack) return null;
  const mainArtist = normalizeTitle(artistName.split(/,|&|\s(?:feat\.?|ft\.?|with|x)\s/i)[0]);
  const byArtist = (artist: string) =>
    candidates.find((candidate) => {
      const candidateTrack = normalizeTitle(candidate.title_short || candidate.title);
      return (
        candidate.preview &&
        candidateTrack &&
        normalizeTitle(candidate.artist?.name) === artist &&
        (candidateTrack === targetTrack ||
          candidateTrack.includes(targetTrack) ||
          targetTrack.includes(candidateTrack))
      );
    });

  return byArtist(targetArtist) || (mainArtist ? byArtist(mainArtist) : null) || null;
}

export async function deezerGetTrackPreview({
  artistName,
  trackName,
}: {
  artistName: string;
  trackName: string;
}) {
  if (!String(artistName || "").trim() || !String(trackName || "").trim()) return null;
  try {
    const candidates = await deezerList(deezerTrackSchema, "/search", {
      query: { q: `${artistName} ${trackName}`, limit: 10 },
      timeoutMs: 3000,
    });
    const track = selectDeezerTrackPreview(candidates, { artistName, trackName });
    if (!track) return null;
    return {
      preview_url: deezerPreviewPath(track.id),
      previewProvider: "deezer",
      previewTrackId: String(track.id),
      durationMs: track.duration ? track.duration * 1000 : null,
    };
  } catch {
    return null;
  }
}

const EDITION_GROUP =
  /[([](?:deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4})/;
const EDITION_SUFFIX =
  /\s-\s+(?:deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4})[\s\S]*/;

function withoutEditionGroups(title: string) {
  const start = title.search(EDITION_GROUP);
  const end = Math.max(title.lastIndexOf(")"), title.lastIndexOf("]"));
  return start >= 0 && end > start ? title.slice(0, start).trimEnd() + title.slice(end + 1) : title;
}

export function normalizeTitle(title: unknown) {
  return withoutEditionGroups(String(title || "").toLowerCase())
    .replace(EDITION_SUFFIX, "")
    .replace(/[’']/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getReleaseYear(value: unknown) {
  const match = String(value || "").match(/\d{4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function normalizeDeezerPrimaryType(value: unknown) {
  const normalized = String(value || "album").toLowerCase();
  if (normalized === "ep") return "EP";
  if (normalized === "single") return "Single";
  return "Album";
}

function normalizeMbidTrackNumber(value: unknown) {
  const raw = String(value || "").trim();
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackPosition(track: TrackLike) {
  const raw =
    track?.trackPosition ??
    track?.track_position ??
    track?.trackNumber ??
    track?.tracknumber ??
    track?.position;
  const numeric = Number.parseInt(String(raw), 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return normalizeMbidTrackNumber(raw);
}

function getTrackMedium(track: TrackLike) {
  const numeric = Number.parseInt(
    String(track?.mediumNumber ?? track?.mediumnumber ?? track?.disk_number ?? track?.diskNumber),
    10,
  );
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackDurationMs(track: TrackLike) {
  const raw = track?.durationMs ?? track?.duration_ms ?? track?.durationms ?? track?.length ?? null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackTitle(track: TrackLike) {
  return track?.title || track?.trackName || track?.trackname || "";
}

export async function getDeezerAlbumsForArtist(
  artist: { id?: number | string } | null | undefined,
) {
  if (!artist?.id) return [];
  const artistId = artist.id;
  return albumCache.load(String(artistId), async () => {
    const raw = await deezerLimiter.schedule(() =>
      deezerList(deezerAlbumSchema, `/artist/${artistId}/albums`, {
        query: { limit: 100 },
        timeoutMs: 3000,
      }),
    );
    const allowed = ["album", "ep", "single"];
    return raw
      .filter((album) => allowed.includes((album.record_type || "").toLowerCase()))
      .map(toAlbum);
  });
}

export function selectBestDeezerAlbumMatch(
  deezerAlbums: Awaited<ReturnType<typeof getDeezerAlbumsForArtist>>,
  {
    albumTitle = "",
    releaseType = "",
    releaseDate = "",
  }: { albumTitle?: string; releaseType?: string; releaseDate?: string } = {},
) {
  if (!Array.isArray(deezerAlbums) || deezerAlbums.length === 0 || !albumTitle) {
    return null;
  }
  const targetTitle = normalizeTitle(albumTitle);
  const targetType = String(releaseType || "").trim();
  const targetYear = getReleaseYear(releaseDate);

  const ranked = deezerAlbums
    .map((album) => {
      const albumTitle = album._normalizedTitle || normalizeTitle(album.title);
      let score = 0;
      if (albumTitle === targetTitle) {
        score += 100;
      } else if (albumTitle.includes(targetTitle) || targetTitle.includes(albumTitle)) {
        score += 45;
      }

      if (targetType && album["primary-type"] === targetType) {
        score += 20;
      }

      const albumYear = getReleaseYear(album._releaseDate || album["first-release-date"]);
      if (targetYear && albumYear) {
        const distance = Math.abs(targetYear - albumYear);
        if (distance === 0) score += 20;
        else if (distance <= 1) score += 10;
        else if (distance <= 3) score += 3;
      }

      score += Math.min(10, Math.log10(Math.max(1, album.fans || 0) + 1) * 2);
      return { album, score };
    })
    .filter((entry) => entry.score >= 80)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.album || null;
}

export async function resolveDeezerAlbumForPreview({
  artistName = "",
  deezerArtistId = null,
  albumTitle = "",
  releaseType = "",
  releaseDate = "",
}: {
  artistName?: string;
  deezerArtistId?: DeezerArtistId;
  albumTitle?: string;
  releaseType?: string;
  releaseDate?: string;
} = {}) {
  const artist = deezerArtistId
    ? await getDeezerArtistById(deezerArtistId)
    : await getDeezerArtist(artistName);
  if (!artist) return null;

  const albums = await getDeezerAlbumsForArtist(artist);
  return selectBestDeezerAlbumMatch(albums, {
    albumTitle,
    releaseType,
    releaseDate,
  });
}

export function scoreDeezerTrackMatch(track: TrackLike, deezerTrack: TrackLike) {
  const targetTitle = normalizeTitle(getTrackTitle(track));
  const candidateTitle = normalizeTitle(getTrackTitle(deezerTrack));
  const trackPosition = getTrackPosition(track);
  const deezerPosition = getTrackPosition(deezerTrack);
  const trackMedium = getTrackMedium(track);
  const deezerMedium = getTrackMedium(deezerTrack);
  const trackDuration = getTrackDurationMs(track);
  const deezerDuration = getTrackDurationMs(deezerTrack);

  let score = 0;
  if (targetTitle && candidateTitle) {
    if (targetTitle === candidateTitle) {
      score += 70;
    } else if (targetTitle.includes(candidateTitle) || candidateTitle.includes(targetTitle)) {
      score += 35;
    }
  }

  if (trackPosition && deezerPosition && trackPosition === deezerPosition) {
    score += 25;
  }
  if (trackMedium && deezerMedium && trackMedium === deezerMedium) {
    score += 10;
  }
  if (trackDuration && deezerDuration) {
    const diff = Math.abs(trackDuration - deezerDuration);
    if (diff <= 3000) score += 15;
    else if (diff <= 10000) score += 8;
    else if (diff <= 20000) score += 3;
  }

  return score;
}

type Previewed<T> = T & { preview_url?: string; previewProvider?: string; previewTrackId?: string };

export function attachDeezerTrackPreviews<T extends TrackLike>(
  tracks: T[],
  deezerTracks: Awaited<ReturnType<typeof deezerGetAlbumTracks>>,
): Previewed<T>[] {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  if (!Array.isArray(deezerTracks) || deezerTracks.length === 0) return tracks;

  const used = new Set<string>();
  return tracks.map((track) => {
    let best: { track: (typeof deezerTracks)[number]; score: number } | null = null;
    for (const candidate of deezerTracks) {
      if (!candidate?.preview_url || used.has(candidate.id)) continue;
      const score = scoreDeezerTrackMatch(track, candidate);
      if (!best || score > best.score) {
        best = { track: candidate, score };
      }
    }
    if (!best || best.score < 80) return track;
    used.add(best.track.id);
    return {
      ...track,
      preview_url: best.track.preview_url,
      previewProvider: "deezer",
      previewTrackId: best.track.id,
    };
  });
}

export async function deezerGetAlbumTracks(deezerAlbumId: string | number) {
  const id = String(deezerAlbumId).replace(/^dz-/, "");
  if (!id || id === "dz") return [];

  return albumTrackCache
    .load(id, async () => {
      const raw = await deezerLimiter.schedule(() =>
        deezerList(deezerTrackSchema, `/album/${id}/tracks`, { timeoutMs: 3000 }),
      );
      return raw.map(toAlbumTrack);
    })
    .catch(() => []);
}

export async function enrichTracksWithDeezerPreviews<T extends TrackLike>(
  tracks: T[],
  {
    artistName = "",
    deezerArtistId = null,
    deezerAlbumId = null,
    albumTitle = "",
    releaseType = "",
    releaseDate = "",
    cacheKey = "",
  }: {
    artistName?: string;
    deezerArtistId?: DeezerArtistId;
    deezerAlbumId?: string | number | null;
    albumTitle?: string;
    releaseType?: string;
    releaseDate?: string;
    cacheKey?: string;
  } = {},
): Promise<Previewed<T>[]> {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  const normalizedCacheKey =
    cacheKey ||
    `preview:${deezerAlbumId || deezerArtistId || artistName}:${albumTitle}:${releaseType}:${releaseDate}`;
  const cached = previewAlbumCache.get(normalizedCacheKey);
  if (cached) return attachDeezerTrackPreviews(tracks, cached);

  try {
    let resolvedAlbumId = String(deezerAlbumId || "")
      .replace(/^dz-/, "")
      .trim();
    if (!resolvedAlbumId) {
      const album = await resolveDeezerAlbumForPreview({
        artistName,
        deezerArtistId,
        albumTitle,
        releaseType,
        releaseDate,
      });
      resolvedAlbumId = album?.id ? String(album.id) : "";
    }
    if (!resolvedAlbumId) return tracks;

    const deezerTracks = await deezerGetAlbumTracks(resolvedAlbumId);
    previewAlbumCache.set(normalizedCacheKey, deezerTracks);
    return attachDeezerTrackPreviews(tracks, deezerTracks);
  } catch {
    return tracks;
  }
}
