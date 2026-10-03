import {
  getCanonicalArtistKeyProjection,
  getLibraryArtistsSignature,
} from "../libraryQueryService.js";

const normalizeArtistKey = (value) => String(value || "").trim().toLowerCase();

export const getArtistMatchKeys = (artist) =>
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

export const buildArtistMatchKeySet = (artists = []) => {
  const keys = new Set();
  for (const artist of Array.isArray(artists) ? artists : []) {
    for (const key of getArtistMatchKeys(artist)) keys.add(key);
  }
  return keys;
};

export const matchesArtistKeys = (artist, keys) =>
  keys?.size > 0 && getArtistMatchKeys(artist).some((key) => keys.has(key));

let libraryArtistKeys = { signature: null, keys: new Set() };

export const getLibraryArtistKeys = () => {
  const signature = getLibraryArtistsSignature();
  if (signature !== libraryArtistKeys.signature) {
    libraryArtistKeys = {
      signature,
      keys: buildArtistMatchKeySet(getCanonicalArtistKeyProjection()),
    };
  }
  return libraryArtistKeys;
};
