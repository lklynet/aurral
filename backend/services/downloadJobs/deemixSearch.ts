// Deemix search-query construction.
//
// Deezer metadata is structured; identity scoring happens in the shared
// trackMatching engine, so this module only owns how Aurral asks Deezer for
// candidates.

import { normalizeReleaseText } from "../providers/brainzmashRanking.ts";
import { normalizeMatchText } from "../trackMatching/nativeMatcher.ts";
import { stripReleaseTypeSuffix } from "./trackSearchQueries.ts";
import { coreAlbumTitle } from "../trackMatching/titleText.ts";

function quote(value: string | null | undefined) {
  return String(value || "")
    .replace(/"/g, " ")
    .trim();
}

function uniqueQueries(queries: string[]) {
  const seen = new Set();
  return queries.filter((query) => {
    const key = normalizeReleaseText(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isSameCoreAlbum(left: string | null | undefined, right: string | null | undefined) {
  const key = normalizeMatchText(coreAlbumTitle(left));
  return Boolean(key) && key === normalizeMatchText(coreAlbumTitle(right));
}

interface DeemixAlbumContext {
  albumName?: string | null;
  artistName?: string | null;
  compilation?: boolean;
}

export function buildDeemixAlbumSearchQueries(context: DeemixAlbumContext) {
  const albumName = stripReleaseTypeSuffix(context?.albumName);
  const coreAlbum = coreAlbumTitle(albumName);
  const artistName = context?.compilation ? "" : String(context?.artistName || "").trim();
  if (!albumName) return [];
  return uniqueQueries(
    artistName
      ? [`artist:"${quote(artistName)}" album:"${quote(albumName)}"`, `${artistName} ${albumName}`]
      : [`album:"${quote(coreAlbum)}"`, coreAlbum],
  );
}

interface DeemixTrackContext {
  trackName?: string | null;
  title?: string | null;
  artistName?: string | null;
  artist?: string | null;
}

export function buildDeemixSearchQueries(context: DeemixTrackContext) {
  const trackName = String(context?.trackName || context?.title || "").trim();
  const artistName = String(context?.artistName || context?.artist || "").trim();
  if (!trackName) return [];
  const queries = [];
  if (artistName) {
    // Deezer's advanced search syntax keeps the first pass tight.
    queries.push(`artist:"${quote(artistName)}" track:"${quote(trackName)}"`);
    queries.push(`${artistName} ${trackName}`);
  } else {
    queries.push(trackName);
  }
  return uniqueQueries(queries);
}
