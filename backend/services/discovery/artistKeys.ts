import { buildArtistMatchKeySet } from "../../../lib/artistMatch.ts";
import {
  getLibraryArtistKeyProjection,
  getLibraryArtistsSignature,
} from "../libraryQueryService.ts";

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
