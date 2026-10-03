// Deemix search-query construction.
//
// Deezer metadata is structured; identity scoring happens in the shared
// trackMatching engine, so this module only owns how Aurral asks Deezer for
// candidates.

import { normalizeReleaseText } from "../providers/brainzmashRanking.js";

function quote(value) {
  return String(value || "").replace(/"/g, " ").trim();
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
  const seen = new Set();
  return queries.filter((query) => {
    const key = normalizeReleaseText(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
