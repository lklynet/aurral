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

const LIVE_VARIANT_PATTERN =
  /\((?:live\b|live at[^)]*)\)|\[(?:live\b|live at[^\]]*)\]|\b(?:live at|live from|live version|live recording)\b|(?: - | – )\s*live\b/i;

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
  const rawText = String(value || "").toLowerCase();
  const text = normalizeVariantText(value);
  const mixVariant =
    MIX_VARIANT_PATTERNS.find((entry) => entry.pattern.test(text))?.value || null;
  return {
    live: LIVE_VARIANT_PATTERN.test(rawText),
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

function uniqueQueries(values, limit = 12) {
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
  return queries.slice(0, limit);
}

export function bypassBannedArtistTerm(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.startsWith("*") || trimmed.length < 2) {
    return trimmed;
  }
  return `*${trimmed.slice(1)}`;
}

function uniqueArtistTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const term = String(value || "").trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
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

function readFlowSearchContext(context) {
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
  return {
    artistName,
    trackName,
    albumName,
    releaseYear,
    aliases,
    normalizedAlbum,
    distinctiveAlbum,
    trackVariants,
    isSelfTitled,
  };
}

function buildFlowAlbumSearchQueriesForArtistTerms(context, artistTerms) {
  const {
    albumName,
    releaseYear,
    normalizedAlbum,
    distinctiveAlbum,
    isSelfTitled,
  } = readFlowSearchContext(context);
  const queries = [];
  for (const artist of artistTerms) {
    if (!artist || !albumName) continue;
    if (isSelfTitled && releaseYear) {
      queries.push(`${artist} ${releaseYear}`);
    }
    queries.push(`${artist} ${albumName}`);
    if (releaseYear) {
      queries.push(`${artist} ${albumName} ${releaseYear}`);
    }
    if (normalizedAlbum && normalizedAlbum !== normalizeTitle(albumName)) {
      queries.push(`${artist} ${normalizedAlbum}`);
    }
    if (
      distinctiveAlbum &&
      normalizeText(distinctiveAlbum) !== normalizeText(albumName)
    ) {
      queries.push(`${artist} ${distinctiveAlbum}`);
    }
  }
  return uniqueQueries(queries);
}

function buildFlowTrackFallbackSearchQueriesForArtistTerms(
  context,
  artistTerms,
) {
  const {
    albumName,
    releaseYear,
    aliases,
    normalizedAlbum,
    trackVariants,
  } = readFlowSearchContext(context);
  const queries = [];
  for (const artist of artistTerms) {
    if (!artist) continue;
    for (const trackVariant of trackVariants) {
      queries.push(`${artist} ${trackVariant}`);
    }
  }
  if (albumName && trackVariants.length > 0) {
    for (const trackVariant of trackVariants.slice(0, 2)) {
      queries.push(`${trackVariant} ${albumName}`);
      if (releaseYear) {
        queries.push(`${trackVariant} ${albumName} ${releaseYear}`);
      }
      if (normalizedAlbum && normalizedAlbum !== normalizeTitle(albumName)) {
        queries.push(`${trackVariant} ${normalizedAlbum}`);
      }
    }
  }
  for (const alias of aliases) {
    if (artistTerms.some((term) => term.toLowerCase() === alias.toLowerCase())) {
      continue;
    }
    for (const trackVariant of trackVariants) {
      queries.push(`${alias} ${trackVariant}`);
    }
  }
  return uniqueQueries(queries);
}

function readFlowArtistTerms(context, wildcard = false) {
  const { artistName, aliases } = readFlowSearchContext(context);
  const terms = wildcard
    ? [artistName, ...aliases].map(bypassBannedArtistTerm)
    : [artistName, ...aliases];
  return uniqueArtistTerms(terms);
}

export function buildFlowAlbumSearchQueries(context) {
  return buildFlowAlbumSearchQueriesForArtistTerms(
    context,
    readFlowArtistTerms(context, false),
  );
}

