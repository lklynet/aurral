import axios from "../../../lib/axiosFetch.ts";
import createCache from "./simpleCache.ts";
import createRateLimiter from "./rateLimiter.ts";

interface DeezerArtist {
  id?: number | string;
  name?: string;
  picture_big?: string;
  picture_medium?: string;
  picture?: string;
}

interface DeezerTrack {
  id: number | string;
  title?: string;
  title_short?: string;
  preview?: string;
  duration?: number;
  rank?: number;
  track_position?: number;
  disk_number?: number;
  album?: { title?: string; cover_medium?: string };
  artist?: { name?: string };
}

interface DeezerAlbum {
  id: number | string;
  title?: string;
  record_type?: string;
  type?: string;
  release_date?: string;
  cover_big?: string;
  cover_medium?: string;
  cover?: string;
  fans?: number;
}

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

const isDeezerOutage = (data: { error?: { code?: number } } | null | undefined) =>
  Boolean(data?.error) && data?.error?.code !== 800;

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
    const res = await axios.get(`https://api.deezer.com/track/${trackId}`, { timeout: 3000 });
    if (isDeezerOutage(res.data)) throw new Error("Deezer track unavailable");
    const track: DeezerTrack | null | undefined = res.data;
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
  const cacheKey = `name:${wanted}`;

  try {
    return await cachedOrInflight(deezerArtistCache, cacheKey, deezerInflightRequests, async () => {
      const response = await deezerLimiter.schedule(() =>
        axios.get("https://api.deezer.com/search/artist", {
          params: { q: artistName, limit: 10 },
          timeout: 5000,
        }),
      );
      if (isDeezerOutage(response.data)) throw new Error("Deezer artist search unavailable");
      const match: DeezerArtist | undefined = (response.data?.data || []).find(
        (artist: DeezerArtist) => artist?.id && artistNameKey(artist.name) === wanted,
      );
      const result = match?.id
        ? {
            id: match.id,
            name: match.name,
            imageUrl: match.picture_big || match.picture_medium || match.picture || null,
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
      const res = await axios.get(`https://api.deezer.com/artist/${normalizedId}`, {
        timeout: 3000,
      });
      if (isDeezerOutage(res.data)) throw new Error("Deezer artist unavailable");
      const data: DeezerArtist | null | undefined = res.data;
      if (!data?.id) {
        deezerArtistCache.set(cacheKey, null);
        return null;
      }
      const result = {
        id: data.id,
        name: data.name || null,
        imageUrl: data.picture_big || data.picture_medium || data.picture || null,
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
    const topRes = await axios.get(`https://api.deezer.com/artist/${normalizedId}/top`, {
      params: { limit: 6 },
      timeout: 3000,
    });
    if (topRes.data?.error) throw new Error("Deezer popular tracks unavailable");
    const tracks = (topRes.data?.data || [])
      .filter((track: DeezerTrack) => track.preview)
      .slice(0, 6)
      .map((track: DeezerTrack) => ({
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
      const response = await deezerLimiter.schedule(() =>
        axios.get(`https://api.deezer.com/artist/${artistId}/top`, {
          params: { limit: safeLimit },
          timeout: 5000,
        }),
      );
      if (isDeezerOutage(response.data)) throw new Error("Deezer popular tracks unavailable");
      const tracks = (response.data?.data || [])
        .filter((track: DeezerTrack) => String(track?.title || "").trim())
        .map((track: DeezerTrack) => ({
          name: String(track.title).trim(),
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
  candidates: DeezerTrack[] | null | undefined,
  { artistName, trackName }: { artistName: string; trackName: string },
) {
  const targetArtist = normalizeTitle(artistName);
  const targetTrack = normalizeTitle(trackName);
  if (!targetArtist || !targetTrack) return null;

  return (
    (Array.isArray(candidates) ? candidates : []).find((candidate) => {
      const candidateArtist = normalizeTitle(candidate?.artist?.name);
      const candidateTrack = normalizeTitle(candidate?.title_short || candidate?.title);
      return (
        candidate?.preview &&
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
    const response = await axios.get("https://api.deezer.com/search", {
      params: { q: `${artistName} ${trackName}`, limit: 10 },
      timeout: 3000,
    });
    const track = selectDeezerTrackPreview(response.data?.data, { artistName, trackName });
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
    const res = await axios.get(`https://api.deezer.com/artist/${artist.id}/albums`, {
      params: { limit: 100 },
      timeout: 3000,
    });
    if (res.data?.error) throw new Error("Deezer artist catalog unavailable");
    const raw: DeezerAlbum[] = res.data?.data || [];
    const allowed = ["album", "ep", "single"];
    const albums = raw
      .filter((a) => allowed.includes((a.record_type || a.type || "").toLowerCase()))
      .map((a) => {
        const primaryType = normalizeDeezerPrimaryType(a.record_type || a.type);
        const title = a.title || "";
        const releaseDate = a.release_date || "";
        return {
          id: a.id,
          title,
          "first-release-date": releaseDate ? releaseDate.slice(0, 4) : null,
          "primary-type": primaryType,
          "secondary-types": [],
          _coverUrl: a.cover_big || a.cover_medium || a.cover || null,
          fans: typeof a.fans === "number" ? a.fans : 0,
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
      const res = await axios.get(`https://api.deezer.com/album/${id}/tracks`, {
        timeout: 3000,
      });
      const raw: DeezerTrack[] = res.data?.data || [];
      const tracks = raw.map((t, i) => ({
        id: String(t.id),
        mbid: String(t.id),
        title: t.title || "",
        trackName: t.title || "",
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
