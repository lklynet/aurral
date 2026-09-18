// Usenet release-candidate scoring.
//
// Usenet results are releases, not individual tracks, so pre-download
// ranking stays release-oriented (title identity gate plus format/size/noise
// tie-breakers). Post-download identity is validated by the shared
// trackMatching engine: downloaded files are assigned to expected tracks
// with beets' assignment and validated per file.

import path from "path";
import {
  normalizeReleaseText as normalizeText,
  normalizeTitle,
  scoreTextMatch,
  getYear,
} from "../providers/brainzmashRanking.js";

const AUDIO_CATEGORY_MIN = 3000;
const AUDIO_CATEGORY_MAX = 3999;
const DEFAULT_MAX_RELEASE_SIZE_MB = 2500;

function hasAudioCategory(release) {
  const categories = Array.isArray(release?.categories) ? release.categories : [];
  if (categories.length === 0) return true;
  return categories.some((category) => {
    const id = Number(category);
    return Number.isFinite(id) && id >= AUDIO_CATEGORY_MIN && id <= AUDIO_CATEGORY_MAX;
  });
}

function hasConflictingYear(title, expectedYear) {
  const expected = getYear(expectedYear);
  if (!expected) return false;
  const years = [...String(title || "").matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(
    (match) => match[1],
  );
  return years.length > 0 && !years.includes(expected);
}

function scoreFormat(title) {
  const text = normalizeText(title);
  if (/\bflac\b|\blossless\b|\blossless\b|\b24bit\b|\b24 bit\b/.test(text)) {
    return 12;
  }
  if (/\bmp3\b|\b320\b|\bscene\b/.test(text)) return 7;
  return 0;
}

function scoreNoise(title) {
  const text = normalizeText(title);
  let penalty = 0;
  if (/\bdiscography\b|\bcomplete\b|\bcollection\b|\bbox set\b/.test(text)) {
    penalty -= 30;
  }
  if (/\bvideo\b|\bdvd\b|\bbluray\b|\bblu ray\b/.test(text)) {
    penalty -= 35;
  }
  if (/\bkaraoke\b|\binstrumental\b/.test(text)) {
    penalty -= 25;
  }
  return penalty;
}

function scoreReleaseSize(release, context, options) {
  const size = Number(release?.size || 0);
  if (!size) return 0;
  const sizeMb = size / (1024 * 1024);
  const maxReleaseSizeMb = Math.max(
    50,
    Number(options?.maxReleaseSizeMb || DEFAULT_MAX_RELEASE_SIZE_MB),
  );
  if (sizeMb > maxReleaseSizeMb) return -80;
  if (context?.albumTrackCount && context.albumTrackCount > 1) {
    if (sizeMb >= 40 && sizeMb <= maxReleaseSizeMb) return 8;
    return -8;
  }
  if (sizeMb >= 3 && sizeMb <= 250) return 8;
  if (sizeMb > 250 && sizeMb <= 700) return -8;
  return -18;
}

function readComparableAlbumName(context) {
  return String(context?.albumName || "")
    .replace(/\s+(?:-|–|—)\s+(?:single|ep|album)\s*$/i, "")
    .replace(/\s+[[(](?:single|ep|album)[)\]]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseKey(release) {
  return [release?.guid, release?.downloadUrl, release?.indexerId, normalizeTitle(release?.title)]
    .map((entry) =>
      String(entry || "")
        .trim()
        .toLowerCase(),
    )
    .join("\0");
}

function artistPresent(title, context) {
  const titleNorm = normalizeTitle(title);
  const candidates = [context?.artistName, ...(context?.artistAliases || [])]
    .map((a) => String(a || "").trim())
    .filter(Boolean);
  return candidates.some((name) => {
    const stripped = normalizeTitle(name);
    if (stripped && titleNorm.includes(stripped)) return true;
    if (!stripped) {
      const tokens = normalizeText(name).split(" ").filter(Boolean);
      const titleTokens = normalizeText(title).split(" ").filter(Boolean);
      return tokens.length > 0 && tokens.every((t) => titleTokens.includes(t));
    }
    return false;
  });
}

export function rankUsenetReleases(releases, context, options = {}) {
  const albumName = readComparableAlbumName(context);
  const expectedYear = getYear(context?.releaseYear);
  const seen = new Set();
  const ranked = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release?.downloadUrl || !release?.title) continue;
    if (String(release.protocol || "").toLowerCase() !== "usenet") continue;
    const key = releaseKey(release);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = release.title;

    // Identity gate: must have artist AND (track OR album)
    if (!hasAudioCategory(release)) {
      ranked.push({
        raw: { release, file: title, size: Number(release.size || 0), downloadUrl: release.downloadUrl, indexerId: release.indexerId, indexer: release.indexer, guid: release.guid },
        score: 0,
        resolvedAlbumName: null,
        releaseAdmissible: false,
        scores: { artist: 0, track: 0, album: 0, year: 0, format: 0, size: 0 },
      });
      continue;
    }

    const hasArtist = artistPresent(title, context);
    const trackScore = scoreTextMatch(title, context?.trackName);
    const albumScore = albumName ? scoreTextMatch(title, albumName) : 0;
    const hasTrack = trackScore >= 45;
    const hasAlbum = albumScore >= 65;

    if (!hasArtist || !(hasTrack || hasAlbum)) {
      ranked.push({
        raw: { release, file: title, size: Number(release.size || 0), downloadUrl: release.downloadUrl, indexerId: release.indexerId, indexer: release.indexer, guid: release.guid },
        score: 0,
        resolvedAlbumName: null,
        releaseAdmissible: false,
        scores: { artist: hasArtist ? 100 : 0, track: trackScore, album: albumScore, year: 0, format: 0, size: 0 },
      });
      continue;
    }

    // Identity passed — tie-breakers only
    const yearScore = expectedYear && normalizeText(title).includes(expectedYear) ? 5 : 0;
    const formatScore = scoreFormat(title);
    const sizeScore = scoreReleaseSize(release, context, options);
    const noiseScore = scoreNoise(title);
    const yearPenalty = hasConflictingYear(title, expectedYear) ? -50 : 0;
    const tieScore = yearScore + formatScore + sizeScore + noiseScore + yearPenalty;

    ranked.push({
      raw: { release, file: title, size: Number(release.size || 0), downloadUrl: release.downloadUrl, indexerId: release.indexerId, indexer: release.indexer, guid: release.guid },
      score: tieScore,
      resolvedAlbumName: hasAlbum ? albumName : null,
      releaseAdmissible: true,
      scores: { artist: 100, track: trackScore, album: albumScore, year: yearScore, format: formatScore, size: sizeScore },
    });
  }
  return ranked.sort((left, right) => {
    if (left.releaseAdmissible !== right.releaseAdmissible) {
      return left.releaseAdmissible ? -1 : 1;
    }
    if (right.score !== left.score) return right.score - left.score;
    return String(left.raw.file).localeCompare(String(right.raw.file));
  });
}

export function selectRankedUsenetCandidates(ranked, limit = 5) {
  const max = Math.max(1, Math.floor(Number(limit) || 5));
  const selected = [];
  const seenIndexers = new Set();
  const seenKeys = new Set();
  for (const candidate of Array.isArray(ranked) ? ranked : []) {
    if (selected.length >= max) break;
    if (!candidate?.releaseAdmissible) continue;
    const key = releaseKey(candidate.raw?.release);
    const indexerId = String(candidate.raw?.indexerId || "");
    if (seenKeys.has(key) || (indexerId && seenIndexers.has(indexerId))) continue;
    seenKeys.add(key);
    if (indexerId) seenIndexers.add(indexerId);
    selected.push(candidate);
  }
  for (const candidate of Array.isArray(ranked) ? ranked : []) {
    if (selected.length >= max) break;
    const key = releaseKey(candidate.raw?.release);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    selected.push(candidate);
  }
  return selected;
}

export function isAudioFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return [
    ".flac", ".mp3", ".m4a", ".ogg", ".wav",
    ".aac", ".opus", ".alac", ".ape", ".wma",
  ].includes(ext);
}
