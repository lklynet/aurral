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
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  legacyMusicbrainzRequest,
  listArtistAlbums as listMetadataArtistAlbums,
  resolveArtistByName as resolveMetadataArtistByName,
} from "../providers/brainzmashProvider.js";
import { getMusicBrainzContact } from "./config.js";
import { runSharedInflight } from "../sharedInflight.js";

const musicbrainzArtistNameCache = createCache(3600);
const musicbrainzArtistIdentityCache = createCache(3600);
const musicbrainzReleaseGroupsCache = createCache(300);
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

const getReleaseGroupArtistId = (releaseGroup) => {
  const artistCredit = Array.isArray(releaseGroup?.["artist-credit"])
    ? releaseGroup["artist-credit"]
    : [];
  return String(artistCredit[0]?.artist?.id || "").trim() || null;
};

const officialMusicbrainzRecordingSearch = async (
  mbid,
  { limit = 100, offset = 0, signal } = {},
) => {
  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
  const safeLimit = Math.min(
    100,
    Math.max(1, Number.parseInt(limit, 10) || 100),
  );
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return mbLimiter.schedule(async () => {
    signal?.throwIfAborted?.();
    const response = await axios.get(`${MUSICBRAINZ_API}/recording`, {
      params: {
        fmt: "json",
        query: `arid:${mbid}`,
        inc: "artist-credits+releases",
        limit: safeLimit,
        offset: safeOffset,
      },
      headers: { "User-Agent": userAgent },
      timeout: 8000,
      signal,
    });
    return response.data;
  });
};

const mapAppearsOnReleaseGroup = (releaseGroup, release, recording, mbid) => {
  const artistCredit = Array.isArray(releaseGroup?.["artist-credit"])
    ? releaseGroup["artist-credit"]
    : Array.isArray(release?.["artist-credit"])
      ? release["artist-credit"]
      : [];
  return {
    id: releaseGroup?.id,
    title: releaseGroup?.title || release?.title || "Untitled release",
    "first-release-date":
      releaseGroup?.["first-release-date"] || release?.date || null,
    "primary-type": releaseGroup?.["primary-type"] || "Album",
    "secondary-types": Array.isArray(releaseGroup?.["secondary-types"])
      ? releaseGroup["secondary-types"]
      : [],
    rating: null,
    "artist-credit": artistCredit,
    _appearsOn: true,
    _appearsOnTrack: recording?.title || null,
    _appearsOnArtistMbid: mbid,
    releases: release?.id
      ? [
          {
            id: release.id,
            status: release.status || null,
            date: release.date || null,
            title: release.title || releaseGroup?.title || "Untitled release",
          },
        ]
      : [],
  };
};

export async function musicbrainzGetArtistAppearsOnReleaseGroups(
  mbid,
  directReleaseGroups = [],
  { limit = 24, offset = 0, signal, scanPageBudget = 1 } = {},
) {
  if (!mbid) return [];
  const safeLimit = Math.min(
    250,
    Math.max(1, Number.parseInt(limit, 10) || 24),
  );
  const safeOffset = Math.min(250, Math.max(0, Number.parseInt(offset, 10) || 0));
  const targetCount = Math.min(250, safeOffset + safeLimit);
  const stateCacheKey = `appears-on-state:${mbid}`;

  const directIds = new Set(
    (Array.isArray(directReleaseGroups) ? directReleaseGroups : [])
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean),
  );

  try {
    const pageSize = 100;
    const parsedScanPageBudget = Number.parseInt(scanPageBudget, 10);
    const safeScanPageBudget = Math.min(
      10,
      Math.max(0, Number.isFinite(parsedScanPageBudget) ? parsedScanPageBudget : 1),
    );
    let scannedPages = 0;
    let state = musicbrainzReleaseGroupsCache.get(stateCacheKey) || {
      byReleaseGroupId: new Map(),
      directIds: new Set(),
      nextOffset: 0,
      complete: false,
    };
    if (!(state.directIds instanceof Set)) state.directIds = new Set();
    for (const directId of directIds) state.directIds.add(directId);

    const getFilteredItems = () =>
      [...state.byReleaseGroupId.values()].filter((item) => !state.directIds.has(item.id));

    while (
      getFilteredItems().length < targetCount &&
      !state.complete &&
      state.nextOffset < 1000 &&
      scannedPages < safeScanPageBudget
    ) {
      await runSharedInflight(
        musicbrainzInflightRequests,
        `appears-on-page:${mbid}`,
        async (sharedSignal) => {
          state = musicbrainzReleaseGroupsCache.get(stateCacheKey) || state;
          if (state.complete || state.nextOffset >= 1000) return state;

          const data = await officialMusicbrainzRecordingSearch(mbid, {
            limit: pageSize,
            offset: state.nextOffset,
            signal: sharedSignal,
          });
          const recordings = Array.isArray(data?.recordings) ? data.recordings : [];

          for (const recording of recordings) {
            if (!artistCreditIncludesMbid(recording?.["artist-credit"], mbid)) continue;
            for (const release of Array.isArray(recording?.releases)
              ? recording.releases
              : []) {
              const releaseGroup = release?.["release-group"];
              const releaseGroupId = String(releaseGroup?.id || "").trim();
              if (!releaseGroupId || getReleaseGroupArtistId(releaseGroup) === mbid) continue;
              if (!state.byReleaseGroupId.has(releaseGroupId)) {
                state.byReleaseGroupId.set(
                  releaseGroupId,
                  mapAppearsOnReleaseGroup(releaseGroup, release, recording, mbid),
                );
              }
            }
          }

          state.nextOffset += pageSize;
          state.complete = recordings.length < pageSize || state.nextOffset >= 1000;
          musicbrainzReleaseGroupsCache.set(stateCacheKey, state);
          return state;
        },
        { signal },
      );
      scannedPages += 1;
      state = musicbrainzReleaseGroupsCache.get(stateCacheKey) || state;
    }

    const mapped = getFilteredItems()
      .sort((left, right) =>
        String(right["first-release-date"] || "").localeCompare(
          String(left["first-release-date"] || ""),
        ),
      )
      .slice(safeOffset, targetCount);
    return mapped;
  } catch {
    return [];
  }
}

