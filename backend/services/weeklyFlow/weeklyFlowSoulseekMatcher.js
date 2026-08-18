import path from "path";
import { parseFile } from "music-metadata";
import { validateParsedQuality } from "../qualityProfileService.js";
import {
  getAdvertisedQualityRank,
  isAdvertisedQualityEligible,
} from "../qualityProfileModel.js";
import {
  normalizeTitle as normalizeTitleBase,
  scoreTextMatch as scoreTextMatchBase,
  getYear,
} from "../providers/brainzmashRanking.js";

const MATCHER_OPTIONS = { extended: true };

function normalizeTitle(value) {
  return normalizeTitleBase(value, MATCHER_OPTIONS);
}

function scoreTextMatch(left, right) {
  return scoreTextMatchBase(left, right, MATCHER_OPTIONS);
}

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

const MIX_VARIANT_PATTERNS = [
  { value: "radio_edit", pattern: /\bradio\s+edit\b/ },
  { value: "extended", pattern: /\b(?:extended|full length|club mix|long version)\b/ },
  { value: "remix", pattern: /\b(?:remix|mix|rework|bootleg|vip|mashup)\b/ },
];

const LIVE_VARIANT_PATTERN =
  /\((?:live\b|live at[^)]*)\)|\[(?:live\b|live at[^\]]*)\]|\b(?:live at|live from|live version|live recording)\b|(?: - | – )\s*live\b/i;

function normalizeVariantText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractVariantProfile(value) {
  const rawText = String(value || "").toLowerCase();
  const text = normalizeVariantText(value);
  const mixVariant = MIX_VARIANT_PATTERNS.find((entry) => entry.pattern.test(text))?.value || null;
  return {
    live: LIVE_VARIANT_PATTERN.test(rawText),
    acoustic: /\bacoustic\b/.test(text),
    demo: /\bdemo\b/.test(text),
    instrumental: /\binstrumental\b/.test(text),
    karaoke: /\bkaraoke\b/.test(text),
    mixVariant,
    monoStereo: /\bmono\b/.test(text) ? "mono" : /\bstereo\b/.test(text) ? "stereo" : null,
    contentRating: /\bclean\b/.test(text) ? "clean" : /\bexplicit\b/.test(text) ? "explicit" : null,
  };
}

function getYears(value) {
  return [...String(value || "").matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((match) => match[1]);
}

function uniqueQueries(values, limit = 12) {
  const seen = new Set();
  const queries = [];
  for (const value of values) {
    const query = String(value || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries.slice(0, limit);
}

export function bypassBannedArtistTerm(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length < 2) {
    return trimmed;
  }
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (!word || word.startsWith("*") || word.length < 2) return word;
      return `*${word.slice(1)}`;
    })
    .join(" ");
}

