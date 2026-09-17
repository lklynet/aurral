// Soulseek provider adapter.
//
// Gathers the release-folder evidence only Soulseek can provide (directory
// artist/album/year, tracklist fingerprint, track counts) and turns raw
// slskd search hits into canonical CandidateTracks enriched with that
// context. Identity decisions are made by the shared trackMatching engine;
// this module only produces evidence and candidates.

import {
  normalizeCandidate,
  getFileBaseName,
  getFileExtension,
} from "../candidateNormalizer.js";
import { getNormalizedText } from "../../providers/brainzmashRanking.js";
import { groupFlowSearchResults } from "../../weeklyFlow/weeklyFlowSoulseekSearch.js";

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".aac",
  ".opus",
  ".alac",
  ".ape",
  ".wma",
]);

export function isSoulseekAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(getFileExtension(filePath));
}

function readComparableAlbumName(request) {
  return String(request?.albumName || "")
    .replace(/\s+(?:-|–|—)\s+(?:single|ep|album)\s*$/i, "")
    .replace(/\s+[[(](?:single|ep|album)[)\]]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A self-titled single ("Song - Single"): the folder proves nothing except
// the artist, so a folder that does not name the requested artist is a
// different artist's same-titled single.
function isAmbiguousTitleAlbumContext(request) {
  const albumName = String(request?.albumName || "");
  const hasSingleSuffix =
    /\s+(?:-|–|—)\s+(?:single|ep)\s*$/i.test(albumName) ||
    /\s+[[(](?:single|ep)[)\]]\s*$/i.test(albumName);
  const albumKey = getNormalizedText(readComparableAlbumName(request));
  const trackKey = getNormalizedText(request?.trackName);
  return hasSingleSuffix && Boolean(albumKey) && Boolean(trackKey) && albumKey === trackKey;
}

function extractYears(value) {
  return [...String(value || "").matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(
    (match) => match[1],
  );
}

function artistNames(request) {
  return [request?.artistName, ...(request?.artistAliases || [])]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function pathContainsLabel(text, target) {
  const label = getNormalizedText(target);
  if (!label) return false;
  return String(text || "")
    .split(/[\\/]+/)
    .some((segment) => {
      const normalized = getNormalizedText(segment);
      return normalized === label || normalized.includes(label);
    });
}

function bestArtistScore(request, text) {
  return artistNames(request).reduce(
    (best, entry) => Math.max(best, pathContainsLabel(text, entry) ? 100 : 0),
    0,
  );
}

function comparableTrackTitle(fileName, request) {
  const parsed = parseFilenameArtistTitle(fileName, request);
  const title = parsed?.title || String(fileName || "");
  return getNormalizedText(
    title.replace(/\s*[[(]?(?:flac|mp3|m4a|aac|alac|wav|ogg|opus)[)\]]?\s*$/i, ""),
  );
}

function scoreTracklistMatch(audioFiles, request) {
  const titles = Array.isArray(request?.albumTrackTitles) ? request.albumTrackTitles : [];
  if (titles.length === 0) return { score: 0, matchedCount: 0, ratio: 0 };
  const fileNames = (audioFiles || []).map((item) =>
    comparableTrackTitle(getFileBaseName(String(item?.file || "")), request),
  );
  if (fileNames.length === 0) return { score: 0, matchedCount: 0, ratio: 0 };
  const usedFiles = new Set();
  let matchedCount = 0;
  for (const title of titles) {
    let bestIndex = -1;
    for (let index = 0; index < fileNames.length; index += 1) {
      if (usedFiles.has(index)) continue;
      if (fileNames[index] === getNormalizedText(title)) {
        bestIndex = index;
        break;
      }
    }
    if (bestIndex >= 0) {
      matchedCount += 1;
      usedFiles.add(bestIndex);
    }
  }
  const ratio = matchedCount / titles.length;
  let score = 0;
  if (ratio >= 0.85) score = 40;
  else if (ratio >= 0.65) score = 28;
  else if (ratio >= 0.45) score = 14;
  else if (ratio >= 0.25) score = 4;
  return { score, matchedCount, ratio };
}

// Release-context plausibility: is this folder plausibly a copy of the
// requested release at all? This is acquisition context, not identity —
// identity is decided by the shared engine per file.
export function isReleaseFolderPlausible(group, request, folder) {
  const albumName = readComparableAlbumName(request);
  if (!albumName) return true;
  const expectedCount = Number(request?.albumTrackCount);
  const actualCount = group.audioFiles?.length || 0;
  const expectedTitles = Array.isArray(request?.albumTrackTitles)
    ? request.albumTrackTitles.length
    : 0;
  if (folder.albumScore < 18 && folder.trackCountScore < 18 && folder.tracklistScore < 14) {
    return false;
  }
  if (folder.albumScore < 18 && folder.artistScore < 45 && folder.tracklistScore < 14) {
    return false;
  }
  if (Number.isFinite(expectedCount) && expectedCount > 0 && actualCount > 0) {
    const diff = Math.abs(actualCount - expectedCount);
    if (diff > 5) return false;
    if (diff > 3 && folder.albumScore < 35 && folder.tracklistScore < 14) return false;
  }
  if (expectedTitles >= 4 && folder.tracklistScore < 4 && folder.albumScore < 35 && folder.trackCountScore < 18) {
    return false;
  }
  if (folder.artistScore < 35 && folder.albumScore < 50 && folder.tracklistScore < 14) {
    return false;
  }
  return true;
}

function buildFolderEvidence(group, request, options = {}) {
  const directoryText = String(group.directoryPath || "");
  const albumName = readComparableAlbumName(request);
  const artistScore = bestArtistScore(request, directoryText);
  const albumScore = albumName && pathContainsLabel(directoryText, albumName) ? 100 : 0;
  const years = extractYears(directoryText);
  const expectedYear = request?.releaseYear ? String(request.releaseYear) : null;
  const audioFiles = group.audioFiles || [];
  const expectedCount = Number(request?.albumTrackCount);
  let trackCountScore = 0;
  if (Number.isFinite(expectedCount) && expectedCount > 0) {
    if (audioFiles.length === expectedCount) trackCountScore = 30;
    else if (Math.abs(audioFiles.length - expectedCount) === 1) trackCountScore = 18;
    else if (Math.abs(audioFiles.length - expectedCount) === 2) trackCountScore = 6;
  }
  const tracklist = scoreTracklistMatch(audioFiles, request);
  return {
    directoryPath: directoryText,
    artistScore,
    albumScore,
    years,
    yearMatched: expectedYear ? years.includes(expectedYear) : false,
    yearConflicting: expectedYear ? years.length > 0 && !years.includes(expectedYear) : false,
    trackCountScore,
    tracklistScore: tracklist.score,
    tracklistMatchedCount: tracklist.matchedCount,
    tracklistRatio: tracklist.ratio,
    user: group.user,
    blacklisted:
      typeof options.isUserBlacklisted === "function"
        ? options.isUserBlacklisted(group.user)
        : false,
    plausible: true,
  };
}

// Parses "Artist - Title" file names. When a leading track number is
// consumed, that number is returned so the candidate can carry the track
// number. A parsed artist that does not match the request is kept as
// contradicted evidence (negative evidence, not missing evidence), while a
// purely numeric leading segment is a track number, never an artist.
function parseFilenameArtistTitle(baseName, request) {
  const known = artistNames(request);
  const normalizedKnown = known.map((name) => getNormalizedText(name));
  const isKnownArtist = (name) =>
    normalizedKnown.length === 0 || normalizedKnown.includes(getNormalizedText(name));
  const isNumericName = (name) => /^\d{1,3}$/.test(String(name || "").trim());
  const raw = String(baseName || "").trim();
  const leading = /^(\d{1,3})(?:\s*[-._)\]]|\s+-\s+)\s*/.exec(raw);
  const leadingTrackNumber = leading ? Number(leading[1]) : null;
  const withoutNumber = leading ? raw.slice(leading[0].length).trim() : raw;
  const tryParse = (text) => {
    const segments = String(text || "")
      .split(/\s+(?:-|–|—)\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) return null;
    return { artist: segments[0], title: segments[segments.length - 1] };
  };

  const withoutNumberParse = withoutNumber !== raw ? tryParse(withoutNumber) : null;
  if (withoutNumberParse && isKnownArtist(withoutNumberParse.artist)) {
    return { ...withoutNumberParse, matched: true, trackNumber: leadingTrackNumber };
  }
  const fullParse = tryParse(raw);
  if (fullParse && isKnownArtist(fullParse.artist)) {
    return { ...fullParse, matched: true, trackNumber: null };
  }
  if (withoutNumberParse) {
    return { ...withoutNumberParse, matched: false, trackNumber: leadingTrackNumber };
  }
  if (fullParse && !isNumericName(fullParse.artist)) {
    return { ...fullParse, matched: false, trackNumber: null };
  }
  // "01 - Song" with no artist anywhere: still return the cleaned title and
  // the parsed track number.
  if (leadingTrackNumber != null && withoutNumber) {
    return { artist: null, title: withoutNumber, matched: false, trackNumber: leadingTrackNumber };
  }
  return null;
}

function readAdvertisedDurationMs(item) {
  const seconds = Number(item?.length);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

// Turns raw slskd search results into canonical candidates enriched with
// folder evidence. Identity decisions belong to the shared engine; this only
// gathers what Soulseek can (and cannot) prove about each file.
export function buildSoulseekCandidates(results, request, options = {}) {
  const groups = groupFlowSearchResults(results, { isAudioFile: isSoulseekAudioFile });
  const entries = [];
  const albumName = readComparableAlbumName(request);
  const hasAlbumContext = Boolean(albumName);

  for (const group of groups) {
    const folder = buildFolderEvidence(group, request, options);
    if (folder.blacklisted) continue;
    folder.plausible = !hasAlbumContext || isReleaseFolderPlausible(group, request, folder);
    const albumDir = group.parts.at(-2) || "";
    for (const item of group.audioFiles) {
      const filePath = String(item?.file || "");
      const baseName = getFileBaseName(filePath);
      const parsed = parseFilenameArtistTitle(baseName, request);
      const candidate = normalizeCandidate("soulseek", item, {
        capabilities: { filename: true },
        parseFilename: false,
      });
      if (!candidate) continue;
      // Use the adapter's anchored parse: it knows which reading consumed a
      // leading track number and whether the named artist is the requested
      // one.
      if (parsed?.title) candidate.filenameTitle = parsed.title;
      if (parsed?.artist && parsed.matched && !candidate.artists.length) {
        candidate.artists = [parsed.artist];
      }
      const advertisedDurationMs = readAdvertisedDurationMs(item);
      if (advertisedDurationMs && !candidate.durationMs) {
        candidate.durationMs = advertisedDurationMs;
      }
      if (parsed?.trackNumber != null && !candidate.trackNumber) {
        candidate.trackNumber = parsed.trackNumber;
      }
      // Artist evidence: the folder names the artist strongly enough to
      // vouch for guest/featured file names, otherwise an unmatched filename
      // artist is a contradiction.
      const folderVouchesForArtist = folder.artistScore >= 92;
      const artistContradicted =
        Boolean(parsed?.artist) &&
        !parsed.matched &&
        !folderVouchesForArtist;
      const artistMissing =
        !parsed?.artist &&
        !candidate.artists.length &&
        folder.artistScore < 45;
      const ambiguousTitleAlbumArtist =
        !artistContradicted &&
        !parsed?.matched &&
        isAmbiguousTitleAlbumContext(request) &&
        folder.artistScore < 45;
      entries.push({
        candidate,
        folder: {
          ...folder,
          filenameArtist: parsed?.artist ?? null,
          filenameArtistMatched: parsed ? parsed.matched : null,
          filenameTitle: parsed?.title ?? null,
          directoryAlbum: albumDir || null,
          artistContradicted,
          artistMissing,
          ambiguousTitleAlbumArtist,
        },
        advertisedDurationMs,
      });
    }
  }

  return {
    candidates: entries.map((entry) => entry.candidate),
    providerEvidence: entries.map((entry) => ({
      folder: entry.folder,
      advertisedDurationMs: entry.advertisedDurationMs,
    })),
    groups,
  };
}
