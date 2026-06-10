import path from "path";
import { parseFile } from "music-metadata";

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

const TITLE_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "feat",
  "featuring",
  "ft",
  "with",
]);

const MIX_VARIANT_PATTERNS = [
  { value: "radio_edit", pattern: /\bradio\s+edit\b/ },
  { value: "extended", pattern: /\b(?:extended|full length|club mix|long version)\b/ },
  { value: "remix", pattern: /\b(?:remix|mix|rework|bootleg|vip|mashup)\b/ },
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(
      /\b(deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|live|mono|stereo|explicit|clean)\b/g,
      " ",
    )
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVariantText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value) {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word && !TITLE_STOP_WORDS.has(word))
    .join(" ");
}

function extractVariantProfile(value) {
  const text = normalizeVariantText(value);
  const mixVariant =
    MIX_VARIANT_PATTERNS.find((entry) => entry.pattern.test(text))?.value || null;
  return {
    live: /\blive\b/.test(text),
    acoustic: /\bacoustic\b/.test(text),
    demo: /\bdemo\b/.test(text),
    instrumental: /\binstrumental\b/.test(text),
    karaoke: /\bkaraoke\b/.test(text),
    mixVariant,
    monoStereo: /\bmono\b/.test(text)
      ? "mono"
      : /\bstereo\b/.test(text)
        ? "stereo"
        : null,
    contentRating: /\bclean\b/.test(text)
      ? "clean"
      : /\bexplicit\b/.test(text)
        ? "explicit"
        : null,
  };
}

function getYear(value) {
  const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : null;
}

