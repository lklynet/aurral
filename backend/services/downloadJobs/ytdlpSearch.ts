// yt-dlp search queries. Channel and title evidence lives in
// trackMatching/youtubeEvidence.ts.

import { isVariousArtistsCredit } from "../trackMatching/titleText.ts";

// "Artist Title" and "Artist Title official audio" find most uploads. A
// compilation track is searched by its own artist. YouTube returns nothing
// for some logged-out searches in that order, so "Title Artist" is kept as
// the fallback for when the others find nothing.
type YtdlpSearchContext = {
  trackName?: string | null;
  title?: string | null;
  artistName?: string | null;
  artist?: string | null;
  artistAliases?: string[] | null;
};

export function buildYtdlpSearchQueries(context: YtdlpSearchContext | undefined) {
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
