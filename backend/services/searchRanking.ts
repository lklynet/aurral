export const CATALOG_POPULARITY_LOG_BASE = 6;

export function isCatalogPopularityScore(score) {
  return Number.isFinite(score) && score > 100;
}

export function catalogPopularityToUnit(score) {
  return Math.min(1, Math.log10(score + 1) / CATALOG_POPULARITY_LOG_BASE);
}

export function normalizeRelevanceScore(item) {
  const raw = Number(item?.score);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (item?.source === "library") {
    return Math.min(1, raw / 100);
  }
  if (raw <= 1) return raw;
  if (isCatalogPopularityScore(raw)) {
    return catalogPopularityToUnit(raw);
  }
  return Math.min(1, raw / 100);
}

const LIBRARY_TIER_STEP = 0.015;

function getLibraryTier(item) {
  if (item?.type === "playlist" && item.inLibrary) return 10;
  if (item?.inPlaylist) {
    if (item.type === "track") return 7;
    if (item.type === "album") return 6;
  }
  if (item?.inLibrary && item?.libraryBoostEligible !== false) {
    if (item.type === "track") return 7;
    if (item.type === "artist") return 5;
    return 4;
  }
  return 0;
}

function getContextBoostNormalized(item) {
  const raw = Number(item?.contextBoost || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(0.1, raw / 5000);
}

function getPrimaryMatchBoost(item) {
  const matchScore = Number(item?.primaryMatchScore || 0);
  if (matchScore >= 100) return 0.03;
  if (matchScore >= 92) return 0.015;
  return 0;
}

export function getSearchRankScore(item) {
  const relevance = normalizeRelevanceScore(item);
  const tierBoost = getLibraryTier(item) * LIBRARY_TIER_STEP;
  return relevance + tierBoost + getContextBoostNormalized(item) + getPrimaryMatchBoost(item);
}

export function compareSearchResults(left, right) {
  const scoreDiff = getSearchRankScore(right) - getSearchRankScore(left);
  if (scoreDiff !== 0) return scoreDiff;
  const leftRank = Number(left?.catalogRank);
  const rightRank = Number(right?.catalogRank);
  if (Number.isFinite(leftRank) && Number.isFinite(rightRank)) {
    return leftRank - rightRank;
  }
  return 0;
}

export function getLocalMatchThreshold(query) {
  const wordCount = String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (wordCount >= 3) return 78;
  if (wordCount === 2) return 45;
  return 16;
}
