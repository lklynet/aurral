import axios from "../../../lib/axiosFetch.js";
import createRateLimiter from "./rateLimiter.js";
import createCache from "./simpleCache.js";
import { dbOps } from "../../db/helpers/index.js";
import {
  MUSICBRAINZ_API,
  APP_NAME,
  APP_VERSION,
} from "../../config/constants.js";
import {
  getArtistByMbid as getMetadataArtistByMbid,
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  legacyMusicbrainzRequest,
  listArtistAlbums as listMetadataArtistAlbums,
  resolveArtistByName as resolveMetadataArtistByName,
  resolveLibraryArtistByName as resolveMetadataLibraryArtistByName,
} from "../providers/brainzmashProvider.js";
import { getLinkedArtistProviderIds } from "../providers/brainzmashMappers.js";
import { getMusicBrainzContact } from "./config.js";
import { runSharedInflight } from "../sharedInflight.js";
import { logger } from "../logger.js";

const musicbrainzArtistNameCache = createCache(3600);
const musicbrainzReleaseGroupsCache = createCache(300);
const musicbrainzAppearsOnCache = createCache(6 * 60 * 60, 200);
const musicbrainzTagArtistsCache = createCache(6 * 60 * 60, 200);
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
const APPEARS_ON_PAGE_SIZE = 100;
const APPEARS_ON_MAX_RELEASES = 1000;
const musicbrainzInflightRequests = new Map();
const PRIMARY_RELEASE_TYPES = ["Album", "EP", "Single"];
const SECONDARY_RELEASE_TYPES = [
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
];

const mbLimiter = createRateLimiter(1000);

export const musicbrainzRequest = async (endpoint, params = {}) =>
  legacyMusicbrainzRequest(endpoint, params);

export async function musicbrainzGetArtistReleaseGroups(
  mbid,
  selectedReleaseTypes = null,
  { includeTrackCounts = true, hydrateLimit = includeTrackCounts ? 30 : 6, signal } = {},
) {
  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) >= 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : includeTrackCounts
        ? 30
        : 6;
  const cacheKey = `full:${mbid}:${JSON.stringify(selectedReleaseTypes || [])}:${includeTrackCounts ? "rated" : "dated"}:${safeHydrateLimit}`;
  const cached = musicbrainzReleaseGroupsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const items = await listMetadataArtistAlbums(mbid, {
      releaseTypes: selectedReleaseTypes || [],
      includeTrackCounts,
      hydrateLimit: safeHydrateLimit,
      signal,
    });
    const mapped = items.map((item) => ({
      id: item.id,
      title: item.title || "",
      "first-release-date": item.firstReleaseDate || null,
      "primary-type": item.type || "Album",
      "secondary-types": Array.isArray(item.secondaryTypes)
        ? item.secondaryTypes
        : [],
      rating: item.rating || null,
      "artist-credit": item.artistName
        ? [
            {
              name: item.artistName,
              artist: item.artistId
                ? { id: item.artistId, name: item.artistName }
                : { name: item.artistName },
            },
          ]
        : [],
    }));
    musicbrainzReleaseGroupsCache.set(cacheKey, mapped);
    return mapped;
  } catch {
    return [];
  }
}

const artistCreditIncludesMbid = (artistCredit, mbid) => {
  const normalizedMbid = String(mbid || "")
    .trim()
    .toLowerCase();
  if (!normalizedMbid || !Array.isArray(artistCredit)) return false;
  return artistCredit.some(
    (credit) =>
      String(credit?.artist?.id || "")
        .trim()
        .toLowerCase() === normalizedMbid,
  );
};

