import axios from "../../../lib/axiosFetch.js";
import createCache from "./simpleCache.js";

const deezerArtistCache = createCache(3600);

const deezerAlbumCache = createCache(3600);
const deezerAlbumTrackCache = createCache(3600);
const deezerPreviewMatchCache = createCache(6 * 3600);
const deezerTopTrackCache = createCache(3600);
const deezerInflightRequests = new Map();

async function cachedOrInflight(cache, key, inflight, fn) {
  const cached = cache.get(key);
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

export async function getDeezerArtist(artistName) {
  const normalizedName = artistName.toLowerCase().trim();

  return cachedOrInflight(deezerArtistCache, normalizedName, deezerInflightRequests, async () => {
    try {
      const searchRes = await axios.get("https://api.deezer.com/search/artist", {
        params: { q: artistName, limit: 5 },
        timeout: 3000,
      });
      const artists = searchRes.data?.data;
      if (!artists?.length) {
        deezerArtistCache.set(normalizedName, null);
        return null;
      }

      const searchLower = normalizedName.replace(/^the\s+/i, "");
      let bestMatch = null;

      for (const a of artists) {
        if (!a?.id) continue;
        const aNameLower = (a.name || "").toLowerCase().replace(/^the\s+/i, "");
        if (aNameLower === searchLower || aNameLower === normalizedName) {
          bestMatch = a;
          break;
        }
        if (!bestMatch && aNameLower.includes(searchLower)) {
          bestMatch = a;
        }
      }

      if (!bestMatch) {
        bestMatch = artists[0];
      }

      if (!bestMatch?.id) {
        deezerArtistCache.set(normalizedName, null);
        return null;
      }

      const result = {
        id: bestMatch.id,
        name: bestMatch.name,
        imageUrl:
          bestMatch.picture_big ||
          bestMatch.picture_medium ||
          bestMatch.picture ||
          null,
      };
      deezerArtistCache.set(normalizedName, result);
      return result;
    } catch (e) {
      return null;
    }
  });
}

export async function getDeezerArtistById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `id:${normalizedId}`;

  return cachedOrInflight(deezerArtistCache, cacheKey, deezerInflightRequests, async () => {
    try {
      const res = await axios.get(
        `https://api.deezer.com/artist/${normalizedId}`,
        {
          timeout: 3000,
        },
      );
      const data = res.data;
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
    } catch (e) {
      deezerArtistCache.set(cacheKey, null);
      return null;
    }
  });
}

async function getDeezerArtistTopTracksById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  const cacheKey = `dz-top:${normalizedId}`;

  return cachedOrInflight(
    deezerTopTrackCache,
    cacheKey,
    deezerInflightRequests,
    async () => {
      try {
        const topRes = await axios.get(
          `https://api.deezer.com/artist/${normalizedId}/top`,
          { params: { limit: 5 }, timeout: 3000 },
        );
        const tracks = (topRes.data?.data || [])
          .filter((track) => track.preview)
          .slice(0, 5)
          .map((track) => ({
            id: String(track.id),
            title: track.title,
            album: track.album?.title ?? null,
            preview_url: track.preview,
            duration_ms: (track.duration || 0) * 1000,
          }));
        deezerTopTrackCache.set(cacheKey, tracks);
        return tracks;
      } catch (error) {
        return [];
      }
    },
  );
}

export async function deezerGetArtistTopTracks(artistName) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];
    return getDeezerArtistTopTracksById(artist.id);
  } catch (e) {
    return [];
  }
}

export async function deezerGetArtistTopTracksById(artistId) {
  return getDeezerArtistTopTracksById(artistId);
}

export function selectDeezerTrackPreview(candidates, { artistName, trackName }) {
  const targetArtist = normalizeTitle(artistName);
  const targetTrack = normalizeTitle(trackName);
  if (!targetArtist || !targetTrack) return null;

  return (Array.isArray(candidates) ? candidates : []).find((candidate) => {
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
  }) || null;
}

