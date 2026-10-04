// Soulseek search-query construction and result grouping.
//
// This module owns everything about *finding* Soulseek content: query tiers,
// artist wildcard bypasses for banned-word filters, and grouping search hits
// into release folders. Identity scoring lives in the shared trackMatching
// engine.

import { getYear } from "../providers/brainzmashRanking.js";
import { getPathParts } from "../trackMatching/candidateNormalizer.js";
import { coreAlbumTitle, isVariousArtistsCredit } from "../trackMatching/titleText.js";

export function bypassBannedArtistTerm(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length < 2) {
    return trimmed;
  }
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (!word || word.startsWith("*") || word.length < 3) return word;
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

// Soulseek splits file paths into words at every character that is not a
// letter or digit and matches whole words, so "Pepper's" is found as
// "Pepper s" and never as "Peppers", and "Film: Part" never matches at all.
export function soulseekQueryText(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VOLUME_PATTERN = /\b(vol(?:ume)?\.?)\s*(\d{1,2}|[ivx]{1,4})\b/iu;
const ROMAN_NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"];

// "Vol. 2" is also written "Volume II"; folders use either.
function volumeVariant(value) {
  const match = VOLUME_PATTERN.exec(String(value || ""));
  if (!match) return "";
  const number = match[2].toLowerCase();
  const arabic = /^\d+$/.test(number) ? Number(number) : ROMAN_NUMERALS.indexOf(number) + 1;
  if (!(arabic >= 1 && arabic <= ROMAN_NUMERALS.length)) return "";
  const replacement = /^\d+$/.test(number)
    ? `Volume ${ROMAN_NUMERALS[arabic - 1].toUpperCase()}`
    : `Vol ${arabic}`;
  return String(value).replace(match[0], replacement);
}

function sameWords(left, right) {
  return Boolean(left) && left.toLowerCase() === String(right || "").toLowerCase();
}

function readTrackSearchContext(context) {
  const rawArtist = String(context?.artistName || "").trim();
  const compilation = context?.compilation === true || isVariousArtistsCredit(rawArtist);
  const rawAlbum = stripReleaseTypeSuffix(context?.albumName);
  const artistName = compilation ? "" : soulseekQueryText(rawArtist);
  const albumName = soulseekQueryText(rawAlbum);
  const coreAlbum = soulseekQueryText(coreAlbumTitle(rawAlbum));
  const albumVariant = soulseekQueryText(volumeVariant(coreAlbumTitle(rawAlbum)));
  const aliases = (context?.artistAliases || [])
    .filter((alias) => !isVariousArtistsCredit(alias))
    .map(soulseekQueryText)
    .filter((alias) => alias && !sameWords(alias, artistName));
  return {
    artistName,
    // A compilation track's job names the track's own artist as an alias.
    trackArtist: compilation ? aliases[0] || "" : artistName,
    albumName,
    coreAlbumName: sameWords(coreAlbum, albumName) ? "" : coreAlbum,
    albumVariant: sameWords(albumVariant, albumName) ? "" : albumVariant,
    alias: compilation ? "" : aliases.find((alias) => alias.length >= 4) || "",
    releaseYear: getYear(context?.releaseYear),
    selfTitled: sameWords(artistName, albumName),
    shortAlbum: albumName.length > 0 && albumName.length < 4,
    trackVariants: uniqueQueries(buildTrackQueryVariants(context?.trackName).map(soulseekQueryText)),
  };
}

function joinSearchParts(...parts) {
  return parts
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" ");
}

// "Artist Album". A self-titled album is "Artist Year" because "Weezer
// Weezer" lists every Weezer song; a short title such as "21" takes the year
// to stay specific. Many folders leave the year out, so a short title is
// also asked without it.
function artistAlbumQuery(ctx, artistName = ctx.artistName, { year = true } = {}) {
  if (!artistName || !ctx.albumName) return "";
  if (ctx.selfTitled) return year ? joinSearchParts(artistName, ctx.releaseYear) : "";
  return joinSearchParts(artistName, ctx.albumName, year && ctx.shortAlbum ? ctx.releaseYear : null);
}