const getMusicbrainzUserAgent = () => {
  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  return `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
};

const browseMusicbrainzTrackArtistReleases = async (mbid, { offset = 0, signal } = {}) => {
  const userAgent = getMusicbrainzUserAgent();
  return mbLimiter.schedule(async () => {
    signal?.throwIfAborted?.();
    const response = await axios.get(`${MUSICBRAINZ_API}/release`, {
      params: {
        fmt: "json",
        track_artist: mbid,
        inc: "release-groups+artist-credits",
        limit: APPEARS_ON_PAGE_SIZE,
        offset,
      },
      headers: { "User-Agent": userAgent },
      timeout: 8000,
      signal,
    });
    return response.data;
  });
};

const isSpecialPurposeArtist = (artist) =>
  artist.id === VARIOUS_ARTISTS_MBID || /^\[.*\]$/.test(artist.name);

export async function musicbrainzSearchArtistsByTag(tag, { limit = 25, offset = 0 } = {}) {
  const normalizedTag = String(tag || "").trim().toLowerCase();
  if (!normalizedTag) return { total: 0, nextOffset: 0, artists: [] };
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const cacheKey = `${normalizedTag}:${safeLimit}:${safeOffset}`;
  const cached = musicbrainzTagArtistsCache.get(cacheKey);
  if (cached) return cached;
  const data = await mbLimiter.schedule(async () => {
    const response = await axios.get(`${MUSICBRAINZ_API}/artist`, {
      params: {
        fmt: "json",
        query: `tag:"${normalizedTag.replace(/["\\]/g, "\\$&")}"`,
        limit: safeLimit,
        offset: safeOffset,
      },
      headers: { "User-Agent": getMusicbrainzUserAgent() },
      timeout: 8000,
    });
    return response.data;
  });
  const artists = Array.isArray(data?.artists) ? data.artists : [];
  const result = {
    total: Number(data?.count) || 0,
    nextOffset: safeOffset + artists.length,
    artists: artists
      .filter((artist) => artist?.id && artist?.name && !isSpecialPurposeArtist(artist))
      .map((artist) => ({ mbid: artist.id, name: artist.name })),
  };
  musicbrainzTagArtistsCache.set(cacheKey, result);
  return result;
}

const mapAppearsOnReleaseGroup = (release) => {
  const releaseGroup = release["release-group"];
  const artistCredit =
    Array.isArray(releaseGroup["artist-credit"]) && releaseGroup["artist-credit"].length
      ? releaseGroup["artist-credit"]
      : Array.isArray(release["artist-credit"])
        ? release["artist-credit"]
        : [];
  return {
    id: releaseGroup.id,
    title: releaseGroup.title || release.title || "Untitled release",
    "first-release-date": releaseGroup["first-release-date"] || release.date || null,
    "primary-type": releaseGroup["primary-type"] || "Album",
    "secondary-types": Array.isArray(releaseGroup["secondary-types"])
      ? releaseGroup["secondary-types"]
      : [],
    rating: null,
    "artist-credit": artistCredit,
    releases: release.id
      ? [
          {
            id: release.id,
            status: release.status || null,
            date: release.date || null,
            title: release.title || releaseGroup.title || "Untitled release",
          },
        ]
      : [],
  };
};

const scanAppearsOnPage = async (mbid, state, signal) => {
  const data = await browseMusicbrainzTrackArtistReleases(mbid, {
    offset: state.nextOffset,
    signal,
  });
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  for (const release of releases) {
    const releaseGroupId = String(release?.["release-group"]?.id || "").trim();
    if (!releaseGroupId || state.byReleaseGroupId.has(releaseGroupId)) continue;
    if (
      artistCreditIncludesMbid(release["artist-credit"], mbid) ||
      artistCreditIncludesMbid(release["release-group"]["artist-credit"], mbid)
    ) {
      continue;
    }
    state.byReleaseGroupId.set(releaseGroupId, mapAppearsOnReleaseGroup(release));
  }
  state.nextOffset += releases.length;
  const releaseCount = Number(data?.["release-count"]);
  state.complete =
    releases.length === 0 ||
    state.nextOffset >= APPEARS_ON_MAX_RELEASES ||
    (Number.isFinite(releaseCount) && state.nextOffset >= releaseCount);
  musicbrainzAppearsOnCache.set(mbid, state);
  return state;
};