function stripParenthetical(value) {
  return String(value || "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripReleaseTypeSuffix(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const stripped = text
    .replace(/\s+(?:-|–|—)\s+(?:single|ep|album)\s*$/i, "")
    .replace(/\s+[[(](?:single|ep|album)[)\]]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || text;
}

function readComparableAlbumName(context) {
  return stripReleaseTypeSuffix(context?.albumName);
}

function hasSingleReleaseTypeSuffix(context) {
  return (
    /\s+(?:-|–|—)\s+(?:single|ep)\s*$/i.test(String(context?.albumName || "")) ||
    /\s+[[(](?:single|ep)[)\]]\s*$/i.test(String(context?.albumName || ""))
  );
}

function isAmbiguousTitleAlbumContext(context) {
  const albumTitle = normalizeTitle(readComparableAlbumName(context));
  const trackTitle = normalizeTitle(context?.trackName);
  return (
    hasSingleReleaseTypeSuffix(context) && !!albumTitle && !!trackTitle && albumTitle === trackTitle
  );
}

function buildTrackQueryVariants(trackName) {
  const raw = String(trackName || "").trim();
  if (!raw) return [];
  const variants = [raw];
  const stripped = stripParenthetical(raw);
  if (stripped && stripped.toLowerCase() !== raw.toLowerCase()) {
    variants.push(stripped);
  }
  const normalized = normalizeTitle(raw);
  if (normalized && normalized.toLowerCase() !== raw.toLowerCase()) {
    variants.push(normalized);
  }
  if (raw.includes("/")) {
    const slashParts = raw
      .split("/")
      .map((entry) => stripParenthetical(entry))
      .filter(Boolean);
    variants.push(...slashParts);
  }
  return uniqueQueries(variants);
}

function readFlowSearchContext(context) {
  const artistName = String(context?.artistName || "").trim();
  const trackName = String(context?.trackName || "").trim();
  const albumName = readComparableAlbumName(context);
  const releaseYear = getYear(context?.releaseYear);
  const trackVariants = buildTrackQueryVariants(trackName);
  return {
    artistName,
    trackName,
    albumName,
    releaseYear,
    trackVariants,
  };
}

function joinSearchParts(...parts) {
  return parts
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" ");
}

export function stripVersionSuffix(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const stripped = text
    .replace(
      /\s+(?:-|–|—)\s+[^-–—]*\b(?:mix|edit|version|remaster(?:ed)?|radio|extended|instrumental|acoustic|live|demo|mono|stereo)\b[^-–—]*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return stripped || text;
}

function stripTrailingWordPeriods(value) {
  const text = String(value || "").trim();
  const cleaned = text
    .split(/\s+/)
    .map((word) => word.replace(/\.+$/, ""))
    .filter(Boolean)
    .join(" ");
  return cleaned || text;
}

function buildPrimaryTrackTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  if (!ctx.artistName || !primaryTrack) return queries;
  queries.push(joinSearchParts(ctx.artistName, primaryTrack));
  const strippedTrack = stripVersionSuffix(primaryTrack);
  if (strippedTrack.toLowerCase() !== primaryTrack.toLowerCase()) {
    queries.push(joinSearchParts(ctx.artistName, strippedTrack));
  }
  const cleanedArtist = stripTrailingWordPeriods(ctx.artistName);
  if (cleanedArtist.toLowerCase() !== ctx.artistName.toLowerCase()) {
    queries.push(joinSearchParts(cleanedArtist, strippedTrack));
  }
  if (ctx.releaseYear) {
    queries.push(joinSearchParts(ctx.artistName, primaryTrack, ctx.releaseYear));
  }
  return uniqueQueries(queries, 4);
}

function buildBaseAlbumTierQueries(ctx) {
  const queries = [];
  if (!ctx.artistName || !ctx.albumName) return queries;
  if (ctx.releaseYear) {
    queries.push(joinSearchParts(ctx.artistName, ctx.albumName, ctx.releaseYear));
  }
  queries.push(joinSearchParts(ctx.artistName, ctx.albumName));
  return uniqueQueries(queries, 4);
}

function buildWildcardAlbumTierQueries(ctx) {
  const queries = [];
  if (!ctx.artistName || !ctx.albumName) return queries;
  const wildcardArtist = bypassBannedArtistTerm(ctx.artistName);
  if (!wildcardArtist || wildcardArtist === ctx.artistName) return queries;
  if (ctx.releaseYear) {
    queries.push(joinSearchParts(wildcardArtist, ctx.albumName, ctx.releaseYear));
  }
  queries.push(joinSearchParts(wildcardArtist, ctx.albumName));
  return uniqueQueries(queries, 3);
}

function buildAlbumTrackTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  if (ctx.albumName && primaryTrack) {
    queries.push(joinSearchParts(ctx.albumName, primaryTrack));
  }
  if (!ctx.albumName && ctx.artistName && primaryTrack) {
    queries.push(joinSearchParts(ctx.artistName, primaryTrack));
    const wildcardArtist = bypassBannedArtistTerm(ctx.artistName);
    if (wildcardArtist && wildcardArtist !== ctx.artistName) {
      queries.push(joinSearchParts(wildcardArtist, primaryTrack));
    }
  }
  return uniqueQueries(queries, 3);
}

export function buildFlowSearchTiers(context) {
  const ctx = readFlowSearchContext(context);
  const tiers = [];
  const baseAlbum = buildBaseAlbumTierQueries(ctx);
  if (baseAlbum.length > 0) {
    tiers.push({ tier: 0, name: "base_album", queries: baseAlbum });
  }
  const wildcardAlbum = buildWildcardAlbumTierQueries(ctx);
  if (wildcardAlbum.length > 0) {
    tiers.push({ tier: 1, name: "wildcard_album", queries: wildcardAlbum });
  }
  const albumTrack = buildAlbumTrackTierQueries(ctx);
  if (albumTrack.length > 0) {
    tiers.push({ tier: 2, name: "album_track", queries: albumTrack });
  }
  const priorQueries = new Set(
    tiers.flatMap((tier) => tier.queries.map((query) => query.toLowerCase())),
  );
  const primaryTrack = buildPrimaryTrackTierQueries(ctx).filter(
    (query) => !priorQueries.has(query.toLowerCase()),
  );
  if (primaryTrack.length > 0) {
    tiers.push({ tier: tiers.length === 0 ? 0 : 3, name: "primary_track", queries: primaryTrack });
  }
  return tiers;
}

