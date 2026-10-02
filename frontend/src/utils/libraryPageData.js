import { queryClient, queryKeys } from "../queryClient.js";
import { getFlowTrackStreamUrl } from "./api/endpoints/playlists.js";

const text = (value) => String(value || "").trim();

export const getAlbumCoverId = (album) => album?.releaseGroupMbid || album?.mbid || null;

export const favoriteId = (kind, entity) => {
  const id = text(entity?.id);
  if (kind === "song" && /^(flow|shared)-song:/.test(id)) return id;
  // Keep `:` readable, as the backend's `idFor` does, so ids from the
  // favorites endpoint match.
  return kind + ":" + encodeURIComponent(text(entity?.identityKey)).replaceAll("%3A", ":");
};

export const firstAvailableFile = (track, albumId = null) =>
  (track?.files || []).find((file) => file.available && file.albumId === albumId)
  || (track?.files || []).find((file) => file.available && file.albumId == null)
  || (albumId == null ? (track?.files || []).find((file) => file.available) : null)
  || null;

export const EMPTY_LIBRARY = { artists: [], albums: [], tracks: [], genres: [] };

export const normalizeLibraryPages = (pages) => pages.reduce(
  (result, page) => {
    ["artists", "albums", "tracks"].forEach((kind) => {
      (Array.isArray(page?.[kind]) ? page[kind] : []).forEach((entity) => {
        if (!result[kind].some((candidate) => String(candidate.id) === String(entity.id))) {
          result[kind].push(entity);
        }
      });
    });
    if (Array.isArray(page?.genres) && page.genres.length > result.genres.length) {
      result.genres = page.genres;
    }
    return result;
  },
  { artists: [], albums: [], tracks: [], genres: [] },
);

export const favoriteLibraryFromResponse = (favorites) => {
  const library = normalizeLibraryPages([favorites?.library || EMPTY_LIBRARY]);
  const playlistTracks = (Array.isArray(favorites?.song) ? favorites.song : [])
    .filter((track) => /^(flow|shared)-song:/.test(text(track?.id)))
    .map((track) => {
      const jobId = decodeURIComponent(track.id.slice(track.id.indexOf(":") + 1)).split(":").at(-1);
      const durationMs = Number(track.duration) > 0 ? Number(track.duration) * 1000 : null;
      return {
        id: track.id,
        identityKey: track.id,
        title: track.title,
        artistName: track.artist,
        albumName: track.album,
        durationMs,
        albums: [],
        files: [{
          available: true,
          previewUrl: getFlowTrackStreamUrl(jobId),
          format: track.suffix || null,
          durationMs,
        }],
      };
    });
  return playlistTracks.length
    ? { ...library, tracks: [...library.tracks, ...playlistTracks] }
    : library;
};

export const mergeAlbumTrackPageIntoLibrary = (current, page, albumId, tracks) => {
  const merge = (kind) => {
    const existing = current[kind] || [];
    const merged = [
      ...existing,
      ...(Array.isArray(page?.[kind]) ? page[kind] : []),
    ].filter((entity, index, values) =>
      values.findIndex((candidate) => String(candidate.id) === String(entity.id)) === index,
    );
    return merged.length === existing.length &&
      merged.every((entity, index) => entity === existing[index])
      ? existing
      : merged;
  };
  const artists = merge("artists");
  const mergedAlbums = merge("albums");
  const availableTrackCount = tracks.filter((track) => firstAvailableFile(track)).length;
  let albumsChanged = mergedAlbums !== current.albums;
  const albums = mergedAlbums.map((entity) => {
    if (String(entity.id) !== String(albumId)) return entity;
    if (
      entity.trackCount === tracks.length &&
      entity.availableTrackCount === availableTrackCount
    ) {
      return entity;
    }
    albumsChanged = true;
    return {
      ...entity,
      trackCount: tracks.length,
      availableTrackCount,
    };
  });
  const nextTracks = merge("tracks");
  if (artists === current.artists && !albumsChanged && nextTracks === current.tracks) {
    return current;
  }
  return {
    ...current,
    artists,
    albums,
    tracks: nextTracks,
  };
};

export const getCachedAlbumTracks = (album, tracksById) => {
  const queryKey = queryKeys.libraryAlbumTracks(String(album?.id), album?.releaseGroupMbid);
  const cached = queryClient.getQueryState(queryKey)?.isInvalidated
    ? null
    : queryClient.getQueryData(queryKey)?.tracks;
  return cached || album?.trackIds?.map((id) => tracksById.get(String(id))).filter(Boolean) || [];
};