export async function musicbrainzGetArtistAppearsOnReleaseGroups(
  mbid,
  { limit = 24, offset = 0, signal, scanPageBudget = 1 } = {},
) {
  if (!mbid) return [];
  const safeLimit = Math.min(
    250,
    Math.max(1, Number.parseInt(limit, 10) || 24),
  );
  const safeOffset = Math.min(250, Math.max(0, Number.parseInt(offset, 10) || 0));
  const targetCount = Math.min(250, safeOffset + safeLimit);
  const parsedScanPageBudget = Number.parseInt(scanPageBudget, 10);
  const safeScanPageBudget = Math.min(
    10,
    Math.max(0, Number.isFinite(parsedScanPageBudget) ? parsedScanPageBudget : 1),
  );

  let state = musicbrainzAppearsOnCache.get(mbid) || {
    byReleaseGroupId: new Map(),
    nextOffset: 0,
    complete: false,
  };
  try {
    for (
      let scannedPages = 0;
      state.byReleaseGroupId.size < targetCount &&
      !state.complete &&
      scannedPages < safeScanPageBudget;
      scannedPages += 1
    ) {
      const current = state;
      state = await runSharedInflight(
        musicbrainzInflightRequests,
        `appears-on-page:${mbid}`,
        (sharedSignal) => scanAppearsOnPage(mbid, current, sharedSignal),
        { signal },
      );
    }
  } catch (error) {
    if (!signal?.aborted && error?.name !== "AbortError") {
      logger.warn("musicbrainz", "Artist appearances lookup failed", {
        mbid,
        message: error.message,
      });
    }
    throw error;
  }

  return [...state.byReleaseGroupId.values()]
    .sort((left, right) =>
      String(right["first-release-date"] || "").localeCompare(
        String(left["first-release-date"] || ""),
      ),
    )
    .slice(safeOffset, targetCount);
}

export const getMusicbrainzAppearsOnScanState = (mbid) => {
  const state = musicbrainzAppearsOnCache.get(mbid);
  if (!state) return { complete: false, nextOffset: 0 };
  return {
    complete: state.complete,
    nextOffset: state.nextOffset,
  };
};

export async function musicbrainzGetArtistNameByMbid(mbid, { signal } = {}) {
  if (!mbid) return null;
  const cached = musicbrainzArtistNameCache.get(mbid);
  if (cached !== undefined) return cached;
  try {
    const name = await getMetadataArtistNameByMbid(mbid, { signal });
    const normalized = name && typeof name === "string" ? name.trim() : null;
    musicbrainzArtistNameCache.set(mbid, normalized);
    return normalized;
  } catch (e) {
    musicbrainzArtistNameCache.set(mbid, null);
    return null;
  }
}

export async function musicbrainzGetArtistIdentityByMbid(mbid, { signal } = {}) {
  const normalizedMbid = String(mbid || "").trim();
  if (!normalizedMbid) return null;
  try {
    const artist = await getMetadataArtistByMbid(normalizedMbid, { signal });
    return {
      mbid: normalizedMbid,
      name: artist.name || null,
      aliases: [...new Set(artist.aliases)],
      providerIds: getLinkedArtistProviderIds(artist.links),
    };
  } catch {
    return null;
  }
}

function normalizeArtistNameKey(artistName) {
  return String(artistName || "")
    .trim()
    .toLowerCase();
}

export function musicbrainzGetCachedArtistMbidByName(artistName) {
  const normalized = normalizeArtistNameKey(artistName);
  if (!normalized) return null;
  const cached = dbOps.getMusicbrainzArtistMbidCache(normalized);
  if (!cached?.updatedAt) return null;
  const ageMs = Date.now() - cached.updatedAt;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (ageMs < 0 || ageMs >= cacheTtl) return null;
  return cached.mbid || null;
}

async function resolveCachedArtistMbid(cacheKey, artistName, resolve, { throwOnError = false } = {}) {
  const cached = dbOps.getMusicbrainzArtistMbidCache(cacheKey);
  const now = Date.now();
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  if (cached?.updatedAt) {
    const ageMs = now - cached.updatedAt;
    const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (ageMs >= 0 && ageMs < cacheTtl) {
      return cached.mbid || null;
    }
  }
  try {
    const resolved = await resolve(artistName);
    dbOps.setMusicbrainzArtistMbidCache(cacheKey, resolved);
    return resolved;
  } catch (e) {
    if (throwOnError) throw e;
    if (cached) {
      return cached.mbid || null;
    }
    return null;
  }
}

export async function musicbrainzResolveArtistMbidByName(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  return resolveCachedArtistMbid(
    normalizeArtistNameKey(rawName),
    rawName,
    resolveMetadataArtistByName,
  );
}

export async function musicbrainzResolveLibraryArtistMbid(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  return resolveCachedArtistMbid(
    `library:${normalizeArtistNameKey(rawName)}`,
    rawName,
    resolveMetadataLibraryArtistByName,
    { throwOnError: true },
  );
}

export {
  PRIMARY_RELEASE_TYPES,
  SECONDARY_RELEASE_TYPES,
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
  musicbrainzTagArtistsCache,
};
