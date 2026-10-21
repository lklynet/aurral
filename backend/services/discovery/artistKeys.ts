import {
  getLibraryArtistKeyProjection,
  getLibraryArtistsSignature,
} from "../libraryQueryService.ts";

export interface ArtistMatchFields {
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  artistMbid?: string | null;
  name?: string | null;
  artistName?: string | null;
  artistAliases?: string[] | null;
}

const normalizeArtistKey = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const getArtistMatchKeys = (artist: ArtistMatchFields | null | undefined) =>
  [
    artist?.id,
    artist?.mbid,
    artist?.foreignArtistId,
    artist?.artistMbid,
    artist?.name,
    artist?.artistName,
    ...(Array.isArray(artist?.artistAliases) ? artist.artistAliases : []),
  ]
    .map(normalizeArtistKey)
    .filter(Boolean);

export const buildArtistMatchKeySet = (artists: ArtistMatchFields[] = []) => {
  const keys = new Set<string>();
  for (const artist of Array.isArray(artists) ? artists : []) {
    for (const key of getArtistMatchKeys(artist)) keys.add(key);
  }
  return keys;
};

export const matchesArtistKeys = (
  artist: ArtistMatchFields | null | undefined,
  keys: Set<string>,
) => keys?.size > 0 && getArtistMatchKeys(artist).some((key) => keys.has(key));

let libraryArtistKeys: { signature: string | null; keys: Set<string> } = {
  signature: null,
  keys: new Set(),
};

export const getLibraryArtistKeys = () => {
  const signature = getLibraryArtistsSignature();
  if (signature !== libraryArtistKeys.signature) {
    libraryArtistKeys = {
      signature,
      keys: buildArtistMatchKeySet(getLibraryArtistKeyProjection()),
    };
  }
  return libraryArtistKeys;
};
