import { buildCustomArtworkUrl, getCustomArtworkMap } from "./customArtworkService.ts";
import { buildLibraryArtworkUrl, getLibraryArtworkVersions } from "./libraryArtwork.ts";
import type { getLibrary, getLibraryPage, LibraryArtist } from "./libraryQueryService.ts";

const isFilesystemPathKey = (key: string) => key.toLowerCase().endsWith("path");

type FilesystemPathless<T> = T extends readonly (infer U)[]
  ? FilesystemPathless<U>[]
  : T extends object
    ? {
        [
          K in keyof T as K extends string ? (Lowercase<K> extends `${string}path` ? never : K) : K
        ]: FilesystemPathless<T[K]>;
      }
    : T;

export function stripFilesystemPaths<T>(value: T): FilesystemPathless<T>;
export function stripFilesystemPaths(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown): unknown => stripFilesystemPaths(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isFilesystemPathKey(key))
      .map(([key, entry]) => [key, stripFilesystemPaths(entry)]),
  );
}

const publicEntity = <T extends { identityKey: string }>(
  kind: string,
  entity: T,
  favoriteKeys: Set<string> | null,
): T & { userFavorite?: boolean } =>
  favoriteKeys
    ? { ...entity, userFavorite: favoriteKeys.has(`${kind}:${entity.identityKey}`) }
    : { ...entity };

const summaryMetadata = <M extends Record<string, unknown>>(metadata: M | null) => {
  if (!metadata) return null;
  const { trackList, tags, ...rest } = metadata;
  if (!tags || typeof tags !== "object") return rest;
  return {
    ...rest,
    tags: {
      ...("genre" in tags && { genre: tags.genre }),
      ...("releasetype" in tags && { releasetype: tags.releasetype }),
    },
  };
};

const publicAlbum = (
  album: LibraryCollections["albums"][number],
  favoriteKeys: Set<string> | null,
  customArtwork: number | undefined,
  artworkVersion: string | undefined,
) => {
  const defaultCoverUrl = buildLibraryArtworkUrl("album", album.id, artworkVersion);
  const customArtworkUrl = customArtwork
    ? buildCustomArtworkUrl("album", album.id, customArtwork)
    : null;
  return {
    ...album,
    metadata: summaryMetadata(album.metadata),
    coverUrl: customArtworkUrl ?? defaultCoverUrl,
    ...(customArtworkUrl && { defaultCoverUrl, customArtworkUrl }),
    ...(favoriteKeys && { userFavorite: favoriteKeys.has(`album:${album.identityKey}`) }),
  };
};

export function buildPublicLibrary(
  library: LibraryCollections,
  favoriteKeys: Set<string> | null = null,
) {
  const albumArtwork = getCustomArtworkMap(
    "album",
    library.albums.map((album) => album.id),
  );
  const trackArtwork = getCustomArtworkMap(
    "track",
    library.tracks.map((track) => track.id),
  );
  const albumVersions = getLibraryArtworkVersions(
    "album",
    library.albums.map((album) => album.id),
  );
  const artistVersions = getLibraryArtworkVersions(
    "artist",
    library.artists.map((artist) => artist.id),
  );
  return {
    artists: library.artists.map((artist) => ({
      ...publicEntity("artist", artist, favoriteKeys),
      metadata: summaryMetadata(artist.metadata),
      coverUrl: buildLibraryArtworkUrl("artist", artist.id, artistVersions.get(String(artist.id))),
    })),
    albums: library.albums.map((album) =>
      publicAlbum(
        album,
        favoriteKeys,
        albumArtwork.get(String(album.id)),
        albumVersions.get(String(album.id)),
      ),
    ),
    tracks: library.tracks.map((track) => {
      const item = publicEntity("song", track, favoriteKeys);
      const customArtwork = trackArtwork.get(String(track.id));
      return customArtwork
        ? {
            ...item,
            artworkUrl: buildCustomArtworkUrl("track", track.id, customArtwork),
            customArtworkUrl: buildCustomArtworkUrl("track", track.id, customArtwork),
          }
        : item;
    }),
  };
}

export function toPublicLibrary(
  library: LibraryCollections,
  favoriteKeys: Set<string> | null = null,
) {
  return stripFilesystemPaths(buildPublicLibrary(library, favoriteKeys));
}

export function toPublicLibraryPage(page: LibraryPage, favoriteKeys: Set<string> | null = null) {
  const collections = toPublicLibrary(page, favoriteKeys);
  const stripped = stripFilesystemPaths(page);
  switch (stripped.kind) {
    case "artists":
      return { ...stripped, ...collections, items: collections.artists };
    case "albums":
      return { ...stripped, ...collections, items: collections.albums };
    case "tracks":
      return { ...stripped, ...collections, items: collections.tracks };
    case "genres":
      return { ...stripped, ...collections, items: stripped.items };
  }
}

type LibraryCollections = Pick<ReturnType<typeof getLibrary>, "albums" | "tracks"> & {
  artists: LibraryArtist[];
};
type LibraryPage = ReturnType<typeof getLibraryPage>;