export function buildFlowWildcardAlbumSearchQueries(context) {
  return buildFlowAlbumSearchQueriesForArtistTerms(
    context,
    readFlowArtistTerms(context, true),
  );
}

export function buildFlowTrackFallbackSearchQueries(context) {
  return buildFlowTrackFallbackSearchQueriesForArtistTerms(
    context,
    readFlowArtistTerms(context, false),
  );
}

export function buildFlowWildcardTrackFallbackSearchQueries(context) {
  return buildFlowTrackFallbackSearchQueriesForArtistTerms(
    context,
    readFlowArtistTerms(context, true),
  );
}

export function buildFlowArtistOnlySearchQueries(context) {
  return uniqueQueries(readFlowArtistTerms(context, true), 6);
}

export function buildFlowSearchQueries(context) {
  return uniqueQueries(
    buildFlowSearchTiers(context).flatMap((tier) => tier.queries),
    32,
  );
}

export function removeSearchAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function stripSearchPunctuation(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildTrimmedBypassText(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .map((word) => (word.length >= 4 ? word.slice(0, -1) : word))
    .join(" ");
}

function toVolumeDigit(token) {
  const raw = String(token || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  const romanMap = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  const mapped = romanMap[raw.toLowerCase()];
  return mapped != null ? String(mapped) : raw;
}

export function buildVolumeVariationTexts(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const match = text.match(/\b(?:vol\.?|volume)\s*([ivx\d]+)\b/i);
  if (!match) return [];
  const digit = toVolumeDigit(match[1]);
  const prefix = text.slice(0, match.index).trim();
  const suffix = text.slice(match.index + match[0].length).trim();
  const forms = [
    `Vol. ${digit}`,
    `Vol ${digit}`,
    `Volume ${digit}`,
    `Volume ${match[1].toUpperCase()}`,
  ];
  return uniqueQueries(
    forms.map((form) => [prefix, form, suffix].filter(Boolean).join(" ")),
    6,
  );
}

export function buildHalfAlbumTitle(albumName) {
  const words = String(albumName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 5) return "";
  return words.slice(0, Math.ceil(words.length / 2)).join(" ");
}

function joinSearchParts(...parts) {
  return parts
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildPrimaryTrackTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  if (!ctx.artistName || !primaryTrack) return queries;
  queries.push(joinSearchParts(ctx.artistName, primaryTrack));
  if (ctx.releaseYear) {
    queries.push(joinSearchParts(ctx.artistName, primaryTrack, ctx.releaseYear));
  }
  return uniqueQueries(queries, 4);
}

function buildBaseAlbumTierQueries(ctx) {
  const queries = [];
  if (!ctx.artistName || !ctx.albumName) return queries;
  if (ctx.isSelfTitled && ctx.releaseYear) {
    queries.push(joinSearchParts(ctx.artistName, ctx.releaseYear));
  }
  queries.push(joinSearchParts(ctx.artistName, ctx.albumName));
  if (ctx.releaseYear) {
    queries.push(joinSearchParts(ctx.artistName, ctx.albumName, ctx.releaseYear));
  }
  return uniqueQueries(queries, 4);
}

function buildVariationTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  const artistForms = uniqueQueries(
    [ctx.artistName, removeSearchAccents(ctx.artistName), stripSearchPunctuation(ctx.artistName)].filter(Boolean),
    3,
  );
  const trackForms = uniqueQueries(
    [
      primaryTrack,
      removeSearchAccents(primaryTrack),
      stripSearchPunctuation(primaryTrack),
      ...ctx.trackVariants.slice(1, 2),
    ].filter(Boolean),
    4,
  );
  const albumForms = uniqueQueries(
    [
      ctx.albumName,
      removeSearchAccents(ctx.albumName),
      stripSearchPunctuation(ctx.albumName),
      ctx.normalizedAlbum,
    ].filter(Boolean),
    4,
  );
  for (const artist of artistForms) {
    for (const track of trackForms) {
      queries.push(joinSearchParts(artist, track));
    }
    for (const album of albumForms) {
      queries.push(joinSearchParts(artist, album));
      for (const volumeText of buildVolumeVariationTexts(album)) {
        queries.push(joinSearchParts(artist, volumeText));
      }
      if (ctx.releaseYear) {
        queries.push(joinSearchParts(artist, album, ctx.releaseYear));
      }
    }
  }
  return uniqueQueries(queries, 10);
}

function buildTrimmedTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  const trimmedArtist = buildTrimmedBypassText(ctx.artistName);
  const trimmedTrack = buildTrimmedBypassText(primaryTrack);
  const trimmedAlbum = buildTrimmedBypassText(ctx.albumName);
  if (trimmedArtist && trimmedTrack) {
    queries.push(joinSearchParts(trimmedArtist, trimmedTrack));
  }
  if (trimmedArtist && trimmedAlbum) {
    queries.push(joinSearchParts(trimmedArtist, trimmedAlbum));
    if (ctx.releaseYear) {
      queries.push(joinSearchParts(trimmedArtist, trimmedAlbum, ctx.releaseYear));
    }
  }
  if (ctx.artistName && primaryTrack) {
    queries.push(joinSearchParts(bypassBannedArtistTerm(ctx.artistName), primaryTrack));
  }
  if (ctx.artistName && ctx.albumName) {
    queries.push(joinSearchParts(bypassBannedArtistTerm(ctx.artistName), ctx.albumName));
  }
  return uniqueQueries(queries, 6);
}

