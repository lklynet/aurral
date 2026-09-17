// Canonical Aurral track request model.
//
// Wraps the resolved weekly-flow track context (artistName/trackName/albumName/
// durationMs/MBIDs/aliases) without renaming established fields, and attaches
// the semantic variant profile extracted from the requested title.

import { extractVariants } from "./semanticPolicy.js";
import { getYear } from "../providers/brainzmashRanking.js";

function cleanText(value) {
  return String(value ?? "").trim() || null;
}

function cleanTextList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function cleanPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function cleanYear(value) {
  return getYear(value);
}

export function buildTrackRequest(context = {}) {
  const trackName = cleanText(context.trackName);
  return {
    artistName: cleanText(context.artistName),
    artistAliases: cleanTextList(context.artistAliases),
    trackName,
    featuredArtists: cleanTextList(context.featuredArtists),
    albumName: cleanText(context.albumName),
    releaseYear: cleanYear(context.releaseYear),
    trackNumber: cleanPositiveInt(context.trackNumber),
    discNumber: cleanPositiveInt(context.discNumber),
    durationMs:
      context.durationMs != null && Number.isFinite(Number(context.durationMs))
        ? Math.max(0, Math.round(Number(context.durationMs)))
        : null,
    artistMbid: cleanText(context.artistMbid),
    albumMbid: cleanText(context.albumMbid || context.releaseGroupMbid),
    releaseMbid: cleanText(context.releaseMbid),
    recordingMbid: cleanText(context.recordingMbid || context.trackMbid),
    isrc: cleanText(context.isrc),
    variants: extractVariants(trackName),
    albumTrackCount: cleanPositiveInt(context.albumTrackCount),
    albumTrackTitles: cleanTextList(context.albumTrackTitles),
  };
}
