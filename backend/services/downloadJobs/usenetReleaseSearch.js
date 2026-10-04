// Usenet release-candidate scoring.
//
// Usenet results are releases, not individual tracks, so pre-download
// ranking stays release-oriented (title identity gate plus format/size/noise
// tie-breakers). Post-download identity is validated by the shared
// trackMatching engine: downloaded files are assigned to expected tracks
// with native one-to-one assignment and validated per file.

import path from "path";
import {
  foldDiacritics,
  normalizeReleaseText as normalizeText,
  normalizeTitle,
  getYear,
} from "../providers/brainzmashRanking.js";
import { coreAlbumTitle, isVariousArtistsCredit } from "../trackMatching/titleText.js";
import { checkVariantCompatibility } from "../trackMatching/semanticPolicy.js";

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

function titleWords(value) {
  return foldDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// True when the phrase's words appear in a row in the release title. A
// release title adds the year, format, and group around the artist and
// album, so the whole-title similarity used before rejected short albums:
// "Lemonade" in "Beyonce feat. Kendrick Lamar - Lemonade (2016) MP3".
function containsPhrase(words, phrase) {
  const target = titleWords(phrase);
  if (target.length === 0) return false;
  for (let start = 0; start + target.length <= words.length; start += 1) {
    if (target.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

function withoutCredits(title) {
  return String(title || "")
    .replace(/\s*[[(][^\])]*[\])]/gu, " ")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, "")
    .trim();
}

function readReleaseRequest(context) {
  const compilation = context?.compilation === true || isVariousArtistsCredit(context?.artistName);
  const artists = (compilation ? creditedArtists(context) : [context?.artistName, ...(context?.artistAliases || [])])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .flatMap((name) => [name, name.replace(/^the\s+/iu, "")]);
  const albumName = readComparableAlbumName(context);
  const trackName = String(context?.trackName || "").trim();
  return {
    compilation,
    artists,
    albumName,
    albums: [albumName, coreAlbumTitle(albumName)].filter(Boolean),
    trackName,
    tracks: [trackName, withoutCredits(trackName)].filter(Boolean),
  };
}

export function rankUsenetReleases(releases, context, options = {}) {
  const request = readReleaseRequest(context);
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
    const raw = { release, file: title, size: Number(release.size || 0), downloadUrl: release.downloadUrl,
      indexerId: release.indexerId, indexer: release.indexer, guid: release.guid };
    const words = titleWords(title);

    // Identity gate: the artist (any artist for a compilation) and the album
    // or track title appear in the release title.
    const hasAlbum = request.albums.some((album) => containsPhrase(words, album));
    const hasArtist = (request.compilation && hasAlbum)
      || request.artists.some((name) => containsPhrase(words, name));
    const hasTrack = !hasAlbum && request.tracks.some((track) => containsPhrase(words, track));
    // A single or track release must be the requested version: a remix or
    // radio edit of the track is not downloaded for the original.
    const otherVersion = hasTrack
      && !checkVariantCompatibility({ trackName: request.trackName }, { title }).compatible;
    const admissible = hasAudioCategory(release) && hasArtist && (hasAlbum || hasTrack) && !otherVersion;
    if (!admissible) {
      ranked.push({
        raw,
        score: 0,
        resolvedAlbumName: null,
        releaseAdmissible: false,
        scores: { artist: hasArtist ? 100 : 0, track: hasTrack ? 100 : 0, album: hasAlbum ? 100 : 0,
          year: 0, format: 0, size: 0 },
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
      raw,
      score: tieScore,
      resolvedAlbumName: hasAlbum ? request.albumName : null,
      releaseAdmissible: true,
      scores: { artist: 100, track: hasTrack ? 100 : 0, album: hasAlbum ? 100 : 0,
        year: yearScore, format: formatScore, size: sizeScore },
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

const PROWLARR_MUSIC_QUERY = /^\{artist:/iu;

// Lidarr's query title: no leading "The", no accents, and each run of
// characters other than letters, digits, and apostrophes becomes a space.
// "AC/DC Back in Black" found 2 releases on a test indexer set; "AC DC Back
// in Black" found 75.
export function newznabQueryText(value) {
  const text = foldDiacritics(String(value || ""))
    .replace(/[\u0060\u00B4\u2018\u2019]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/^the\s+/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || String(value || "").trim();
}

// Lidarr's plan: a Newznab music search when an indexer supports it, then
// one "Artist Album" text search. A track also tries "Artist Title" for a
// single. A compilation is listed as "VA" or by its title alone.
// A compilation track's job names the track's own artist as an alias.
function creditedArtists(context) {
  return (context?.artistAliases || [])
    .map((name) => String(name || "").trim())
    .filter((name) => name && !isVariousArtistsCredit(name));
}

export function buildUsenetSearchQueries(context, { musicSearch = false, albumGrab = false } = {}) {
  const compilation = context?.compilation === true || isVariousArtistsCredit(context?.artistName);
  const artist = compilation ? "VA" : newznabQueryText(context?.artistName);
  const trackArtist = compilation ? newznabQueryText(creditedArtists(context)[0]) : artist;
  const album = context?.albumName ? newznabQueryText(coreAlbumTitle(context.albumName)) : "";
  const track = albumGrab ? "" : newznabQueryText(context?.trackName);
  const year = album && artist.toLowerCase() === album.toLowerCase() ? getYear(context?.releaseYear) : null;
  const join = (...parts) => parts.filter(Boolean).join(" ");
  const queries = [];
  if (musicSearch && !compilation && artist && album) {
    queries.push(`{artist:${artist}}{album:${album}}${year ? `{year:${year}}` : ""}`);
  }
  if (artist && album) queries.push(join(artist, album, year));
  if (compilation && album) queries.push(album);
  if (trackArtist && track) queries.push(join(trackArtist, track));
  return [...new Set(queries)];
}

export function isProwlarrMusicQuery(query) {
  return PROWLARR_MUSIC_QUERY.test(String(query || ""));
}

export function isAudioFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return [
    ".flac", ".mp3", ".m4a", ".ogg", ".wav",
    ".aac", ".opus", ".alac", ".ape", ".wma",
  ].includes(ext);
}
