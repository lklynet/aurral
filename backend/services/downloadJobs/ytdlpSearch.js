// yt-dlp search queries. Channel and title evidence lives in
// trackMatching/youtubeEvidence.js.

import { isVariousArtistsCredit } from "../trackMatching/titleText.js";

// "Artist Title" and "Artist Title official audio" find most uploads. A
// compilation track is searched by its own artist. YouTube returns nothing
// for some logged-out searches in that order, so "Title Artist" is kept as
// the fallback for when the others find nothing.
export function buildYtdlpSearchQueries(context) {
  const trackName = String(context?.trackName || context?.title || "").trim();
  const credited = String(context?.artistName || context?.artist || "").trim();
  const artistName = isVariousArtistsCredit(credited)
    ? String(context?.artistAliases?.[0] || "").trim()
    : credited;
  if (!trackName) return { queries: [], fallbackQuery: null };
  const queries = artistName
    ? [`${artistName} ${trackName}`, `${artistName} ${trackName} official audio`]
    : [trackName];
  return { queries, fallbackQuery: artistName ? `${trackName} ${artistName}` : null };
}
