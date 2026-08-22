import { getCanonicalLibraryPage, iterateCanonicalArtistProjection } from "../libraryQueryService.js";
import { libraryManager } from "../libraryManager.js";

const RECENT_RELEASE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function resolveTimeMs(value, fallback = Date.now()) {
  if (value == null) return fallback;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallback;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function resolveDayMs(value) {
  if (value == null) return null;
  const text = String(value || "").trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return Number.isFinite(time) ? time : null;
  }
  const time = resolveTimeMs(value, null);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export async function getRecentMissingReleases(limit = 24, options = {}) {
  const providedArtists =
    Array.isArray(options?.artists) && options.artists.length > 0 ? options.artists : null;
  const providedAlbums = Array.isArray(options?.albums) ? options.albums : null;
  let artists = providedArtists;
  let albums = providedAlbums;
  let canonicalAlbums = false;

  if (!artists && !albums) {
    artists = [...iterateCanonicalArtistProjection({ pageSize: 100 })];
    albums = [];
    canonicalAlbums = true;
    for (let page = 1; ; page += 1) {
      const result = getCanonicalLibraryPage({
        source: "all",
        availableOnly: false,
        kind: "albums",
        page,
        pageSize: 100,
        sort: "newest",
        direction: "desc",
      });
      albums.push(...result.items);
      if (!result.hasMore) break;
    }
  } else if (!artists) {
    artists = [...iterateCanonicalArtistProjection({ pageSize: 100 })];
  } else if (!albums) {
    albums = [];
    canonicalAlbums = true;
    for (let page = 1; ; page += 1) {
      const result = getCanonicalLibraryPage({
        source: "all",
        availableOnly: false,
        kind: "albums",
        page,
        pageSize: 100,
        sort: "newest",
        direction: "desc",
      });
      albums.push(...result.items);
      if (!result.hasMore) break;
    }
  }

  if (!Array.isArray(albums) || albums.length === 0) {
    return [];
  }

  const artistsById = new Map();
  if (Array.isArray(artists)) {
    if (!canonicalAlbums) await libraryManager.backfillLidarrArtistMappings(artists);
    artists.forEach((artist) => {
      if (artist?.id != null) {
        const mappedArtist = canonicalAlbums ? artist : libraryManager.mapLidarrArtist(artist);
        mappedArtist.artistName = mappedArtist.artistName || artist.name || null;
        artistsById.set(artist.id, mappedArtist);
        artistsById.set(String(artist.id), mappedArtist);
      }
    });
  }

  const now = resolveTimeMs(options?.now);
  const recentCutoff = now - RECENT_RELEASE_WINDOW_MS;
  const today = resolveDayMs(now);
  const includeFuture = options?.includeFuture !== false;

  if (canonicalAlbums) {
    return albums
      .map((album) => {
        const artist = artistsById.get(album.artistId) || artistsById.get(String(album.artistId));
        const releaseDate = album.releaseDate || null;
        const releaseTime = new Date(releaseDate).getTime();
        if (!artist || !releaseDate || !Number.isFinite(releaseTime) || releaseTime < recentCutoff) {
          return null;
        }
        const releaseDay = resolveDayMs(releaseDate);
        if (!includeFuture && releaseDay != null && today != null && releaseDay > today) return null;
        if (Number(album.statistics?.trackFileCount || 0) > 0 || Number(album.statistics?.sizeOnDisk || 0) > 0) {
          return null;
        }
        return {
          ...album,
          artistName: artist.artistName || artist.name || null,
          artistMbid: artist.mbid || artist.foreignArtistId || null,
          foreignArtistId: artist.foreignArtistId || artist.mbid || null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => String(right.releaseDate || "").localeCompare(String(left.releaseDate || "")))
      .slice(0, Math.max(1, Math.round(Number(limit) || 24)));
  }

  return albums
    .map((album) => {
      const artist = artistsById.get(album.artistId) || artistsById.get(String(album.artistId));
      if (!artist) return null;
      const mapped = libraryManager.mapLidarrAlbum(album, artist);
      const releaseDate = mapped.releaseDate || album.releaseDate || null;
      if (!releaseDate) return null;
      const releaseTime = new Date(releaseDate).getTime();
      if (!Number.isFinite(releaseTime) || releaseTime < recentCutoff) return null;
      const releaseDay = resolveDayMs(releaseDate);
      if (!includeFuture && releaseDay != null && today != null && releaseDay > today) {
        return null;
      }
      const percent = mapped.statistics?.percentOfTracks || 0;
      const size = mapped.statistics?.sizeOnDisk || 0;
      if (percent > 0 || size > 0) return null;
      return {
        ...mapped,
        artistName: mapped.artistName || artist.artistName || artist.name || null,
        artistMbid: artist.mbid || null,
        foreignArtistId: artist.foreignArtistId || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const dateA = left.releaseDate || "";
      const dateB = right.releaseDate || "";
      return dateB.localeCompare(dateA);
    })
    .slice(0, Math.max(1, Math.round(Number(limit) || 24)));
}
