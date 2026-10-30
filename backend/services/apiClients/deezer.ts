import * as v from "valibot";
import axios from "../../../lib/axiosFetch.ts";
import { readMany, readOne } from "../integrationData.ts";
import createCache from "./simpleCache.ts";
import createRateLimiter from "./rateLimiter.ts";

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
  picture_xl: v.optional(v.string()),
  picture_big: v.optional(v.string()),
  picture_medium: v.optional(v.string()),
  nb_fan: v.optional(v.number()),
});

export const deezerTrackSchema = v.looseObject({
  id: v.number(),
  title: v.string(),
  title_short: v.optional(v.string()),
  preview: v.optional(v.string()),
  duration: v.optional(v.number()),
  rank: v.optional(v.number()),
  track_position: v.optional(v.number()),
  disk_number: v.optional(v.number()),
  artist: v.optional(v.looseObject({ name: v.optional(v.string()) })),
  album: v.optional(
    v.looseObject({
      id: v.optional(v.number()),
      title: v.optional(v.string()),
      cover_medium: v.optional(v.string()),
      cover_xl: v.optional(v.string()),
    }),
  ),
});

const deezerAlbumSchema = v.looseObject({
  id: v.number(),
  title: v.optional(v.string()),
  record_type: v.optional(v.string()),
  release_date: v.optional(v.string()),
  cover_xl: v.optional(v.string()),
  cover_big: v.optional(v.string()),
  cover_medium: v.optional(v.string()),
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

const deezerArtistCache = createCache(3600);

const deezerAlbumCache = createCache(3600);
const deezerAlbumTrackCache = createCache(3600);
const deezerPreviewMatchCache = createCache(6 * 3600);
const deezerTopTrackCache = createCache(3600);
const deezerPreviewLinkCache = createCache(5 * 60);
const deezerInflightRequests = new Map();
const deezerLimiter = createRateLimiter(110);

async function deezerGet<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  config: { params?: Record<string, string | number>; timeout: number },
) {
  const { data } = await axios.get(`${DEEZER_API_URL}${path}`, config);
  const failure = v.safeParse(deezerErrorSchema, data);
  if (!failure.success) return readOne(schema, data, { service: "Deezer", endpoint: path });
  if (failure.output.error.code === DEEZER_NO_DATA_CODE) return null;
  throw new Error(`Deezer returned an error for ${path}`);
}

async function deezerList<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  config: { params?: Record<string, string | number>; timeout: number },
) {
  const page = await deezerGet(deezerPageSchema, path, config);
  return page ? readMany(schema, page.data, { service: "Deezer", endpoint: path }) : [];
}

const deezerArtistPhoto = (artist: v.InferOutput<typeof deezerArtistSchema>) => {
  const url = artist.picture_xl || artist.picture_big || artist.picture_medium;
  return url && !url.includes("/images/artist//") ? url : null;
};

async function cachedOrInflight<T>(
  cache: ReturnType<typeof createCache>,
  key: string,
  inflight: Map<string, Promise<T>>,
  fn: () => Promise<T>,
): Promise<T> {
  const cached: T | undefined = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fn();
  inflight.set(key, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    inflight.delete(key);
  }
}

export const deezerPreviewPath = (trackId: string | number) => `/api/deezer/preview/${trackId}.mp3`;

