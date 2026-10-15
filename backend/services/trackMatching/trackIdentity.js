// Canonical Aurral track request model.
//
// Wraps the resolved track search context (artistName/trackName/albumName/
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
    pressingDurationsMs: (Array.isArray(context.pressingDurationsMs) ? context.pressingDurationsMs : [])
      .map(cleanPositiveInt).filter(Boolean),
    artistMbid: cleanText(context.artistMbid),
    albumMbid: cleanText(context.albumMbid || context.releaseGroupMbid),
    releaseMbid: cleanText(context.releaseMbid),
    recordingMbid: cleanText(context.recordingMbid || context.trackMbid),
    recordingMbidAliases: cleanTextList(context.recordingMbidAliases),
    isrc: cleanText(context.isrc),
    variants: extractVariants(trackName),
    albumTrackCount: cleanPositiveInt(context.albumTrackCount),
    albumTrackTitles: cleanTextList(context.albumTrackTitles),
    secondaryTypes: cleanTextList(context.secondaryTypes),
  };
}

// The request the matcher compares with, the same for an offered candidate
// and a downloaded file, so a file is held to the lengths and names its
// listing was. A file imported with the whole `importedRelease` may sit in a
// folder that names a version the release's own tracks are.
export function recordingRequest(request, importedRelease = null) {
  return {
    title: request.trackName,
    artists: request.artistName ? [request.artistName] : [],
    artistAliases: request.artistAliases || [],
    durationMs: request.durationMs,
    pressingDurationsMs: request.pressingDurationsMs,
    recordingMbid: request.recordingMbid,
    recordingMbidAliases: request.recordingMbidAliases,
    albumName: request.albumName,
    trackNumber: request.trackNumber,
    albumTrackTitles: request.albumTrackTitles,
    releaseTracks: importedRelease?.tracks || [],
    secondaryTypes: request.secondaryTypes,
  };
}