function splitWords(value) {
  return normalizeText(value)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scoreTextMatch(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 92;
  const leftWords = new Set(splitWords(a));
  const rightWords = new Set(splitWords(b));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  const ratio =
    (2 * overlap) / Math.max(1, leftWords.size + rightWords.size);
  return Math.round(ratio * 100);
}

function getDistinctiveAlbumPhrase(albumName) {
  const words = splitWords(albumName).filter(
    (word) => word.length > 2 && !TITLE_STOP_WORDS.has(word),
  );
  if (words.length <= 2) return words.join(" ");
  return words
    .sort((left, right) => right.length - left.length)
    .slice(0, 3)
    .sort((left, right) => String(albumName).toLowerCase().indexOf(left) - String(albumName).toLowerCase().indexOf(right))
    .join(" ");
}

function uniqueQueries(values) {
  const seen = new Set();
  const queries = [];
  for (const value of values) {
    const query = String(value || "").trim().replace(/\s+/g, " ");
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries.slice(0, 12);
}

function stripParenthetical(value) {
  return String(value || "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

export function buildFlowSearchQueries(context) {
  const artistName = String(context?.artistName || "").trim();
  const trackName = String(context?.trackName || "").trim();
  const albumName = String(context?.albumName || "").trim();
  const releaseYear = getYear(context?.releaseYear);
  const aliases = Array.isArray(context?.artistAliases)
    ? context.artistAliases
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .slice(0, 2)
    : [];
  const normalizedAlbum = normalizeTitle(albumName);
  const distinctiveAlbum = getDistinctiveAlbumPhrase(albumName);
  const trackVariants = buildTrackQueryVariants(trackName);
  const isSelfTitled =
    artistName && albumName
      ? scoreTextMatch(artistName, albumName) >= 92
      : false;

  const queries = [];
  if (artistName && albumName) {
    if (isSelfTitled && releaseYear) {
      queries.push(`${artistName} ${releaseYear}`);
    }
    queries.push(`${artistName} ${albumName}`);
    if (releaseYear) {
      queries.push(`${artistName} ${albumName} ${releaseYear}`);
    }
    if (normalizedAlbum && normalizedAlbum !== normalizeTitle(albumName)) {
      queries.push(`${artistName} ${normalizedAlbum}`);
    }
    if (distinctiveAlbum && normalizeText(distinctiveAlbum) !== normalizeText(albumName)) {
      queries.push(`${artistName} ${distinctiveAlbum}`);
    }
  }
  if (artistName && trackVariants.length > 0) {
    for (const trackVariant of trackVariants) {
      queries.push(`${artistName} ${trackVariant}`);
    }
  }
  if (albumName && trackVariants.length > 0) {
    for (const trackVariant of trackVariants.slice(0, 2)) {
      queries.push(`${trackVariant} ${albumName}`);
      if (releaseYear) {
        queries.push(`${trackVariant} ${albumName} ${releaseYear}`);
      }
      if (
        normalizedAlbum &&
        normalizedAlbum !== normalizeTitle(albumName)
      ) {
        queries.push(`${trackVariant} ${normalizedAlbum}`);
      }
    }
  }
  for (const alias of aliases) {
    if (albumName) queries.push(`${alias} ${albumName}`);
    for (const trackVariant of trackVariants) {
      queries.push(`${alias} ${trackVariant}`);
    }
  }
  return uniqueQueries(queries);
}

function getPathParts(filePath) {
  return String(filePath || "")
    .split(/[\\/]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getDirectoryKey(item) {
  const parts = getPathParts(item?.file);
  if (parts.length === 0) return null;
  const directory = parts.slice(0, -1).join("/");
  const user = String(item?.user || "").trim();
  return `${user}\0${directory}`;
}

function formatRank(ext, preferredFormat) {
  if (preferredFormat === "mp3") {
    if (ext === ".mp3") return 0;
    if (ext === ".flac") return 1;
  } else {
    if (ext === ".flac") return 0;
    if (ext === ".mp3") return 1;
  }
  return 2;
}

function countAudioFiles(files) {
  return files.filter((item) => AUDIO_EXTENSIONS.has(path.extname(String(item?.file || "")).toLowerCase())).length;
}

function scoreTrackCount(expected, actual) {
  if (!expected || !actual) return 0;
  if (actual === expected) return 30;
  const diff = Math.abs(actual - expected);
  if (diff === 1) return 18;
  if (diff === 2) return 6;
  return -Math.min(20, diff * 5);
}

function scoreYearMatch(directoryText, releaseYear) {
  const expected = getYear(releaseYear);
  if (!expected) return 0;
  return directoryText.includes(expected) ? 12 : 0;
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
  const match = String(value || "").match(
    /^\s*(\d{1,3})(?:\s*[-._)\]]|\s+)/,
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  const titles = Array.isArray(context?.albumTrackTitles)
    ? context.albumTrackTitles
    : [];
  if (titles.length === 0) return 0;
  const targetKey = normalizeTitle(context?.trackName);
  const bestOther = titles
    .filter((title) => normalizeTitle(title) !== targetKey)
    .reduce(
      (best, title) => Math.max(best, scoreTextMatch(baseName, title)),
      0,
    );
  if (bestOther >= 90 && bestOther >= titleScore + 25) return -120;
  if (bestOther >= 82 && bestOther >= titleScore + 15) return -70;
  return 0;
}

function isStrongEnoughCandidate({
  titleScore,
  artistScore,
  albumScore,
  variantMatch,
  trackCountScore,
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
  if (
    artistScore < 45 &&
    !(titleScore >= 72 && albumScore >= 35)
  ) {
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

function pickBestArtistScore(context, text) {
  const candidates = [
    context?.artistName,
    ...(Array.isArray(context?.artistAliases) ? context.artistAliases : []),
  ];
  return candidates.reduce(
    (best, entry) => Math.max(best, scoreTextMatch(text, entry)),
    0,
  );
}

function buildGroupCandidate(group, context, options = {}) {
  const preferredFormat = options?.preferredFormat === "mp3" ? "mp3" : "flac";
  const strictFormat = options?.strictFormat === true;
  const isUserBlacklisted =
    typeof options?.isUserBlacklisted === "function"
      ? options.isUserBlacklisted
      : () => false;
  const getUserQueuePenalty =
    typeof options?.getUserQueuePenalty === "function"
      ? options.getUserQueuePenalty
      : () => 0;
  if (isUserBlacklisted(group.user)) {
    return [];
  }
  const directoryText = normalizeText(group.directoryPath);
  const albumDir = group.parts.at(-2) || "";
  const artistDir = group.parts.at(-3) || "";
  const artistScore = Math.max(
    pickBestArtistScore(context, group.directoryPath),
    pickBestArtistScore(context, artistDir),
  );
  const albumScore = context?.albumName
    ? Math.max(
        scoreTextMatch(group.directoryPath, context.albumName),
        scoreTextMatch(albumDir, context.albumName),
      )
    : 0;
  const yearScore = scoreYearMatch(directoryText, context?.releaseYear);
  const audioFiles = group.audioFiles;
  const trackCountScore = scoreTrackCount(context?.albumTrackCount, audioFiles.length);
  const availabilityScore = audioFiles.some((item) => item?.slots) ? 8 : 0;
  const speedScore = Math.min(
    12,
    Math.round(
      audioFiles.reduce((best, item) => Math.max(best, Number(item?.speed || 0)), 0) /
        250000,
    ),
  );
  const userQueuePenaltyScore = -Math.min(
    120,
    Math.round(Number(getUserQueuePenalty(group.user) || 0) / 2),
  );

  const files = strictFormat
    ? audioFiles.filter(
        (item) => path.extname(String(item?.file || "")).toLowerCase() === `.${preferredFormat}`,
      )
    : audioFiles;
  const candidates = [];
  for (const item of files) {
    const ext = path.extname(String(item?.file || "")).toLowerCase();
    const baseName = path.basename(String(item?.file || ""), ext);
    const titleScore = Math.max(
      scoreTextMatch(baseName, context?.trackName),
      scoreTextMatch(path.basename(String(item?.file || "")), context?.trackName),
    );
    const variantMatch = scoreVariantCompatibility(
      context?.trackName,
      baseName,
    );
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
    const siblingTrackPenalty = scoreSiblingTrackConflict(
      baseName,
      context,
      titleScore,
    );
    const preDownloadCheck = isStrongEnoughCandidate({
      titleScore,
      artistScore,
      albumScore,
      variantMatch,
      trackCountScore,
      trackNumberMismatch,
      siblingTrackPenalty,
      context,
    });
    const formatScore =
      ext === `.${preferredFormat}` ? 18 : ext === ".flac" || ext === ".mp3" ? 9 : 0;
    const bitrateScore = Number.isFinite(Number(item?.bitrate))
      ? Math.min(8, Math.round(Number(item.bitrate) / 64))
      : 0;
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
        (!context?.albumName || albumScore >= 35 || trackCountScore >= 18),
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
      resolvedAlbumName: context?.albumName || albumDir || null,
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

export function rankFlowSearchResults(results, context, options = {}) {
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

  const ranked = [];
  for (const group of groups.values()) {
    group.audioFiles = group.files.filter((item) =>
      AUDIO_EXTENSIONS.has(path.extname(String(item?.file || "")).toLowerCase()),
    );
    if (group.audioFiles.length === 0) continue;
    group.audioFileCount = countAudioFiles(group.files);
    ranked.push(...buildGroupCandidate(group, context, options));
  }

  return ranked.sort((left, right) => right.score - left.score);
}

export function selectRankedMatchAttempts(matches, limit = 5) {
  const ranked = Array.isArray(matches) ? matches : [];
  const max =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : 5;
  if (ranked.length <= max) return ranked.slice(0, max);

  const selected = [];
  const seenKeys = new Set();
  const seenUsers = new Set();
  const getKey = (match) =>
    `${String(match?.raw?.user || "").trim().toLowerCase()}\0${String(
      match?.raw?.file || "",
    )
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

function bestArtistTag(common) {
  const values = [];
  if (common?.artist) values.push(common.artist);
  if (Array.isArray(common?.artists)) values.push(...common.artists);
  if (common?.albumartist) values.push(common.albumartist);
  return values.filter(Boolean).join(" ");
}

export async function validateDownloadedTrack(filePath, candidate, context) {
  const remoteFilename = getRemoteFilename(candidate);
  const expectedDuration = Number(context?.durationMs || 0);
  let metadata = null;
  let parsed = null;
  try {
    parsed = await parseFile(filePath, { duration: true });
    metadata = parsed?.common || null;
  } catch {}

  const titleFromTags = metadata?.title || "";
  const artistFromTags = bestArtistTag(metadata);
  const albumFromTags = metadata?.album || "";
  const titleScore = Math.max(
    scoreTextMatch(titleFromTags, context?.trackName),
    scoreTextMatch(remoteFilename, context?.trackName),
  );
  const artistScore = Math.max(
    pickBestArtistScore(context, artistFromTags),
    pickBestArtistScore(context, remoteFilename),
  );
  const albumScore = context?.albumName
    ? Math.max(
        scoreTextMatch(albumFromTags, context.albumName),
        scoreTextMatch(remoteFilename, context.albumName),
      )
    : 0;
  const variantMatch = scoreVariantCompatibility(
    context?.trackName,
    titleFromTags || remoteFilename,
  );
  const actualTrackNumber =
    parsed?.common?.track?.no != null &&
    Number.isFinite(Number(parsed.common.track.no))
      ? Number(parsed.common.track.no)
      : extractTrackNumber(path.basename(remoteFilename));
  const trackNumberValid =
    !Number.isFinite(Number(context?.trackNumber)) ||
    !Number.isFinite(Number(actualTrackNumber)) ||
    Number(context.trackNumber) <= 0 ||
    Number(actualTrackNumber) <= 0 ||
    Number(context.trackNumber) === Number(actualTrackNumber);
  const durationSeconds = Number(parsed?.format?.duration || 0);
  const actualDurationMs =
    durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null;
  const durationDiffMs =
    expectedDuration > 0 && actualDurationMs != null
      ? Math.abs(actualDurationMs - expectedDuration)
      : null;
  const durationValid =
    durationDiffMs == null ||
    durationDiffMs <= 25000 ||
    durationDiffMs <= Math.max(12000, expectedDuration * 0.18);

  const valid =
    titleScore >= 82 &&
    artistScore >= 60 &&
    durationValid &&
    !variantMatch.hardMismatch &&
    (trackNumberValid || (titleScore >= 98 && artistScore >= 90)) &&
    (!context?.albumName ||
      albumScore >= 28 ||
      (titleScore >= 90 && artistScore >= 90));

  return {
    valid,
    reason: valid
      ? null
      : `title=${titleScore}, artist=${artistScore}, album=${albumScore}, durationValid=${durationValid}, variantScore=${variantMatch.score}, trackNumberValid=${trackNumberValid}`,
    scores: {
      title: titleScore,
      artist: artistScore,
      album: albumScore,
      durationValid,
      variant: variantMatch.score,
      trackNumberValid,
    },
    actualDurationMs,
    remoteFilename,
  };
}
