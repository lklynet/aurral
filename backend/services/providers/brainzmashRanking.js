const UNDECOMPOSED_LETTERS = {
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  ł: "l",
  Ł: "L",
  þ: "th",
  Þ: "TH",
  ß: "ss",
};

export function foldDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[øØæÆœŒđĐðÐłŁþÞß]/g, (letter) => UNDECOMPOSED_LETTERS[letter]);
}

function normalizeText(value) {
  return foldDiacritics(String(value || "").normalize("NFKD"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSearchWords(value) {
  return normalizeText(value)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getNormalizedText(value) {
  return normalizeText(value);
}

export const TITLE_STOP_WORDS = new Set([
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

const USENET_STRIP =
  /\b(deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|explicit|clean)\b/g;
const MATCHER_STRIP =
  /\b(deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|live|mono|stereo|single|ep|explicit|clean)\b/g;

export function normalizeReleaseText(value, { extended = false } = {}) {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(extended ? MATCHER_STRIP : USENET_STRIP, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(value, { extended = false } = {}) {
  return normalizeReleaseText(value, { extended })
    .split(" ")
    .filter((word) => word && !TITLE_STOP_WORDS.has(word))
    .join(" ");
}

export function splitWords(value, options) {
  return normalizeReleaseText(value, options)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scoreReleaseTextMatch(left, right, options) {
  const a = normalizeReleaseText(left, options);
  const b = normalizeReleaseText(right, options);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) {
    const aWords = a.split(" ").filter(Boolean).length;
    const bWords = b.split(" ").filter(Boolean).length;
    const ratio = Math.min(aWords, bWords) / Math.max(aWords, bWords, 1);
    if (ratio >= 0.6) return 92;
    if (ratio >= 0.25) return 70;
    return 45;
  }
  const leftWords = new Set(splitWords(a, options));
  const rightWords = new Set(splitWords(b, options));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  return Math.round(((2 * overlap) / Math.max(1, leftWords.size + rightWords.size)) * 100);
}

export function scoreTextMatch(left, right, options) {
  if (options != null) {
    return scoreReleaseTextMatch(left, right, options);
  }
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) {
    const aWords = a.split(" ").filter(Boolean).length;
    const bWords = b.split(" ").filter(Boolean).length;
    const wordRatio = Math.min(aWords, bWords) / Math.max(aWords, bWords, 1);
    if (wordRatio >= 0.6) return 92;
    if (wordRatio >= 0.25) return 70;
    return 45;
  }
  const leftWords = new Set(splitSearchWords(a));
  const rightWords = new Set(splitSearchWords(b));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  const ratio = (2 * overlap) / Math.max(1, leftWords.size + rightWords.size);
  return Math.round(ratio * 100);
}

function positiveMs(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.round(Number(value))
    : null;
}

export function pickResolvedDurationMs({
  playlistDurationMs = null,
  lastfmDurationMs = null,
  lastfmAlbumName = "",
  albumName = "",
  matchedTrackDurationMs = null,
} = {}) {
  let duration = positiveMs(playlistDurationMs);
  const lastfm = positiveMs(lastfmDurationMs);
  if (lastfm) {
    if (!duration) {
      duration = lastfm;
    } else if (
      albumName &&
      lastfmAlbumName &&
      scoreTextMatch(lastfmAlbumName, albumName, { extended: true }) >= 85
    ) {
      duration = lastfm;
    }
  }
  return duration || positiveMs(matchedTrackDurationMs);
}

export function getYear(value) {
  const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : null;
}

function typeRank(value) {
  if (value === "Album") return 0;
  if (value === "EP") return 1;
  if (value === "Single") return 2;
  return 3;
}

function bootlegPenalty(item) {
  const statuses = Array.isArray(item?.releaseStatuses) ? item.releaseStatuses : [];
  return statuses.some((status) => String(status || "").toLowerCase() === "bootleg") ? 1 : 0;
}

function isProperNameExtension(query, name) {
  const normalizedQuery = normalizeText(query);
  const normalizedName = normalizeText(name);
  return (
    Boolean(normalizedQuery) &&
    Boolean(normalizedName) &&
    normalizedName !== normalizedQuery &&
    normalizedName.startsWith(`${normalizedQuery} `)
  );
}

export function artistNamesMatch(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  return Boolean(a) && a === b;
}

export function rankArtistCandidates(query, candidates = []) {
  const normalizedQuery = normalizeText(query);
  return [...candidates].sort((left, right) => {
    const leftName = String(left?.name || "").trim();
    const rightName = String(right?.name || "").trim();
    const leftExact = normalizeText(leftName) === normalizedQuery ? 1 : 0;
    const rightExact = normalizeText(rightName) === normalizedQuery ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;

    const leftExtension = isProperNameExtension(normalizedQuery, leftName) ? 1 : 0;
    const rightExtension = isProperNameExtension(normalizedQuery, rightName) ? 1 : 0;
    if (leftExtension !== rightExtension) return leftExtension - rightExtension;

    const leftScore = Number(left?.score || 0);
    const rightScore = Number(right?.score || 0);
    if (leftScore !== rightScore) return rightScore - leftScore;

    const leftType = left?.type ? 1 : 0;
    const rightType = right?.type ? 1 : 0;
    if (leftType !== rightType) return rightType - leftType;

    const leftDisambiguation = left?.disambiguation ? 1 : 0;
    const rightDisambiguation = right?.disambiguation ? 1 : 0;
    if (leftDisambiguation !== rightDisambiguation) {
      return rightDisambiguation - leftDisambiguation;
    }

    const leftImageCount = Array.isArray(left?.images) ? left.images.length : 0;
    const rightImageCount = Array.isArray(right?.images) ? right.images.length : 0;
    if (leftImageCount !== rightImageCount) return rightImageCount - leftImageCount;

    return leftName.localeCompare(rightName);
  });
}

export function rankAlbumCandidates(
  albumTitle,
  candidates = [],
  { artistName = "", releaseYear = null } = {},
) {
  const normalizedArtist = normalizeText(artistName);
  const targetYear = getYear(releaseYear);
  return [...candidates].sort((left, right) => {
    const leftTitleScore = scoreTextMatch(left?.title, albumTitle);
    const rightTitleScore = scoreTextMatch(right?.title, albumTitle);
    if (leftTitleScore !== rightTitleScore) {
      return rightTitleScore - leftTitleScore;
    }

    const leftArtistScore = normalizedArtist ? scoreTextMatch(left?.artistName, artistName) : 0;
    const rightArtistScore = normalizedArtist ? scoreTextMatch(right?.artistName, artistName) : 0;
    if (leftArtistScore !== rightArtistScore) {
      return rightArtistScore - leftArtistScore;
    }

    const leftYear = getYear(left?.releaseDate);
    const rightYear = getYear(right?.releaseDate);
    const leftYearScore =
      targetYear && leftYear === targetYear ? 1 : targetYear && leftYear ? -1 : 0;
    const rightYearScore =
      targetYear && rightYear === targetYear ? 1 : targetYear && rightYear ? -1 : 0;
    if (leftYearScore !== rightYearScore) {
      return rightYearScore - leftYearScore;
    }

    const leftTypeRank = typeRank(left?.type);
    const rightTypeRank = typeRank(right?.type);
    if (leftTypeRank !== rightTypeRank) return leftTypeRank - rightTypeRank;

    const leftBootleg = bootlegPenalty(left);
    const rightBootleg = bootlegPenalty(right);
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;

    const leftScore = Number(left?.score || 0);
    const rightScore = Number(right?.score || 0);
    if (leftScore !== rightScore) return rightScore - leftScore;

    return String(left?.title || "").localeCompare(String(right?.title || ""));
  });
}