export async function getDeezerPreviewLink(trackId: string): Promise<string | null> {
  const cacheKey = `dz-preview:${trackId}`;
  return cachedOrInflight(deezerPreviewLinkCache, cacheKey, deezerInflightRequests, async () => {
    const track = await deezerGet(deezerTrackSchema, `/track/${trackId}`, { timeout: 3000 });
    const link = track?.preview || null;
    deezerPreviewLinkCache.set(cacheKey, link);
    return link;
  });
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

export async function getDeezerArtist(
  artistName: string,
  { throwOnError = false }: { throwOnError?: boolean } = {},
) {
  const wanted = artistNameKey(artistName);
  if (!wanted) return null;
  const cacheKey = `name:${artistName.toLowerCase().trim()}`;

  try {
    return await cachedOrInflight(deezerArtistCache, cacheKey, deezerInflightRequests, async () => {
      const artists = await deezerLimiter.schedule(() =>
        deezerList(deezerArtistSchema, "/search/artist", {
          params: { q: artistName, limit: 10 },
          timeout: 5000,
        }),
      );
      const match = artists.find((artist) => artistNameKey(artist.name) === wanted);
      const result = match
        ? {
            id: match.id,
            name: match.name,
            imageUrl: deezerArtistPhoto(match),
          }
        : null;
      deezerArtistCache.set(cacheKey, result);
      return result;
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
    return await cachedOrInflight(deezerArtistCache, cacheKey, deezerInflightRequests, async () => {
      const data = await deezerGet(deezerArtistSchema, `/artist/${normalizedId}`, {
        timeout: 3000,
      });
      if (!data) {
        deezerArtistCache.set(cacheKey, null);
        return null;
      }
      const result = {
        id: data.id,
        name: data.name || null,
        imageUrl: deezerArtistPhoto(data),
      };
      deezerArtistCache.set(cacheKey, result);
      return result;
    });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

async function getDeezerArtistTopTracksById(artistId: DeezerArtistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  const cacheKey = `dz-top:${normalizedId}`;

  return cachedOrInflight(deezerTopTrackCache, cacheKey, deezerInflightRequests, async () => {
    const top = await deezerList(deezerTrackSchema, `/artist/${normalizedId}/top`, {
      params: { limit: 6 },
      timeout: 3000,
    });
    const tracks = top
      .filter((track) => track.preview)
      .slice(0, 6)
      .map((track) => ({
        id: String(track.id),
        title: track.title,
        album: track.album?.title ?? null,
        artworkUrl: track.album?.cover_medium ?? null,
        preview_url: deezerPreviewPath(track.id),
        duration_ms: (track.duration || 0) * 1000,
      }));
    deezerTopTrackCache.set(cacheKey, tracks);
    return tracks;
  });
}

export async function deezerGetRelatedArtists(
  artistId: DeezerArtistId,
  { limit = 25 }: { limit?: number } = {},
) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const cacheKey = `related:${normalizedId}:${safeLimit}`;
  return cachedOrInflight(deezerArtistCache, cacheKey, deezerInflightRequests, async () => {
    const rows = await deezerLimiter.schedule(() =>
      deezerList(deezerArtistSchema, `/artist/${normalizedId}/related`, {
        params: { limit: safeLimit },
        timeout: 5000,
      }),
    );
    const artists = rows.flatMap((artist) =>
      artist.name?.trim()
        ? [
            {
              name: artist.name.trim(),
              image: deezerArtistPhoto(artist),
            },
          ]
        : [],
    );
    deezerArtistCache.set(cacheKey, artists);
    return artists;
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
  return cachedOrInflight(
    deezerTopTrackCache,
    `dz-list:${artistId}:${safeLimit}`,
    deezerInflightRequests,
    async () => {
      const top = await deezerLimiter.schedule(() =>
        deezerList(deezerTrackSchema, `/artist/${artistId}/top`, {
          params: { limit: safeLimit },
          timeout: 5000,
        }),
      );
      const tracks = top
        .filter((track) => track.title.trim())
        .map((track) => ({
          name: track.title.trim(),
          albumName: String(track.album?.title || "").trim() || null,
          mbid: null,
          durationMs: track.duration ? track.duration * 1000 : null,
          popularity: Number(track.rank) || 0,
        }));
      deezerTopTrackCache.set(`dz-list:${artistId}:${safeLimit}`, tracks);
      return tracks;
    },
  );
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

  return (
    candidates.find((candidate) => {
      const candidateArtist = normalizeTitle(candidate.artist?.name);
      const candidateTrack = normalizeTitle(candidate.title_short || candidate.title);
      return (
        candidate.preview &&
        candidateTrack &&
        candidateArtist === targetArtist &&
        (candidateTrack === targetTrack ||
          candidateTrack.includes(targetTrack) ||
          targetTrack.includes(candidateTrack))
      );
    }) || null
  );
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
      params: { q: `${artistName} ${trackName}`, limit: 10 },
      timeout: 3000,
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
  const cacheKey = `dz-albums:${artist.id}`;
  return cachedOrInflight(deezerAlbumCache, cacheKey, deezerInflightRequests, async () => {
    const raw = await deezerList(deezerAlbumSchema, `/artist/${artist.id}/albums`, {
      params: { limit: 100 },
      timeout: 3000,
    });
    const allowed = ["album", "ep", "single"];
    const albums = raw
      .filter((a) => allowed.includes((a.record_type || "").toLowerCase()))
      .map((a) => {
        const primaryType = normalizeDeezerPrimaryType(a.record_type);
        const title = a.title || "";
        const releaseDate = a.release_date || "";
        return {
          id: a.id,
          title,
          "first-release-date": releaseDate ? releaseDate.slice(0, 4) : null,
          "primary-type": primaryType,
          "secondary-types": [],
          _coverUrl: a.cover_xl || a.cover_big || a.cover_medium || null,
          fans: a.fans ?? 0,
          _normalizedTitle: normalizeTitle(title),
          _releaseDate: releaseDate,
        };
      });

    deezerAlbumCache.set(cacheKey, albums);
    return albums;
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

export function attachDeezerTrackPreviews<T extends TrackLike>(
  tracks: T[],
  deezerTracks: Awaited<ReturnType<typeof deezerGetAlbumTracks>>,
) {
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
  const cacheKey = `dz-tracks:${id}`;

  return cachedOrInflight(deezerAlbumTrackCache, cacheKey, deezerInflightRequests, async () => {
    try {
      const raw = await deezerList(deezerTrackSchema, `/album/${id}/tracks`, { timeout: 3000 });
      const tracks = raw.map((t, i) => ({
        id: String(t.id),
        mbid: String(t.id),
        title: t.title,
        trackName: t.title,
        trackNumber: t.track_position || i + 1,
        position: t.track_position || i + 1,
        mediumNumber: t.disk_number || null,
        length: t.duration ? t.duration * 1000 : null,
        duration_ms: t.duration ? t.duration * 1000 : null,
        preview_url: t.preview ? deezerPreviewPath(t.id) : null,
      }));
      deezerAlbumTrackCache.set(cacheKey, tracks);
      return tracks;
    } catch (e) {
      return [];
    }
  });
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
) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  const normalizedCacheKey =
    cacheKey ||
    `preview:${deezerAlbumId || deezerArtistId || artistName}:${albumTitle}:${releaseType}:${releaseDate}`;
  const cached = deezerPreviewMatchCache.get(normalizedCacheKey);
  if (cached) return cached;

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
    const enriched = attachDeezerTrackPreviews(tracks, deezerTracks);
    deezerPreviewMatchCache.set(normalizedCacheKey, enriched);
    return enriched;
  } catch {
    return tracks;
  }
}

export {
  deezerAlbumCache,
  deezerAlbumTrackCache,
  deezerPreviewMatchCache,
  deezerArtistCache,
  deezerTopTrackCache,
};