export const getMusicbrainzAppearsOnScanState = (mbid) => {
  const state = musicbrainzReleaseGroupsCache.get(`appears-on-state:${mbid}`);
  if (!state) return { complete: false, nextOffset: 0, availableCount: 0 };
  const directIds = state.directIds instanceof Set ? state.directIds : new Set();
  const availableCount = [...state.byReleaseGroupId.values()].filter(
    (item) => !directIds.has(item.id),
  ).length;
  return {
    complete: Boolean(state.complete),
    nextOffset: Number(state.nextOffset || 0),
    availableCount,
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

function getMusicbrainzProviderId(resource) {
  try {
    const parsed = new URL(resource);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const artistIndex = segments.findIndex((segment) => segment.toLowerCase() === "artist");
    const artistId = artistIndex >= 0 ? segments[artistIndex + 1] : "";
    const numericId = String(artistId || "").match(/^\d+/)?.[0];
    if (!numericId) return null;
    if (host === "deezer.com") return `${numericId}@deezer`;
    if (host === "discogs.com") return `${numericId}@discogs`;
  } catch {}
  return null;
}

export async function musicbrainzGetArtistIdentityByMbid(mbid, { signal } = {}) {
  const normalizedMbid = String(mbid || "").trim();
  if (!normalizedMbid) return null;
  const cached = musicbrainzArtistIdentityCache.get(normalizedMbid);
  if (cached !== undefined) return cached;

  try {
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    const identity = await mbLimiter.schedule(async () => {
      signal?.throwIfAborted?.();
      const response = await axios.get(
        `${MUSICBRAINZ_API}/artist/${encodeURIComponent(normalizedMbid)}`,
        {
          params: { fmt: "json", inc: "url-rels+aliases" },
          headers: { "User-Agent": userAgent },
          timeout: 8000,
          signal,
        },
      );
      const providerIds = [
        ...(Array.isArray(response.data?.relations) ? response.data.relations : []),
      ]
        .map((relation) => getMusicbrainzProviderId(relation?.url?.resource))
        .filter(Boolean);
      const name = String(response.data?.name || "").trim() || null;
      const aliases = Array.isArray(response.data?.aliases)
        ? response.data.aliases
            .map((alias) => String(alias?.name || "").trim())
            .filter(Boolean)
        : [];
      return {
        mbid: normalizedMbid,
        name,
        aliases: [...new Set(aliases)],
        providerIds: [...new Set(providerIds)],
      };
    });
    musicbrainzArtistIdentityCache.set(normalizedMbid, identity);
    return identity;
  } catch (error) {
    if (error?.response?.status === 404) {
      musicbrainzArtistIdentityCache.set(normalizedMbid, null);
    }
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

export async function musicbrainzResolveArtistMbidByName(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  const normalized = normalizeArtistNameKey(rawName);
  const cached = dbOps.getMusicbrainzArtistMbidCache(normalized);
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
    const resolved = await resolveMetadataArtistByName(rawName);
    dbOps.setMusicbrainzArtistMbidCache(normalized, resolved);
    return resolved;
  } catch (e) {
    if (cached) {
      return cached.mbid || null;
    }
    return null;
  }
}

export {
  PRIMARY_RELEASE_TYPES,
  SECONDARY_RELEASE_TYPES,
  musicbrainzArtistNameCache,
  musicbrainzArtistIdentityCache,
  musicbrainzReleaseGroupsCache,
};