function getPathParts(filePath) {
  return String(filePath || "")
    .split(/[\\/]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getFileName(filePath) {
  const parts = getPathParts(filePath);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function getFileExtension(filePath) {
  const fileName = getFileName(filePath);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "";
  return fileName.slice(dot).toLowerCase();
}

function getFileBaseName(filePath) {
  const fileName = getFileName(filePath);
  const ext = getFileExtension(filePath);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

function getDirectoryKey(item) {
  const parts = getPathParts(item?.file);
  if (parts.length === 0) return null;
  const directory = parts.slice(0, -1).join("/");
  const user = String(item?.user || "").trim();
  return `${user}\0${directory}`;
}

function isPreferredFormat(ext, preferredFormat) {
  return ext === `.${preferredFormat}` || (preferredFormat === "m4a" && ext === ".aac");
}

function formatRank(ext, preferredFormat) {
  if (isPreferredFormat(ext, preferredFormat)) return 0;
  return AUDIO_EXTENSIONS.has(ext) ? 1 : 2;
}

function countAudioFiles(files) {
  return files.filter((item) =>
    AUDIO_EXTENSIONS.has(path.extname(String(item?.file || "")).toLowerCase()),
  ).length;
}

function isLockedSearchResult(item) {
  return item?.locked === true || item?.isLocked === true;
}

function scoreTrackCount(expected, actual) {
  if (!expected || !actual) return 0;
  if (actual === expected) return 30;
  const diff = Math.abs(actual - expected);
  if (diff === 1) return 18;
  if (diff === 2) return 6;
  return -Math.min(20, diff * 5);
}

function scoreTracklistMatch(audioFiles, context) {
  const titles = Array.isArray(context?.albumTrackTitles) ? context.albumTrackTitles : [];
  if (titles.length === 0) {
    return { score: 0, matchedCount: 0, ratio: 0 };
  }
  const fileNames = (audioFiles || []).map((item) => getFileBaseName(String(item?.file || "")));
  if (fileNames.length === 0) {
    return { score: 0, matchedCount: 0, ratio: 0 };
  }
  const usedFiles = new Set();
  let matchedCount = 0;
  for (const title of titles) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let index = 0; index < fileNames.length; index += 1) {
      if (usedFiles.has(index)) continue;
      const matchScore = scoreTextMatch(fileNames[index], title);
      if (matchScore >= 75 && matchScore > bestScore) {
        bestScore = matchScore;
        bestIndex = index;
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

function scoreYearMatch(directoryText, releaseYear) {
  const expected = getYear(releaseYear);
  if (!expected) return 0;
  return directoryText.includes(expected) ? 12 : 0;
}

function hasConflictingYear(directoryText, releaseYear) {
  const expected = getYear(releaseYear);
  if (!expected) return false;
  const years = getYears(directoryText);
  return years.length > 0 && !years.includes(expected);
}

function scoreVariantCompatibility(expectedTitle, actualTitle) {
  const expected = extractVariantProfile(expectedTitle);
  const actual = extractVariantProfile(actualTitle);
  let score = 0;
  let hardMismatch = false;

  const compareBooleanVariant = (key, bonus = 12, penalty = 20) => {
    if (expected[key] && actual[key]) {
      score += bonus;
      return;
    }
    if (expected[key] !== actual[key]) {
      if (expected[key] || actual[key]) {
        score -= penalty;
        hardMismatch = true;
      }
    }
  };

  compareBooleanVariant("live", 14, 120);
  compareBooleanVariant("acoustic", 12, 90);
  compareBooleanVariant("demo", 12, 90);
  compareBooleanVariant("instrumental", 10, 80);
  compareBooleanVariant("karaoke", 10, 80);

  if (expected.mixVariant && actual.mixVariant) {
    if (expected.mixVariant === actual.mixVariant) {
      score += 10;
    } else {
      score -= 95;
      hardMismatch = true;
    }
  } else if (expected.mixVariant || actual.mixVariant) {
    score -= 95;
    hardMismatch = true;
  }

  if (expected.monoStereo && actual.monoStereo) {
    score += expected.monoStereo === actual.monoStereo ? 6 : -10;
  } else if (expected.monoStereo || actual.monoStereo) {
    score -= 6;
  }

  if (expected.contentRating && actual.contentRating) {
    score += expected.contentRating === actual.contentRating ? 4 : -6;
  }

  return {
    score,
    hardMismatch,
  };
}

function extractTrackNumber(value) {
  const match = String(value || "").match(/^\s*(\d{1,3})(?:\s*[-._)\]]|\s+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stripLeadingTrackNumber(value) {
  return String(value || "")
    .replace(/^\s*\d{1,3}(?:\s*[-._)\]]|\s+)/, "")
    .trim();
}

function scoreTrackNumberMatch(expectedTrackNumber, actualTrackNumber) {
  const expected = Number(expectedTrackNumber);
  const actual = Number(actualTrackNumber);
  if (!Number.isFinite(expected) || expected <= 0) return 0;
  if (!Number.isFinite(actual) || actual <= 0) return 0;
  if (expected === actual) return 18;
  if (Math.abs(expected - actual) === 1) return -8;
  return -22;
}

function scoreTitleConfidence(titleScore) {
  if (titleScore >= 95) return 18;
  if (titleScore >= 82) return 10;
  if (titleScore >= 65) return 0;
  if (titleScore >= 45) return -25;
  return -60;
}

function scoreSiblingTrackConflict(baseName, context, titleScore) {
  const titles = Array.isArray(context?.albumTrackTitles) ? context.albumTrackTitles : [];
  if (titles.length === 0) return 0;
  const targetKey = normalizeTitle(context?.trackName);
  const bestOther = titles
    .filter((title) => normalizeTitle(title) !== targetKey)
    .reduce((best, title) => Math.max(best, scoreTextMatch(baseName, title)), 0);
  if (bestOther >= 90 && bestOther >= titleScore + 25) return -120;
  if (bestOther >= 82 && bestOther >= titleScore + 15) return -70;
  return 0;
}

function isStrongEnoughCandidate({
  titleScore,
  artistScore,
  albumScore,
  yearScore = 0,
  yearMismatch = false,
  variantMatch,
  trackCountScore,
  tracklistScore = 0,
  trackNumberMismatch,
  siblingTrackPenalty,
  context,
}) {
  if (variantMatch?.hardMismatch) {
    return { valid: false, reason: "variant-mismatch" };
  }
  if (siblingTrackPenalty <= -100) {
    return { valid: false, reason: "sibling-track-conflict" };
  }
  if (titleScore < 58) {
    return { valid: false, reason: "weak-title-match" };
  }
  if (context?.artistName && isAmbiguousTitleAlbumContext(context) && artistScore < 45) {
    return { valid: false, reason: "weak-artist-ambiguous-title-album" };
  }
  if (context?.artistName && isSelfTitledAlbumContext(context)) {
    if (yearMismatch) {
      return { valid: false, reason: "self-titled-year-mismatch" };
    }
    if (
      getYear(context?.releaseYear) &&
      yearScore <= 0 &&
      trackCountScore < 18 &&
      tracklistScore < 14
    ) {
      return { valid: false, reason: "weak-self-titled-release-context" };
    }
  }
  if (artistScore < 45 && !(titleScore >= 72 && albumScore >= 35)) {
    return { valid: false, reason: "weak-artist-match" };
  }
  if (titleScore < 72 && artistScore < 58) {
    return { valid: false, reason: "weak-title-artist-combo" };
  }
  if (trackNumberMismatch && titleScore < 95) {
    return { valid: false, reason: "track-number-mismatch" };
  }
  if (
    context?.albumName &&
    albumScore < 18 &&
    trackCountScore < 18 &&
    !(titleScore >= 90 && artistScore >= 90) &&
    titleScore < 92
  ) {
    return { valid: false, reason: "weak-album-context" };
  }
  return { valid: true, reason: null };
}

function scoreAgainstPath(text, target) {
  const fullText = String(text || "");
  let best = scoreTextMatch(fullText, target);
  for (const segment of getPathParts(text)) {
    const score = scoreTextMatch(segment, target);
    if (score >= 92) best = Math.max(best, score);
  }
  return best;
}

function pickBestArtistScore(context, text) {
  const candidates = [
    context?.artistName,
    ...(Array.isArray(context?.artistAliases) ? context.artistAliases : []),
  ];
  return candidates.reduce((best, entry) => Math.max(best, scoreAgainstPath(text, entry)), 0);
}

function collectArtistTags(common) {
  return [
    common?.artist,
    ...(Array.isArray(common?.artists) ? common.artists : []),
    common?.albumartist,
  ].filter(Boolean);
}

function isSelfTitledAlbumContext(context) {
  const albumName = readComparableAlbumName(context);
  if (!context?.artistName || !albumName) return false;
  return scoreTextMatch(context.artistName, albumName) >= 92;
}

function readMatcherOptions(options = {}) {
  const preferredFormat = String(options?.preferredFormat || "").toLowerCase();
  return {
    preferredFormat: ["flac", "mp3", "m4a"].includes(preferredFormat)
      ? preferredFormat
      : "flac",
    strictFormat: options?.strictFormat === true,
    isUserBlacklisted:
      typeof options?.isUserBlacklisted === "function" ? options.isUserBlacklisted : () => false,
    getUserQueuePenalty:
      typeof options?.getUserQueuePenalty === "function" ? options.getUserQueuePenalty : () => 0,
  };
}

function scoreReleaseFolder(group, context, options = {}) {
  const { isUserBlacklisted, getUserQueuePenalty } = readMatcherOptions(options);
  const albumName = readComparableAlbumName(context);
  if (isUserBlacklisted(group.user)) {
    return { blacklisted: true };
  }
  const rawDirectoryText = String(group.directoryPath || "");
  const artistScore = pickBestArtistScore(context, group.directoryPath);
  const albumScore = albumName ? scoreAgainstPath(group.directoryPath, albumName) : 0;
  const yearScore = scoreYearMatch(rawDirectoryText, context?.releaseYear);
  const audioFiles = group.audioFiles || [];
  const trackCountScore = scoreTrackCount(context?.albumTrackCount, audioFiles.length);
  const tracklistMatch = scoreTracklistMatch(audioFiles, context);
  const tracklistScore = tracklistMatch.score;
  const yearMismatch = hasConflictingYear(rawDirectoryText, context?.releaseYear);
  const availabilityScore = audioFiles.some((item) => item?.slots) ? 8 : 0;
  const speedScore = Math.min(
    12,
    Math.round(
      audioFiles.reduce((best, item) => Math.max(best, Number(item?.speed || 0)), 0) / 250000,
    ),
  );
  const userQueuePenaltyScore = -Math.min(
    120,
    Math.round(Number(getUserQueuePenalty(group.user) || 0) / 2),
  );
  return {
    blacklisted: false,
    score:
      artistScore +
      albumScore +
      yearScore +
      trackCountScore +
      tracklistScore +
      availabilityScore +
      speedScore +
      userQueuePenaltyScore,
    artistScore,
    albumScore,
    yearScore,
    yearMismatch,
    trackCountScore,
    tracklistScore,
    tracklistMatchedCount: tracklistMatch.matchedCount,
    tracklistMatchRatio: tracklistMatch.ratio,
    availabilityScore,
    speedScore,
    userQueuePenaltyScore,
  };
}

function isReleaseFolderFitting(group, context, folderScores) {
  const albumName = readComparableAlbumName(context);
  if (!albumName) return true;
  const { artistScore, albumScore, trackCountScore, tracklistScore } = folderScores;
  const expectedCount = Number(context?.albumTrackCount);
  const actualCount = group.audioFiles?.length || 0;
  const expectedTitles = Array.isArray(context?.albumTrackTitles)
    ? context.albumTrackTitles.length
    : 0;
  if (albumScore < 18 && trackCountScore < 18 && tracklistScore < 14) {
    return false;
  }
  if (albumScore < 18 && artistScore < 45 && tracklistScore < 14) {
    return false;
  }
  if (Number.isFinite(expectedCount) && expectedCount > 0 && actualCount > 0) {
    const diff = Math.abs(actualCount - expectedCount);
    if (diff > 5) return false;
    if (diff > 3 && albumScore < 35 && tracklistScore < 14) return false;
  }
  if (expectedTitles >= 4 && tracklistScore < 4 && albumScore < 35 && trackCountScore < 18) {
    return false;
  }
  if (artistScore < 35 && albumScore < 50 && tracklistScore < 14) {
    return false;
  }
  return true;
}

function groupFlowSearchResults(results) {
  const groups = new Map();
  for (const item of Array.isArray(results) ? results : []) {
    const key = getDirectoryKey(item);
    if (!key) continue;
    const existing = groups.get(key) || {
      key,
      user: String(item?.user || "").trim(),
      directoryPath: getPathParts(item?.file).slice(0, -1).join("/"),
      parts: getPathParts(item?.file),
      files: [],
    };
    existing.files.push(item);
    groups.set(key, existing);
  }
  const grouped = [];
  for (const group of groups.values()) {
    group.audioFiles = group.files.filter(
      (item) =>
        !isLockedSearchResult(item) &&
        AUDIO_EXTENSIONS.has(path.extname(String(item?.file || "")).toLowerCase()),
    );
    if (group.audioFiles.length === 0) continue;
    group.audioFileCount = countAudioFiles(group.files);
    grouped.push(group);
  }
  return grouped;
}

function readCandidateFileName(entry) {
  return entry?.raw?.file;
}

function readCandidateBitrate(entry) {
  return entry?.raw?.bitrate ?? entry?.raw?.bitRate;
}

function readQualityAdmissionOptions(options = {}) {
  const profile = options?.qualityProfile;
  if (!profile) return null;
  return {
    profile,
    currentTier: options?.currentTier || null,
    upgrade: options?.upgrade === true,
  };
}

function hasProfileAdmissibleCandidate(entries, options = {}) {
  const qualityOptions = readQualityAdmissionOptions(options);
  if (!qualityOptions) return true;
  return entries.some(
    (entry) =>
      entry.preDownloadValid &&
      isAdvertisedQualityEligible(
        readCandidateFileName(entry),
        readCandidateBitrate(entry),
        qualityOptions,
      ),
  );
}

function pickBestTrackCandidate(trackCandidates, options = {}) {
  const profile = options?.qualityProfile;
  if (profile) {
    const qualityOptions = readQualityAdmissionOptions(options);
    const admissible = trackCandidates
      .filter(
        (entry) =>
          entry.preDownloadValid &&
          isAdvertisedQualityEligible(
            readCandidateFileName(entry),
            readCandidateBitrate(entry),
            qualityOptions,
          ),
      )
      .sort(
        (left, right) =>
          getAdvertisedQualityRank(readCandidateFileName(left), readCandidateBitrate(left), profile) -
          getAdvertisedQualityRank(readCandidateFileName(right), readCandidateBitrate(right), profile),
      );
    if (admissible.length > 0) return admissible[0];
  }
  return (
    trackCandidates.find((entry) => entry.preDownloadValid) ||
    trackCandidates.find((entry) => entry.isLikelyMatch) ||
    trackCandidates[0] ||
    null
  );
}

function buildGroupCandidate(group, context, options = {}) {
  const { preferredFormat, strictFormat } = readMatcherOptions(options);
  const folderScores = scoreReleaseFolder(group, context, options);
  if (folderScores.blacklisted) {
    return [];
  }
  const {
    artistScore,
    albumScore,
    yearScore,
    yearMismatch,
    trackCountScore,
    tracklistScore,
    availabilityScore,
    speedScore,
    userQueuePenaltyScore,
  } = folderScores;
  const albumDir = group.parts.at(-2) || "";
  const audioFiles = group.audioFiles;

  const files = strictFormat
    ? audioFiles.filter(
        (item) =>
          isPreferredFormat(
            path.extname(String(item?.file || "")).toLowerCase(),
            preferredFormat,
          ),
      )
    : audioFiles;
  const candidates = [];
  for (const item of files) {
    const ext = getFileExtension(String(item?.file || ""));
    const baseName = getFileBaseName(String(item?.file || ""));
    const titleScore = Math.max(
      scoreTextMatch(baseName, context?.trackName),
      scoreTextMatch(getFileName(String(item?.file || "")), context?.trackName),
    );
    const variantMatch = scoreVariantCompatibility(context?.trackName, baseName);
    const variantScore = variantMatch.score;
    const trackNumberScore = scoreTrackNumberMatch(
      context?.trackNumber,
      extractTrackNumber(baseName),
    );
    const actualTrackNumber = extractTrackNumber(baseName);
    const trackNumberMismatch =
      Number.isFinite(Number(context?.trackNumber)) &&
      Number(context?.trackNumber) > 0 &&
      Number.isFinite(Number(actualTrackNumber)) &&
      Number(actualTrackNumber) > 0 &&
      Number(context?.trackNumber) !== Number(actualTrackNumber);
    const titleConfidenceScore = scoreTitleConfidence(titleScore);
    const siblingTrackPenalty = scoreSiblingTrackConflict(baseName, context, titleScore);
    const preDownloadCheck = isStrongEnoughCandidate({
      titleScore,
      artistScore,
      albumScore,
      yearScore,
      yearMismatch,
      variantMatch,
      trackCountScore,
      tracklistScore,
      trackNumberMismatch,
      siblingTrackPenalty,
      context,
    });
    const formatScore = isPreferredFormat(ext, preferredFormat)
      ? 18
      : AUDIO_EXTENSIONS.has(ext)
        ? 9
        : 0;
    const bitRate = Number(item?.bitrate ?? item?.bitRate ?? 0);
    const bitrateScore = Number.isFinite(bitRate) ? Math.min(8, Math.round(bitRate / 64)) : 0;
    const totalScore =
      artistScore +
      albumScore +
      titleScore +
      yearScore +
      trackCountScore +
      availabilityScore +
      speedScore +
      userQueuePenaltyScore +
      variantScore +
      trackNumberScore +
      titleConfidenceScore +
      siblingTrackPenalty +
      formatScore +
      bitrateScore;
    candidates.push({
      raw: item,
      group,
      ext,
      score: totalScore,
      preDownloadValid: preDownloadCheck.valid,
      preDownloadRejectReason: preDownloadCheck.reason,
      isLikelyMatch:
        titleScore >= 75 &&
        (artistScore >= 55 || (albumScore >= 35 && titleScore >= 82)) &&
        (!readComparableAlbumName(context) || albumScore >= 35 || trackCountScore >= 18),
      breakdown: {
        artistScore,
        albumScore,
        titleScore,
        yearScore,
        trackCountScore,
        userQueuePenaltyScore,
        variantScore,
        variantHardMismatch: variantMatch.hardMismatch,
        trackNumberMismatch,
        trackNumberScore,
        titleConfidenceScore,
        siblingTrackPenalty,
        formatScore,
        speed: Number(item?.speed || 0),
        slots: Number(item?.slots || 0),
        bitrate: Number(item?.bitrate || 0),
      },
      resolvedAlbumName: readComparableAlbumName(context) || albumDir || null,
    });
  }
  return candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftRank = formatRank(left.ext, preferredFormat);
    const rightRank = formatRank(right.ext, preferredFormat);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return Number(right.raw?.speed || 0) - Number(left.raw?.speed || 0);
  });
}

function rankFlowSearchResultsFlat(results, context, options = {}) {
  const ranked = [];
  for (const group of groupFlowSearchResults(results)) {
    ranked.push(...buildGroupCandidate(group, context, options));
  }
  return ranked.sort((left, right) => right.score - left.score);
}

export function rankFlowSearchResults(results, context, options = {}) {
  const albumName = readComparableAlbumName(context);
  const groups = groupFlowSearchResults(results);
  if (!albumName) {
    return rankFlowSearchResultsFlat(results, context, options);
  }

  const folderEntries = [];
  for (const group of groups) {
    const folderScores = scoreReleaseFolder(group, context, options);
    if (folderScores.blacklisted) continue;
    const trackCandidates = buildGroupCandidate(group, context, options);
    if (trackCandidates.length === 0) continue;
    folderEntries.push({
      group,
      folderScores,
      fitting: isReleaseFolderFitting(group, context, folderScores),
      trackCandidates,
    });
  }

  const fittingFolders = folderEntries
    .filter(
      (entry) => entry.fitting && entry.trackCandidates.some((track) => track.preDownloadValid),
    )
    .sort((left, right) => {
      const scoreDiff = right.folderScores.score - left.folderScores.score;
      if (scoreDiff !== 0) return scoreDiff;
      const leftTrack = pickBestTrackCandidate(left.trackCandidates, options);
      const rightTrack = pickBestTrackCandidate(right.trackCandidates, options);
      return Number(rightTrack?.score || 0) - Number(leftTrack?.score || 0);
    });

  const ranked = [];
  for (const entry of fittingFolders) {
    const best = pickBestTrackCandidate(entry.trackCandidates, options);
    if (best) {
      ranked.push({
        ...best,
        releaseFolderFit: true,
        folderScore: entry.folderScores.score,
      });
    }
  }
  if (ranked.length > 0 && hasProfileAdmissibleCandidate(ranked, options)) {
    return ranked;
  }

  return rankFlowSearchResultsFlat(results, context, options);
}

export function selectRankedMatchAttempts(matches, limit = 5) {
  const ranked = Array.isArray(matches) ? matches : [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 5;
  if (ranked.length <= max) return ranked.slice(0, max);

  const selected = [];
  const seenKeys = new Set();
  const seenUsers = new Set();
  const getKey = (match) =>
    `${String(match?.raw?.user || "")
      .trim()
      .toLowerCase()}\0${String(match?.raw?.file || "")
      .trim()
      .toLowerCase()}`;

  for (const match of ranked) {
    if (selected.length >= max) break;
    const key = getKey(match);
    const user = String(match?.raw?.user || "")
      .trim()
      .toLowerCase();
    if (!key || seenKeys.has(key) || !user || seenUsers.has(user)) continue;
    seenKeys.add(key);
    seenUsers.add(user);
    selected.push(match);
  }

  for (const match of ranked) {
    if (selected.length >= max) break;
    const key = getKey(match);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    selected.push(match);
  }

  return selected;
}

function getRemoteFilename(candidate) {
  return String(candidate?.raw?.file || candidate?.file || "");
}

function readDownloadDurationValidation(parsed, expectedDuration, titleScore = 0, artistScore = 0) {
  const durationSeconds = Number(parsed?.format?.duration || 0);
  const actualDurationMs = durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null;
  const durationDiffMs =
    expectedDuration > 0 && actualDurationMs != null
      ? Math.abs(actualDurationMs - expectedDuration)
      : null;

  if (durationDiffMs == null) return { actualDurationMs, durationValid: true };

  if (titleScore >= 85 && artistScore >= 85) {
    const relaxedThreshold = Math.max(60000, expectedDuration * 0.45);
    return { actualDurationMs, durationValid: durationDiffMs <= relaxedThreshold };
  }

  const durationValid =
    durationDiffMs <= 25000 ||
    durationDiffMs <= Math.max(12000, expectedDuration * 0.18);
  return { actualDurationMs, durationValid };
}

export async function validateDownloadedTrack(filePath, candidate, context) {
  const remoteFilename = getRemoteFilename(candidate);
  const remoteBaseName = getFileBaseName(remoteFilename);
  const expectedDuration = Number(context?.durationMs || 0);
  let metadata = null;
  let parsed = null;
  try {
    parsed = await parseFile(filePath, { duration: true });
    metadata = parsed?.common || null;
  } catch {}

  const titleFromTags = metadata?.title || "";
  const albumFromTags = metadata?.album || "";
  const albumName = readComparableAlbumName(context);
  const titleScore = Math.max(
    scoreTextMatch(titleFromTags, context?.trackName),
    scoreTextMatch(remoteBaseName, context?.trackName),
    scoreTextMatch(stripLeadingTrackNumber(remoteBaseName), context?.trackName),
  );
  const artistScore = Math.max(
    0,
    ...collectArtistTags(metadata).map((tag) => pickBestArtistScore(context, tag)),
    pickBestArtistScore(context, remoteFilename),
  );
  const albumScore = albumName
    ? Math.max(scoreAgainstPath(albumFromTags, albumName), scoreAgainstPath(remoteFilename, albumName))
    : 0;
  const yearScore = scoreYearMatch(remoteFilename, context?.releaseYear);
  const yearMismatch = hasConflictingYear(remoteFilename, context?.releaseYear);
  const variantMatch = scoreVariantCompatibility(context?.trackName, remoteBaseName);
  const filenameTrackNumber = extractTrackNumber(remoteBaseName);
  const actualTrackNumber =
    filenameTrackNumber != null
      ? filenameTrackNumber
      : parsed?.common?.track?.no != null && Number.isFinite(Number(parsed.common.track.no))
        ? Number(parsed.common.track.no)
        : null;
  const trackNumberMismatch =
    Number.isFinite(Number(context?.trackNumber)) &&
    Number(context?.trackNumber) > 0 &&
    Number.isFinite(Number(actualTrackNumber)) &&
    Number(actualTrackNumber) > 0 &&
    Number(context?.trackNumber) !== Number(actualTrackNumber);
  const siblingTrackPenalty = scoreSiblingTrackConflict(remoteBaseName, context, titleScore);
  const matchCheck = isStrongEnoughCandidate({
    titleScore,
    artistScore,
    albumScore,
    yearScore,
    yearMismatch,
    variantMatch,
    trackCountScore: 18,
    tracklistScore: 0,
    trackNumberMismatch,
    siblingTrackPenalty,
    context,
  });
  const { actualDurationMs, durationValid } = readDownloadDurationValidation(
    parsed,
    expectedDuration,
    titleScore,
    artistScore,
  );
  const qualityCheck = validateParsedQuality(parsed, filePath, {
    upgradeForJobId: context?.upgradeForJobId || null,
  });
  const valid = matchCheck.valid && durationValid && qualityCheck.valid;
  const blocked = matchCheck.valid && qualityCheck.valid && !durationValid;

  return {
    valid,
    blocked,
    reason: valid
      ? null
      : blocked
        ? `blocked-duration-mismatch: title=${titleScore}, artist=${artistScore}, album=${albumScore}, actualDurationMs=${actualDurationMs}, expectedDurationMs=${expectedDuration}`
        : !matchCheck.valid
          ? `${matchCheck.reason}: title=${titleScore}, artist=${artistScore}, album=${albumScore}, variantScore=${variantMatch.score}, trackNumberMismatch=${trackNumberMismatch}`
          : !qualityCheck.valid
            ? qualityCheck.reason
            : `duration-mismatch: title=${titleScore}, artist=${artistScore}, album=${albumScore}, durationValid=${durationValid}`,
    scores: {
      title: titleScore,
      artist: artistScore,
      album: albumScore,
      durationValid,
      variant: variantMatch.score,
      trackNumberMismatch,
      matchReason: matchCheck.reason,
      preDownloadValid: candidate?.preDownloadValid === true,
    },
    actualDurationMs,
    remoteFilename,
    quality: qualityCheck.quality,
  };
}
