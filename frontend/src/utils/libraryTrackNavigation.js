const normalizeName = (value) => String(value || "").trim().toLocaleLowerCase();

export const canonicalLibraryId = (entry) => entry?.canonicalId ?? entry?.id ?? null;

export function findCanonicalArtistByName(artists, artistName) {
  const target = normalizeName(artistName);
  if (!target) return null;
  return (
    (Array.isArray(artists) ? artists : []).find(
      (artist) => normalizeName(artist?.name || artist?.artistName) === target,
    ) || null
  );
}

export function findCanonicalAlbumByName(albums, albumName, artistName) {
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
