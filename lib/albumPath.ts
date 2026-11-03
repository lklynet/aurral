export type AlbumRef =
  | { kind: "library"; libraryAlbumId: string }
  | { kind: "release"; releaseGroupMbid: string };

const LIBRARY_ALBUM_REF = /^\d+$/;

export function parseAlbumRef(ref: string | number | null | undefined): AlbumRef | null {
  const value = String(ref ?? "").trim();
  if (!value) return null;
  return LIBRARY_ALBUM_REF.test(value)
    ? { kind: "library", libraryAlbumId: value }
    : { kind: "release", releaseGroupMbid: value };
}

export const libraryAlbumPath = (album: {
  id?: string | number | null;
  canonicalId?: string | number | null;
  releaseGroupMbid?: string | null;
}) => albumPath(album.releaseGroupMbid || album.canonicalId || album.id || "");

export function albumPath(
  ref: string | number,
  { track }: { track?: string | number | null } = {},
) {
  const path = `/album/${encodeURIComponent(String(ref))}`;
  const trackKey = String(track ?? "").trim();
  return trackKey ? `${path}?track=${encodeURIComponent(trackKey)}` : path;
}
