// yt-dlp search-query construction and source-context evidence.
//
// Identity scoring happens in the shared trackMatching engine. This module
// keeps the YouTube-specific intelligence: query variants that surface the
// official upload, and channel signals (Topic/official channels, official
// audio/video wording) used as positive evidence — distinct from version
// descriptors, which the shared semantic policy judges.

import { normalizeReleaseText } from "../providers/brainzmashRanking.js";

// Presentation wording in video titles. This is noise around the identity,
// not a different version of the recording: "Artist - Track (Official Video)"
// is the same track as "Track". Live/remix/karaoke descriptors are NOT
// presentation noise — the shared semantic policy owns those.
export const PRESENTATION_PATTERNS =
  /\b(official audio|official video|official lyric|lyric video|official music video|full audio|audio)\b/i;

export function readChannelEvidence(title, channel) {
  const text = `${title} ${channel}`;
  const evidence = {
    presentation: PRESENTATION_PATTERNS.test(text),
    topicChannel: /\btopic\b/i.test(channel),
    officialChannel: /\bofficial\b/i.test(channel),
    liveStream: String(title || "").toLowerCase().includes("live"),
  };
  evidence.bonus =
    (evidence.presentation ? 12 : 0) +
    (evidence.topicChannel ? 18 : 0) +
    (evidence.officialChannel ? 8 : 0);
  return evidence;
}

export function buildYtdlpSearchQueries(context) {
  const trackName = String(context?.trackName || context?.title || "").trim();
  const artistName = String(context?.artistName || context?.artist || "").trim();
  if (!trackName) return [];
  const queries = [];
  if (artistName) {
    queries.push(`${artistName} ${trackName}`);
    queries.push(`${artistName} ${trackName} official audio`);
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
