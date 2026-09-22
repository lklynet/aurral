// Soulseek search-query construction and result grouping.
//
// This module owns everything about *finding* Soulseek content: query tiers,
// artist wildcard bypasses for banned-word filters, and grouping search hits
// into release folders. Identity scoring lives in the shared trackMatching
// engine.

import { getYear } from "../providers/brainzmashRanking.js";
import { getPathParts } from "../trackMatching/candidateNormalizer.js";

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

export function buildTrackQueryVariants(trackName) {
  const raw = String(trackName || "").trim();
  if (!raw) return [];
  const variants = [raw];
  const stripped = stripParenthetical(raw);
  if (stripped && stripped.toLowerCase() !== raw.toLowerCase()) {
    variants.push(stripped);
  }
  const normalized = stripVersionSuffix(raw);
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
  return {
    artistName: String(context?.artistName || "").trim(),
    trackName: String(context?.trackName || "").trim(),
    albumName: stripReleaseTypeSuffix(context?.albumName),
    releaseYear: getYear(context?.releaseYear),
    trackVariants: buildTrackQueryVariants(context?.trackName),
  };
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

function buildAlbumOnlyTierQueries(ctx) {
  if (!ctx.albumName) return [];
  return uniqueQueries([ctx.albumName], 1);
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
  const albumOnly = buildAlbumOnlyTierQueries(ctx);
  if (albumOnly.length > 0) {
    tiers.push({ tier: 2, name: "album_only", queries: albumOnly });
  }
  const albumTrack = buildAlbumTrackTierQueries(ctx);
  if (albumTrack.length > 0) {
    tiers.push({ tier: albumOnly.length > 0 ? 3 : 2, name: "album_track", queries: albumTrack });
  }
  const priorQueries = new Set(
    tiers.flatMap((tier) => tier.queries.map((query) => query.toLowerCase())),
  );
  const primaryTrack = buildPrimaryTrackTierQueries(ctx).filter(
    (query) => !priorQueries.has(query.toLowerCase()),
  );
  if (primaryTrack.length > 0) {
    let primaryTrackTier = 3;
    if (albumOnly.length > 0) primaryTrackTier = 4;
    if (tiers.length === 0) primaryTrackTier = 0;
    tiers.push({
      tier: primaryTrackTier,
      name: "primary_track",
      queries: primaryTrack,
    });
  }
  return tiers;
}

function getDirectoryKey(item) {
  const parts = getPathParts(item?.file);
  if (parts.length === 0) return null;
  const directory = parts.slice(0, -1).join("/");
  const user = String(item?.user || "").trim();
  return `${user}\0${directory}`;
}

export function isLockedSearchResult(item) {
  return item?.locked === true || item?.isLocked === true;
}

export function countAudioFiles(files, isAudioFile) {
  return files.filter((item) => isAudioFile(String(item?.file || ""))).length;
}

// Groups raw slskd search results into per-user release folders, attaching
// the audio files each folder holds. Folder grouping is Soulseek-specific
// acquisition context that the shared engine never sees.
export function groupFlowSearchResults(results, { isAudioFile } = {}) {
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
        !isLockedSearchResult(item) && (isAudioFile ? isAudioFile(String(item?.file || "")) : true),
    );
    if (group.audioFiles.length === 0) continue;
    grouped.push(group);
  }
  return grouped;
}

// Keeps candidate diversity: at most one attempt per user first, then
// additional files as needed.
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
