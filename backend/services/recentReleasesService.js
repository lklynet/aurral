import { libraryManager } from "./libraryManager.js";

const RECENT_RELEASE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export async function getRecentMissingReleases(limit = 24, options = {}) {
  const { lidarrClient } = await import("./lidarrClient.js");
  if (!lidarrClient.isConfigured()) {
    return [];
  }

  const providedArtists =
    Array.isArray(options?.artists) && options.artists.length > 0
      ? options.artists
      : null;
  const providedAlbums = Array.isArray(options?.albums) ? options.albums : null;
  let artists = providedArtists;
  let albums = providedAlbums;

  if (!artists && !albums) {
    [artists, albums] = await Promise.all([
      lidarrClient.request("/artist"),
      lidarrClient.request("/album"),
    ]);
  } else if (!artists) {
    artists = await lidarrClient.request("/artist");
  } else if (!albums) {
    albums = await lidarrClient.request("/album");
  }

  if (!Array.isArray(albums) || albums.length === 0) {
    return [];
  }

  const artistsById = new Map();
  if (Array.isArray(artists)) {
    artists.forEach((artist) => {
      if (artist?.id != null) {
        artistsById.set(artist.id, artist);
        artistsById.set(String(artist.id), artist);
      }
    });
  }

  const now = Date.now();
  const recentCutoff = now - RECENT_RELEASE_WINDOW_MS;

  return albums
    .map((album) => {
      const artist =
        artistsById.get(album.artistId) || artistsById.get(String(album.artistId));
      if (!artist) return null;
      const mapped = libraryManager.mapLidarrAlbum(album, artist);
      const releaseDate = mapped.releaseDate || album.releaseDate || null;
      if (!releaseDate) return null;
      const releaseTime = new Date(releaseDate).getTime();
      if (!releaseTime || releaseTime < recentCutoff) return null;
      const percent = mapped.statistics?.percentOfTracks || 0;
      const size = mapped.statistics?.sizeOnDisk || 0;
      if (percent > 0 || size > 0) return null;
      return {
        ...mapped,
        artistName:
          mapped.artistName || artist.artistName || artist.name || null,
        artistMbid: artist.foreignArtistId || artist.mbid || null,
        foreignArtistId: artist.foreignArtistId || artist.mbid || null,
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