function buildSpecialCaseTierQueries(ctx) {
  const queries = [];
  const primaryTrack = ctx.trackVariants[0] || ctx.trackName;
  for (const alias of ctx.aliases) {
    if (!alias) continue;
    if (primaryTrack) {
      queries.push(joinSearchParts(alias, primaryTrack));
    }
    if (ctx.albumName) {
      queries.push(joinSearchParts(alias, ctx.albumName));
      if (ctx.releaseYear) {
        queries.push(joinSearchParts(alias, ctx.albumName, ctx.releaseYear));
      }
    }
    queries.push(bypassBannedArtistTerm(alias));
  }
  const halfAlbum = buildHalfAlbumTitle(ctx.albumName);
  if (ctx.artistName && halfAlbum) {
    queries.push(joinSearchParts(ctx.artistName, halfAlbum));
  }
  if (ctx.artistName) {
    queries.push(bypassBannedArtistTerm(ctx.artistName));
  }
  if (ctx.albumName) {
    queries.push(ctx.albumName);
    if (ctx.distinctiveAlbum && ctx.distinctiveAlbum !== ctx.albumName) {
      queries.push(ctx.distinctiveAlbum);
    }
  }
  return uniqueQueries(queries, 10);
}

function buildTrackFallbackTierQueries(ctx) {
  const queries = [];
  const trackVariants = uniqueQueries(ctx.trackVariants, 6);
  for (const trackVariant of trackVariants) {
    if (ctx.artistName) {
      queries.push(joinSearchParts(ctx.artistName, trackVariant));
      queries.push(joinSearchParts(bypassBannedArtistTerm(ctx.artistName), trackVariant));
    }
    if (ctx.albumName) {
      queries.push(joinSearchParts(trackVariant, ctx.albumName));
      if (ctx.releaseYear) {
        queries.push(joinSearchParts(trackVariant, ctx.albumName, ctx.releaseYear));
      }
    }
  }
  for (const alias of ctx.aliases) {
    for (const trackVariant of trackVariants.slice(0, 2)) {
      queries.push(joinSearchParts(alias, trackVariant));
    }
  }
  return uniqueQueries(queries, 8);
}