function albumAloneQueries(ctx) {
  if (!ctx.albumName || ctx.selfTitled || ctx.shortAlbum) return [];
  return [ctx.albumName];
}

// Keeps each query once, in the first tier that asks it, and numbers the
// remaining tiers in order.
function orderTiers(tiers) {
  const seen = new Set();
  return tiers
    .map((tier) => ({
      ...tier,
      queries: tier.queries.filter((query) => {
        const key = String(query || "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    }))
    .filter((tier) => tier.queries.length > 0)
    .map((tier, index) => ({ tier: index, ...tier }));
}

function releaseFallbackTiers(ctx) {
  const wildcardArtist = bypassBannedArtistTerm(ctx.artistName);
  const wildcard = wildcardArtist !== ctx.artistName;
  return [
    { name: "album_without_year", queries: [artistAlbumQuery(ctx, ctx.artistName, { year: false })] },
    { name: "core_album", queries: [ctx.artistName && ctx.coreAlbumName
      ? joinSearchParts(ctx.artistName, ctx.coreAlbumName) : ctx.coreAlbumName] },
    { name: "volume_variant", queries: [ctx.albumVariant
      ? joinSearchParts(ctx.artistName, ctx.albumVariant) : ""] },
    { name: "wildcard_album", queries: wildcard ? [
      artistAlbumQuery(ctx, wildcardArtist),
      artistAlbumQuery(ctx, wildcardArtist, { year: false }),
    ] : [] },
    { name: "alias_album", queries: [artistAlbumQuery(ctx, ctx.alias)] },
  ];
}

// A whole-release grab needs results that list the album folder, so it
// searches for the album alone and never for one of its track titles. A
// compilation is searched without "Various Artists", which folder names
// rarely contain. A self-titled album falls back to the artist alone, the
// broadest query, last.
export function buildAlbumSearchTiers(context) {
  const ctx = readTrackSearchContext(context);
  return orderTiers([
    { name: "base_album", queries: [artistAlbumQuery(ctx) || ctx.albumName] },
    ...releaseFallbackTiers(ctx),
    { name: "artist_only", queries: [ctx.selfTitled ? ctx.artistName : ""] },
    { name: "album_only", queries: albumAloneQueries(ctx) },
  ]);
}

// A track search asks for the artist and album, then the artist and title.
// The album title alone matches the most unrelated folders, so it is last.
export function buildTrackSearchTiers(context) {
  const ctx = readTrackSearchContext(context);
  const [track, ...trackVariants] = ctx.trackVariants;
  const strippedTrack = stripVersionSuffix(track);
  const wildcardArtist = bypassBannedArtistTerm(ctx.trackArtist);
  return orderTiers([
    { name: "base_album", queries: [artistAlbumQuery(ctx)] },
    { name: "primary_track", queries: ctx.trackArtist && track ? [
      joinSearchParts(ctx.trackArtist, track),
      joinSearchParts(ctx.trackArtist, strippedTrack),
      ...trackVariants.slice(0, 1).map((variant) => joinSearchParts(ctx.trackArtist, variant)),
    ] : [] },
    ...releaseFallbackTiers(ctx),
    { name: "wildcard_track", queries: [wildcardArtist !== ctx.trackArtist && track
      ? joinSearchParts(wildcardArtist, track) : ""] },
    { name: "alias_track", queries: [ctx.alias && track ? joinSearchParts(ctx.alias, track) : ""] },
    { name: "album_track", queries: [ctx.albumName && track ? joinSearchParts(ctx.albumName, track) : ""] },
    { name: "album_only", queries: albumAloneQueries(ctx) },
  ]);
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
export function groupSoulseekSearchResults(results, { isAudioFile } = {}) {
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
