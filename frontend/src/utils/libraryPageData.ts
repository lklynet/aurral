import { queryClient, queryKeys } from "../queryClient.ts";
import { getPlaylistTrackStreamUrl } from "./api/endpoints/playlists.ts";
import type {
  LibraryAlbum as BackendLibraryAlbum,
  LibraryArtist as BackendLibraryArtist,
  LibraryGenre,
  LibraryTrack as BackendLibraryTrack,
  LibraryTrackFile as BackendLibraryTrackFile,
} from "../../../backend/services/libraryQueryService.ts";

interface LibraryArtworkFields {
  userFavorite?: boolean;
  coverUrl?: string | null;
  defaultCoverUrl?: string | null;
  customArtworkUrl?: string | null;
  artworkUrl?: string | null;
}

export type LibraryArtist = BackendLibraryArtist & LibraryArtworkFields;
export type LibraryAlbum = BackendLibraryAlbum & LibraryArtworkFields;
type LibraryTrackFile = Omit<BackendLibraryTrackFile, "path"> & { previewUrl?: string };
export type LibraryTrack = Omit<BackendLibraryTrack, "files"> &
  LibraryArtworkFields & { files: LibraryTrackFile[] };

interface LibraryData {
  artists: LibraryArtist[];
  albums: LibraryAlbum[];
  tracks: LibraryTrack[];
  genres: LibraryGenre[];
}

const text = (value: unknown) => String(value || "").trim();

export const getAlbumCoverId = (album: LibraryAlbum | null | undefined) =>
  album?.releaseGroupMbid || album?.mbid || null;

export const favoriteId = (
  kind: string,
  entity: { id?: unknown; identityKey?: unknown } | null | undefined,
) => {
  const id = text(entity?.id);
  if (kind === "song" && /^(flow|shared)-song:/.test(id)) return id;
  // Keep `:` readable, as the backend's `idFor` does, so ids from the
  // favorites endpoint match.
  return kind + ":" + encodeURIComponent(text(entity?.identityKey)).replaceAll("%3A", ":");
};

export const firstAvailableFile = (
  track: LibraryTrack | null | undefined,
  albumId: string | number | null = null,
) =>
  (track?.files || []).find((file) => file.available && file.albumId === albumId) ||
  (track?.files || []).find((file) => file.available && file.albumId == null) ||
  (albumId == null ? (track?.files || []).find((file) => file.available) : null) ||
  null;

export const EMPTY_LIBRARY: LibraryData = { artists: [], albums: [], tracks: [], genres: [] };

const appendMissing = <Entity extends { id: string | number }>(
  target: Entity[],
  incoming: Entity[] | undefined,
) => {
  (Array.isArray(incoming) ? incoming : []).forEach((entity) => {
    if (!target.some((candidate) => String(candidate.id) === String(entity.id))) {
      target.push(entity);
    }
  });
};

export const normalizeLibraryPages = (pages: Partial<LibraryData>[]) =>
  pages.reduce<LibraryData>(
    (result, page) => {
      appendMissing(result.artists, page?.artists);
      appendMissing(result.albums, page?.albums);
      appendMissing(result.tracks, page?.tracks);
      if (Array.isArray(page?.genres) && page.genres.length > result.genres.length) {
        result.genres = page.genres;
      }
      return result;
    },
    { artists: [], albums: [], tracks: [], genres: [] },
  );

export const favoriteLibraryFromResponse = (
  favorites:
    | {
        library?: Partial<LibraryData> | null;
        song?:
          | {
              id: string;
              title?: unknown;
              artist?: unknown;
              album?: unknown;
              duration?: unknown;
              suffix?: unknown;
            }[]
          | null;
      }
    | null
    | undefined,
) => {
  const library = normalizeLibraryPages([favorites?.library || EMPTY_LIBRARY]);
  const playlistTracks = (Array.isArray(favorites?.song) ? favorites.song : [])
    .filter((track) => /^(flow|shared)-song:/.test(text(track?.id)))
    .map((track) => {
      const jobId = decodeURIComponent(track.id.slice(track.id.indexOf(":") + 1))
        .split(":")
        .at(-1);
      const durationMs = Number(track.duration) > 0 ? Number(track.duration) * 1000 : null;
      return {
        id: track.id,
        identityKey: track.id,
        title: track.title,
        artistName: track.artist,
        albumName: track.album,
        durationMs,
        albums: [],
        files: [
          {
            available: true,
            previewUrl: getPlaylistTrackStreamUrl(jobId!),
            format: track.suffix || null,
            durationMs,
          },
        ],
      };
    });
  return playlistTracks.length
    ? { ...library, tracks: [...library.tracks, ...playlistTracks] }
    : library;
};

export const mergeAlbumTrackPageIntoLibrary = (
  current: LibraryData,
  page: Partial<LibraryData> | null | undefined,
  albumId: string | number,
  tracks: LibraryTrack[],
) => {
  const merge = <Kind extends "artists" | "albums" | "tracks">(kind: Kind): LibraryData[Kind] => {
    const existing = current[kind] || [];
    const merged = [...existing, ...(Array.isArray(page?.[kind]) ? page[kind] : [])].filter(
      (entity, index, values) =>
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
    if (entity.trackCount === tracks.length && entity.availableTrackCount === availableTrackCount) {
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

export const getCachedAlbumTracks = (
  album: LibraryAlbum | null | undefined,
  tracksById: Map<string, LibraryTrack>,
) => {
  const queryKey = queryKeys.libraryAlbumTracks(String(album?.id), album?.releaseGroupMbid);
  const cached = queryClient.getQueryState(queryKey)?.isInvalidated
    ? null
    : queryClient.getQueryData<{ tracks: LibraryTrack[] }>(queryKey)?.tracks;
  return cached || album?.trackIds?.map((id) => tracksById.get(String(id))).filter(Boolean) || [];
};

export const yearOf = (value: string | null | undefined) =>
  /^(\d{4})/.exec(String(value || "").trim())?.[1] || "";

const RELEASE_TYPES: Partial<Record<string, string>> = {
  single: "Single",
  ep: "EP",
  broadcast: "Broadcast",
};

export const releaseTypeOf = (album: LibraryAlbum | null | undefined) => {
  const metadata = album?.metadata || {};
  const type = metadata.albumType || metadata.releaseType || [metadata.tags?.releasetype].flat()[0];
  return (
    RELEASE_TYPES[
      String(type || "")
        .trim()
        .toLowerCase()
    ] || null
  );
};

export const albumCardMeta = (
  album: LibraryAlbum | null | undefined,
  { available, total }: { available: number; total?: number | null },
) => {
  const partial = Boolean(total && available < total);
  const unit = total === 1 ? "track" : "tracks";
  return {
    details: [releaseTypeOf(album), yearOf(album?.releaseDate)].filter(Boolean).join(" · "),
    count: partial ? `${available}/${total} ${unit}` : `${total || 0} ${unit}`,
    partial,
  };
};