export function buildFlowSearchTiers(context) {
  const ctx = readFlowSearchContext(context);
  const tiers = [];
  const primaryTrack = buildPrimaryTrackTierQueries(ctx);
  if (primaryTrack.length > 0) {
    tiers.push({ tier: 0, name: "primary_track", queries: primaryTrack });
  }
  const baseAlbum = buildBaseAlbumTierQueries(ctx);
  if (baseAlbum.length > 0) {
    tiers.push({ tier: 1, name: "base_album", queries: baseAlbum });
  }
  const variations = buildVariationTierQueries(ctx);
  if (variations.length > 0) {
    tiers.push({ tier: 2, name: "variations", queries: variations });
  }
  const trimmed = buildTrimmedTierQueries(ctx);
  if (trimmed.length > 0) {
    tiers.push({ tier: 3, name: "trimmed", queries: trimmed });
  }
  const special = buildSpecialCaseTierQueries(ctx);
  if (special.length > 0) {
    tiers.push({ tier: 4, name: "special", queries: special });
  }
  const trackFallback = buildTrackFallbackTierQueries(ctx);
  if (trackFallback.length > 0) {
    tiers.push({ tier: 5, name: "track_fallback", queries: trackFallback });
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
  const titles = Array.isArray(context?.albumTrackTitles)
    ? context.albumTrackTitles
    : [];
  if (titles.length === 0) {
    return { score: 0, matchedCount: 0, ratio: 0 };
  }
  const fileNames = (audioFiles || []).map((item) =>
    getFileBaseName(String(item?.file || "")),
  );
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

function readMatcherOptions(options = {}) {
  return {
    preferredFormat: options?.preferredFormat === "mp3" ? "mp3" : "flac",
    strictFormat: options?.strictFormat === true,
    isUserBlacklisted:
      typeof options?.isUserBlacklisted === "function"
        ? options.isUserBlacklisted
        : () => false,
    getUserQueuePenalty:
      typeof options?.getUserQueuePenalty === "function"
        ? options.getUserQueuePenalty
        : () => 0,
  };
}

function scoreReleaseFolder(group, context, options = {}) {
  const { isUserBlacklisted, getUserQueuePenalty } = readMatcherOptions(options);
  if (isUserBlacklisted(group.user)) {
    return { blacklisted: true };
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
  const audioFiles = group.audioFiles || [];
  const trackCountScore = scoreTrackCount(
    context?.albumTrackCount,
    audioFiles.length,
  );
  const tracklistMatch = scoreTracklistMatch(audioFiles, context);
  const tracklistScore = tracklistMatch.score;
  const availabilityScore = audioFiles.some((item) => item?.slots) ? 8 : 0;
  const speedScore = Math.min(
    12,
    Math.round(
      audioFiles.reduce(
        (best, item) => Math.max(best, Number(item?.speed || 0)),
        0,
      ) / 250000,
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
  const albumName = String(context?.albumName || "").trim();
  if (!albumName) return true;
  const { artistScore, albumScore, trackCountScore, tracklistScore } =
    folderScores;
  const expectedCount = Number(context?.albumTrackCount);
  const actualCount = group.audioFiles?.length || 0;
  const expectedTitles = Array.isArray(context?.albumTrackTitles)
    ? context.albumTrackTitles.length
    : 0;
  if (
    albumScore < 18 &&
    trackCountScore < 18 &&
    tracklistScore < 14
  ) {
    return false;
  }
  if (albumScore < 18 && artistScore < 45 && tracklistScore < 14) {
    return false;
  }
  if (
    Number.isFinite(expectedCount) &&
    expectedCount > 0 &&
    actualCount > 0
  ) {
    const diff = Math.abs(actualCount - expectedCount);
    if (diff > 5) return false;
    if (diff > 3 && albumScore < 35 && tracklistScore < 14) return false;
  }
  if (
    expectedTitles >= 4 &&
    tracklistScore < 4 &&
    albumScore < 35 &&
    trackCountScore < 18
  ) {
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
        AUDIO_EXTENSIONS.has(
          path.extname(String(item?.file || "")).toLowerCase(),
        ),
    );
    if (group.audioFiles.length === 0) continue;
    group.audioFileCount = countAudioFiles(group.files);
    grouped.push(group);
  }
  return grouped;
}

function pickBestTrackCandidate(trackCandidates) {
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
    trackCountScore,
    availabilityScore,
    speedScore,
    userQueuePenaltyScore,
  } = folderScores;
  const albumDir = group.parts.at(-2) || "";
  const audioFiles = group.audioFiles;

  const files = strictFormat
    ? audioFiles.filter(
        (item) => path.extname(String(item?.file || "")).toLowerCase() === `.${preferredFormat}`,
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
    const bitRate = Number(item?.bitrate ?? item?.bitRate ?? 0);
    const bitrateScore = Number.isFinite(bitRate)
      ? Math.min(8, Math.round(bitRate / 64))
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

function rankFlowSearchResultsFlat(results, context, options = {}) {
  const ranked = [];
  for (const group of groupFlowSearchResults(results)) {
    ranked.push(...buildGroupCandidate(group, context, options));
  }
  return ranked.sort((left, right) => right.score - left.score);
}

export function rankFlowSearchResults(results, context, options = {}) {
  const albumName = String(context?.albumName || "").trim();
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
      (entry) =>
        entry.fitting &&
        entry.trackCandidates.some((track) => track.preDownloadValid),
    )
    .sort((left, right) => {
      const scoreDiff = right.folderScores.score - left.folderScores.score;
      if (scoreDiff !== 0) return scoreDiff;
      const leftTrack = pickBestTrackCandidate(left.trackCandidates);
      const rightTrack = pickBestTrackCandidate(right.trackCandidates);
      return Number(rightTrack?.score || 0) - Number(leftTrack?.score || 0);
    });

  const ranked = [];
  for (const entry of fittingFolders) {
    const best = pickBestTrackCandidate(entry.trackCandidates);
    if (best) {
      ranked.push({
        ...best,
        releaseFolderFit: true,
        folderScore: entry.folderScores.score,
      });
    }
  }
  if (ranked.length > 0) {
    return ranked;
  }

  return rankFlowSearchResultsFlat(results, context, options);
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

function readDownloadDurationValidation(parsed, expectedDuration) {
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
    remoteBaseName,
  );
  const filenameTrackNumber = extractTrackNumber(remoteBaseName);
  const actualTrackNumber =
    filenameTrackNumber != null
      ? filenameTrackNumber
      : parsed?.common?.track?.no != null &&
          Number.isFinite(Number(parsed.common.track.no))
        ? Number(parsed.common.track.no)
        : null;
  const trackNumberMismatch =
    Number.isFinite(Number(context?.trackNumber)) &&
    Number(context?.trackNumber) > 0 &&
    Number.isFinite(Number(actualTrackNumber)) &&
    Number(actualTrackNumber) > 0 &&
    Number(context?.trackNumber) !== Number(actualTrackNumber);
  const siblingTrackPenalty = scoreSiblingTrackConflict(
    remoteBaseName,
    context,
    titleScore,
  );
  const matchCheck = isStrongEnoughCandidate({
    titleScore,
    artistScore,
    albumScore,
    variantMatch,
    trackCountScore: 18,
    trackNumberMismatch,
    siblingTrackPenalty,
    context,
  });
  const { actualDurationMs, durationValid } = readDownloadDurationValidation(
    parsed,
    expectedDuration,
  );
  const valid = matchCheck.valid && durationValid;

  return {
    valid,
    reason: valid
      ? null
      : !matchCheck.valid
        ? `${matchCheck.reason}: title=${titleScore}, artist=${artistScore}, album=${albumScore}, variantScore=${variantMatch.score}, trackNumberMismatch=${trackNumberMismatch}`
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
  };
}
