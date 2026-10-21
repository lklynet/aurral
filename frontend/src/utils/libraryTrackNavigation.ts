type LibraryEntry = { id?: string | null; canonicalId?: string | null };

type LibraryArtistEntry = LibraryEntry & {
  name?: string | null;
  artistName?: string | null;
};

type LibraryAlbumEntry = LibraryEntry & {
  title?: string | null;
  albumName?: string | null;
  albumArtist?: string | null;
  artistName?: string | null;
};

const normalizeName = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase();

export const libraryRecordId = (entry: LibraryEntry | null | undefined) =>
  entry?.canonicalId ?? entry?.id ?? null;

export function findLibraryArtistByName<T extends LibraryArtistEntry>(
  artists: T[] | null | undefined,
  artistName: string | null | undefined,
): T | null {
  const target = normalizeName(artistName);
  if (!target) return null;
  return (
    (Array.isArray(artists) ? artists : []).find(
      (artist) => normalizeName(artist?.name || artist?.artistName) === target,
    ) || null
  );
}

export function findLibraryAlbumByName<T extends LibraryAlbumEntry>(
  albums: T[] | null | undefined,
  albumName: string | null | undefined,
  artistName: string | null | undefined,
): T | null {
  const targetAlbum = normalizeName(albumName);
  const targetArtist = normalizeName(artistName);
  if (!targetAlbum) return null;
  return (
    (Array.isArray(albums) ? albums : []).find(
      (album) =>
        normalizeName(album?.title || album?.albumName) === targetAlbum &&
        (!targetArtist || normalizeName(album?.albumArtist || album?.artistName) === targetArtist),
    ) || null
  );
}
