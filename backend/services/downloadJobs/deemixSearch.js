// Deemix search-query construction.
//
// Deezer metadata is structured; identity scoring happens in the shared
// trackMatching engine, so this module only owns how Aurral asks Deezer for
// candidates.

import { normalizeReleaseText } from "../providers/brainzmashRanking.js";
import { normalizeMatchText } from "../trackMatching/nativeMatcher.js";
import { stripReleaseTypeSuffix } from "./trackSearchQueries.js";

const EDITION_WORDS = /\b(?:deluxe|edition|remaster(?:ed)?|expanded|anniversary|bonus|special|collector'?s|version|explicit|clean)\b/iu;

function quote(value) {
  return String(value || "").replace(/"/g, " ").trim();
}

function uniqueQueries(queries) {
  const seen = new Set();
  return queries.filter((query) => {
    const key = normalizeReleaseText(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// "Album (Deluxe Edition)" and "Album - Single" name the same album as
// "Album"; "Album (Part 2)" does not.
export function coreAlbumTitle(value) {
  return stripReleaseTypeSuffix(String(value || ""))
    .replace(/\s*[[(]([^\])]*)[\])]/gu, (segment, inner) => (EDITION_WORDS.test(inner) ? " " : segment))
    .trim();
}

export function isSameCoreAlbum(left, right) {
  const key = normalizeMatchText(coreAlbumTitle(left));
  return Boolean(key) && key === normalizeMatchText(coreAlbumTitle(right));
}

export function buildDeemixAlbumSearchQueries(context) {
  const albumName = stripReleaseTypeSuffix(context?.albumName);
  const artistName = String(context?.artistName || "").trim();
  if (!albumName) return [];
  return uniqueQueries(artistName
    ? [`artist:"${quote(artistName)}" album:"${quote(albumName)}"`, `${artistName} ${albumName}`]
    : [albumName]);
}

export function buildDeemixSearchQueries(context) {
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