export async function deezerGetTrackPreview({ artistName, trackName }) {
  if (!String(artistName || "").trim() || !String(trackName || "").trim()) return null;
  try {
    const response = await axios.get("https://api.deezer.com/search", {
      params: { q: `${artistName} ${trackName}`, limit: 10 },
      timeout: 3000,
    });
    const track = selectDeezerTrackPreview(response.data?.data, { artistName, trackName });
    if (!track) return null;
    return {
      preview_url: track.preview,
      previewProvider: "deezer",
      previewTrackId: String(track.id),
      durationMs: track.duration ? track.duration * 1000 : null,
    };
  } catch {
    return null;
  }
}

export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(
      /\s*[\(\[](deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4}).*[\)\]]/gi,
      "",
    )
    .replace(
      /\s+-\s+(deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4}).*$/gi,
      "",
    )
    .replace(/[’']/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getReleaseYear(value) {
  const match = String(value || "").match(/\d{4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function normalizeDeezerPrimaryType(value) {
  const normalized = String(value || "album").toLowerCase();
  if (normalized === "ep") return "EP";
  if (normalized === "single") return "Single";
  return "Album";
}

function normalizeMbidTrackNumber(value) {
  const raw = String(value || "").trim();
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackPosition(track) {
  const raw =
    track?.trackPosition ??
    track?.track_position ??
    track?.trackNumber ??
    track?.tracknumber ??
    track?.position;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return normalizeMbidTrackNumber(raw);
}

function getTrackMedium(track) {
  const numeric = Number.parseInt(
    track?.mediumNumber ??
      track?.mediumnumber ??
      track?.disk_number ??
      track?.diskNumber,
    10,
  );
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackDurationMs(track) {
  const raw =
    track?.durationMs ??
    track?.duration_ms ??
    track?.durationms ??
    track?.length ??
    null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackTitle(track) {
  return track?.title || track?.trackName || track?.trackname || "";
}

export async function getDeezerAlbumsForArtist(artist) {
  if (!artist?.id) return [];
  const cacheKey = `dz-albums:${artist.id}`;
  return cachedOrInflight(deezerAlbumCache, cacheKey, deezerInflightRequests, async () => {
    const res = await axios.get(
      `https://api.deezer.com/artist/${artist.id}/albums`,
      { params: { limit: 100 }, timeout: 3000 },
    );
    const raw = res.data?.data || [];
    const allowed = ["album", "ep", "single"];
    const albums = raw
      .filter((a) =>
        allowed.includes((a.record_type || a.type || "").toLowerCase()),
      )
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
  deezerAlbums,
  { albumTitle = "", releaseType = "", releaseDate = "" } = {},
) {
  if (
    !Array.isArray(deezerAlbums) ||
    deezerAlbums.length === 0 ||
    !albumTitle
  ) {
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
      } else if (
        albumTitle.includes(targetTitle) ||
        targetTitle.includes(albumTitle)
      ) {
        score += 45;
      }

      if (targetType && album["primary-type"] === targetType) {
        score += 20;
      }

      const albumYear = getReleaseYear(
        album._releaseDate || album["first-release-date"],
      );
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

export function scoreDeezerTrackMatch(track, deezerTrack) {
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
    } else if (
      targetTitle.includes(candidateTitle) ||
      candidateTitle.includes(targetTitle)
    ) {
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

export function attachDeezerTrackPreviews(tracks, deezerTracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  if (!Array.isArray(deezerTracks) || deezerTracks.length === 0) return tracks;

  const used = new Set();
  return tracks.map((track) => {
    let best = null;
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

export async function deezerGetAlbumTracks(deezerAlbumId) {
  const id = String(deezerAlbumId).replace(/^dz-/, "");
  if (!id || id === "dz") return [];
  const cacheKey = `dz-tracks:${id}`;

  return cachedOrInflight(deezerAlbumTrackCache, cacheKey, deezerInflightRequests, async () => {
    try {
      const res = await axios.get(`https://api.deezer.com/album/${id}/tracks`, {
        timeout: 3000,
      });
      const raw = res.data?.data || [];
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
        preview_url: t.preview || null,
      }));
      deezerAlbumTrackCache.set(cacheKey, tracks);
      return tracks;
    } catch (e) {
      return [];
    }
  });
}

export async function enrichTracksWithDeezerPreviews(
  tracks,
  {
    artistName = "",
    deezerArtistId = null,
    deezerAlbumId = null,
    albumTitle = "",
    releaseType = "",
    releaseDate = "",
    cacheKey = "",
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
