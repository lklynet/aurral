import axios from "../../../lib/axiosFetch.js";
import createCache from "../apiClients/simpleCache.js";
import { dbOps } from "../../db/helpers/index.js";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_METADATA_BASE_URL,
  MUSICBRAINZ_API,
} from "../../config/constants.js";
import {
  getNormalizedText,
  rankAlbumCandidates,
  rankArtistCandidates,
  scoreTextMatch,
} from "./brainzmashRanking.js";
import {
  toLegacyArtist,
  toLegacyRelease,
  toLegacyReleaseGroupSummary,
  toLegacySearchAlbumResult,
  toLegacySearchArtistResult,
  toNormalizedAlbum,
  toNormalizedArtist,
  toNormalizedArtistAlbum,
} from "./brainzmashMappers.js";
import { selectBestAlbumImage } from "../imageService.js";
import createRateLimiter from "../apiClients/rateLimiter.js";
import { runSharedInflight } from "../sharedInflight.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  getMetadataProviderBudget,
  reserveMetadataProviderRequest,
  setMetadataProviderCooldown,
} from "../metadataProviderBudget.js";

const METADATA_ENTITY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const METADATA_ENTITY_STALE_TTL_SECONDS = 30 * 24 * 60 * 60;
const METADATA_SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_NOT_FOUND_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS = 5_000;
const METADATA_RATE_LIMIT_MAX_COOLDOWN_MS = 60_000;
const METADATA_FORBIDDEN_COOLDOWN_MS = 5 * 60_000;
const METADATA_CACHE_MAX_ENTRIES = 20_000;
const METADATA_REQUEST_MIN_INTERVAL_MS = 100;
const METADATA_REQUEST_TIMEOUT_MS = 8000;
const METADATA_MAX_QUEUED_REQUESTS = Math.floor(
  METADATA_REQUEST_TIMEOUT_MS / METADATA_REQUEST_MIN_INTERVAL_MS,
) - 1;
const providerCache = createCache(
  METADATA_ENTITY_CACHE_TTL_SECONDS,
  METADATA_CACHE_MAX_ENTRIES,
);
const metadataNotFoundCache = createCache(
  METADATA_NOT_FOUND_CACHE_TTL_SECONDS,
  METADATA_CACHE_MAX_ENTRIES,
);
const releaseCache = createCache(300);
const providerInflightRequests = new Map();
const providerRequestLimiter = createRateLimiter(METADATA_REQUEST_MIN_INTERVAL_MS, {
  maxQueue: METADATA_MAX_QUEUED_REQUESTS,
});
const METADATA_MAX_RETRIES = 1;

export function clearMetadataProviderCaches() {
  providerCache.flushAll();
  metadataNotFoundCache.flushAll();
  releaseCache.flushAll();
  providerInflightRequests.clear();
}

const healthState = {
  configuredProvider: "brainzmash",
  activeBaseUrl: null,
  failoverActive: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: "",
};

function nowIso() {
  return new Date().toISOString();
}

function getSettingsMetadata() {
  const settings = dbOps.getSettings();
  return settings.integrations?.metadata || {};
}

function isNarrowFallbacksEnabled() {
  const metadata = getSettingsMetadata();
  return metadata.enableNarrowFallbacks !== false;
}

export function getMetadataBaseUrl() {
  const metadata = getSettingsMetadata();
  const raw = String(
    metadata.baseUrl || process.env.BRAINZMASH_BASE_URL || DEFAULT_METADATA_BASE_URL,
  ).trim();
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_METADATA_BASE_URL;
  }
}

function getUserAgent() {
  return `${APP_NAME}/${APP_VERSION}`;
}

function isEntityMetadataPath(path) {
  return /^\/(?:album|artist)\/[^/]+$/.test(path);
}

function createMetadataNotFoundError() {
  const error = new Error("Metadata resource not found");
  error.code = "ERR_METADATA_NOT_FOUND";
  error.response = { status: 404 };
  return error;
}

function createMetadataCircuitError(code, status, remainingMs) {
  const error = new Error(
    code === "ERR_METADATA_FORBIDDEN"
      ? "Metadata provider access is temporarily blocked"
      : "Metadata provider rate limit cooldown is active",
  );
  error.code = code;
  error.retryAfterMs = Math.max(0, Math.ceil(remainingMs));
  error.response = { status };
  return error;
}

function isMetadataCircuitError(error) {
  return error?.code === "ERR_METADATA_FORBIDDEN" || error?.code === "ERR_METADATA_RATE_LIMITED";
}

function getRetryAfterMs(error) {
  const retryAfter =
    error?.response?.headers?.["retry-after"] ?? error?.response?.headers?.["Retry-After"];
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(
      METADATA_RATE_LIMIT_MAX_COOLDOWN_MS,
      Math.max(METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS, seconds * 1000),
    );
  }
  const retryAt = Date.parse(String(retryAfter || ""));
  if (Number.isFinite(retryAt)) {
    return Math.min(
      METADATA_RATE_LIMIT_MAX_COOLDOWN_MS,
      Math.max(METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS, retryAt - Date.now()),
    );
  }
  return METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS;
}

function getMetadataCircuitError(baseUrl) {
  const now = Date.now();
  const budget = getMetadataProviderBudget(baseUrl);
  if (budget.forbidden_until > now) {
    return createMetadataCircuitError(
      "ERR_METADATA_FORBIDDEN",
      403,
      budget.forbidden_until - now,
    );
  }
  if (budget.rate_limited_until > now) {
    return createMetadataCircuitError(
      "ERR_METADATA_RATE_LIMITED",
      429,
      budget.rate_limited_until - now,
    );
  }
  return null;
}

function openMetadataCircuit(baseUrl, status, error) {
  const cooldownMs =
    status === 403 ? METADATA_FORBIDDEN_COOLDOWN_MS : getRetryAfterMs(error);
  setMetadataProviderCooldown(baseUrl, status, Date.now() + cooldownMs);
}

function isRetryable(error) {
  return (
    ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code) ||
    [408, 425, 429, 500, 502, 503, 504].includes(error?.response?.status)
  );
}

function getMetadataCachePolicy(path) {
  if (isEntityMetadataPath(path)) {
    return {
      freshTtlSeconds: METADATA_ENTITY_CACHE_TTL_SECONDS,
      staleTtlSeconds: METADATA_ENTITY_STALE_TTL_SECONDS,
    };
  }
  return {
    freshTtlSeconds: METADATA_SEARCH_CACHE_TTL_SECONDS,
    staleTtlSeconds: 0,
  };
}

function refreshMetadata(cacheKey, path, params, { signal } = {}) {
  const baseUrl = getMetadataBaseUrl();
  const cachePolicy = getMetadataCachePolicy(path);
  const circuitError = getMetadataCircuitError(baseUrl);
  if (circuitError) return Promise.reject(circuitError);
  healthState.activeBaseUrl = baseUrl;
  healthState.lastCheckedAt = nowIso();

  return runSharedInflight(providerInflightRequests, cacheKey, async (sharedSignal) => {
    for (let attempt = 0; attempt <= METADATA_MAX_RETRIES; attempt += 1) {
      if (sharedSignal.aborted) throw sharedSignal.reason || new Error("The operation was aborted");
      try {
        const response = await providerRequestLimiter.schedule(
          async (remainingMs) => {
            const activeCircuitError = getMetadataCircuitError(baseUrl);
            if (activeCircuitError) throw activeCircuitError;
            const admissionStarted = Date.now();
            let waitMs;
            while ((waitMs = reserveMetadataProviderRequest(baseUrl, METADATA_REQUEST_MIN_INTERVAL_MS)) > 0) {
              if (waitMs >= remainingMs - (Date.now() - admissionStarted)) {
                const error = new Error("Metadata provider request deadline exceeded");
                error.code = "ETIMEDOUT";
                throw error;
              }
              await delay(waitMs, undefined, { signal: sharedSignal });
              const waitingCircuit = getMetadataCircuitError(baseUrl);
              if (waitingCircuit) throw waitingCircuit;
            }
            const circuitAfterWait = getMetadataCircuitError(baseUrl);
            if (circuitAfterWait) throw circuitAfterWait;
            const requestTimeoutMs = remainingMs - (Date.now() - admissionStarted);
            if (requestTimeoutMs <= 0) {
              const error = new Error("Metadata provider request deadline exceeded");
              error.code = "ETIMEDOUT";
              throw error;
            }
            return axios.get(`${baseUrl}${path}`, {
              params,
              timeout: Number.isFinite(requestTimeoutMs)
                ? Math.max(1, Math.floor(requestTimeoutMs))
                : METADATA_REQUEST_TIMEOUT_MS,
              headers: {
                "User-Agent": getUserAgent(),
              },
              signal: sharedSignal,
            });
          },
          { signal: sharedSignal, timeoutMs: METADATA_REQUEST_TIMEOUT_MS },
        );
        providerCache.set(
          cacheKey,
          response.data,
          cachePolicy.freshTtlSeconds,
          cachePolicy.staleTtlSeconds,
        );
        metadataNotFoundCache.delete(cacheKey);
        healthState.lastSuccessAt = healthState.lastCheckedAt;
        healthState.lastFailureReason = "";
        return response.data;
      } catch (error) {
        if (sharedSignal.aborted) throw sharedSignal.reason || error;
        healthState.lastFailureAt = healthState.lastCheckedAt;
        healthState.lastFailureReason =
          error?.response?.status != null
            ? `HTTP ${error.response.status}`
            : error?.code || error?.message || "Unknown error";
        if ([403, 429].includes(error?.response?.status)) {
          if (!isMetadataCircuitError(error)) {
            openMetadataCircuit(baseUrl, error.response.status, error);
          }
          throw error;
        }
        if (error?.response?.status === 404 && isEntityMetadataPath(path)) {
          providerCache.delete(cacheKey);
          metadataNotFoundCache.set(cacheKey, true);
        }
        if (attempt === METADATA_MAX_RETRIES || !isRetryable(error)) throw error;
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(sharedSignal.reason || new Error("The operation was aborted"));
          };
          const timer = setTimeout(() => {
            sharedSignal.removeEventListener("abort", onAbort);
            resolve();
          }, 250);
          if (sharedSignal.aborted) onAbort();
          else sharedSignal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
    throw new Error("Metadata provider request failed");
  }, { signal });
}

async function request(path, params = {}, { signal, forceRefresh = false } = {}) {
  const baseUrl = getMetadataBaseUrl();
  const cacheKey = `${baseUrl}${path}:${JSON.stringify(params)}`;
  if (!forceRefresh && metadataNotFoundCache.get(cacheKey)) {
    throw createMetadataNotFoundError();
  }
  const cached = forceRefresh ? null : providerCache.getWithStale(cacheKey);
  if (cached) {
    if (cached.stale) {
      void refreshMetadata(cacheKey, path, params).catch(() => {});
    }
    return cached.value;
  }
  return refreshMetadata(cacheKey, path, params, { signal });
}

function applyReleaseTypeFilter(albums, releaseTypes = []) {
  const normalizedSet = new Set(
    (Array.isArray(releaseTypes)
      ? releaseTypes
      : String(releaseTypes || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
    ).map((value) => String(value)),
  );
  if (normalizedSet.size === 0) return albums;
  return albums.filter((album) => {
    if (normalizedSet.has(album.type)) return true;
    return (album.secondaryTypes || []).some((entry) => normalizedSet.has(entry));
  });
}

export function selectAlbumRelease(album) {
  const releases = Array.isArray(album?.releases) ? album.releases : [];
  return (
    releases.find(
      (release) =>
        String(release?.status || "").toLowerCase() === "official" &&
        Array.isArray(release?.tracks) &&
        release.tracks.length > 0,
    ) ||
    releases.find((release) => Array.isArray(release?.tracks) && release.tracks.length > 0) ||
    releases[0] ||
    null
  );
}

function storeAlbumReleaseMappings(album) {
  for (const release of album?.releases || []) {
    releaseCache.set(
      release.id,
      structuredClone({ albumId: album.id, release }),
    );  }
}

export async function getArtistByMbid(mbid, { signal } = {}) {
  const data = await request(`/artist/${mbid}`, {}, { signal });
  return toNormalizedArtist(data);
}

export async function getAlbumByMbid(albumMbid, { signal, forceRefresh = false } = {}) {
  const data = await request(`/album/${albumMbid}`, {}, { signal, forceRefresh });
  const normalized = toNormalizedAlbum(data);
  storeAlbumReleaseMappings(normalized);
  return normalized;
}

export async function getAlbumTracksByAlbumMbid(albumMbid) {
  const album = await getAlbumByMbid(albumMbid);
  const release = selectAlbumRelease(album);
  return Array.isArray(release?.tracks) ? release.tracks : [];
}

export async function searchArtists(query, { limit = 24, offset = 0, signal } = {}) {
  let items = [];
  try {
    const data = await request("/search/artist", {
      query,
      limit,
    }, { signal });
    const source = Array.isArray(data) ? data : [];
    items = source.map((entry) => ({
      ...toNormalizedArtist(entry),
    }));
  } catch {
    signal?.throwIfAborted();
  }
  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function searchAlbums(
  query,
  { artistName = "", limit = 24, offset = 0, releaseTypes = [], sort = "relevance", signal } = {},
) {
  const requestedLimit = Math.max(limit + offset, limit);
  let items = [];

  try {
    const data = await request("/search/album", {
      query,
      limit: requestedLimit,
      ...(artistName ? { artist: artistName } : {}),
    }, { signal });
    const source = Array.isArray(data) ? data : [];
    items = source.map((entry, index) => {
      const artists = Array.isArray(entry?.artists) ? entry.artists : [];
      const credited = artists.find((artist) => artist?.id && artist.id === entry?.artistid) || artists[0];
      const primaryArtist = credited ? toNormalizedArtist(credited) : null;
      const coverImage = selectBestAlbumImage(entry?.images);
      return {
        id: entry?.id,
        title: entry?.title || "Untitled Release",
        artistName: primaryArtist?.name || artistName || "Unknown Artist",
        artistId: entry?.artistid || primaryArtist?.id || null,
        type: entry?.type || "Album",
        secondaryTypes: Array.isArray(entry?.secondarytypes) ? entry.secondarytypes : [],
        releaseDate: entry?.releasedate || null,
        coverUrl: coverImage?.Url ? String(coverImage.Url).trim() : null,
        images: Array.isArray(entry?.images) ? entry.images : [],
        inLibrary: false,
        score: Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  } catch {
    signal?.throwIfAborted();
  }

  if (items.length === 0 && isNarrowFallbacksEnabled()) {
    const escapeLucenePhrase = (value) =>
      String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    const mbQuery = artistName
      ? `artist:"${escapeLucenePhrase(artistName)}" AND releasegroup:"${escapeLucenePhrase(query)}"`
      : String(query || "").trim();
    const response = await axios.get(`${MUSICBRAINZ_API}/release-group`, {
      params: {
        fmt: "json",
        query: mbQuery,
        limit: requestedLimit,
        offset: 0,
      },
      timeout: 8000,
      headers: {
        "User-Agent": `${APP_NAME}/${APP_VERSION} (metadata album fallback)`,
      },
      signal,
    });
    const source = Array.isArray(response?.data?.["release-groups"])
      ? response.data["release-groups"]
      : [];
    items = source.map((entry, index) => {
      const artistCredit = Array.isArray(entry?.["artist-credit"]) ? entry["artist-credit"] : [];
      const primaryArtist = artistCredit[0]?.artist || {};
      return {
        id: entry?.id,
        title: entry?.title || "Untitled Release",
        artistName: artistCredit[0]?.name || primaryArtist?.name || artistName || "Unknown Artist",
        artistId: primaryArtist?.id || null,
        type: entry?.["primary-type"] || "Album",
        secondaryTypes: Array.isArray(entry?.["secondary-types"]) ? entry["secondary-types"] : [],
        releaseDate: entry?.["first-release-date"] || null,
        coverUrl: null,
        images: [],
        inLibrary: false,
        score: Number(entry?.score || entry?.["ext:score"] || Math.max(0, 100 - index)) || 0,
        releaseStatuses: [],
      };
    });
  }

  items = applyReleaseTypeFilter(items, releaseTypes);

  if (sort === "relevance") {
    items = rankAlbumCandidates(query, items, { artistName });
  } else if (sort === "artistAsc") {
    items.sort(
      (left, right) =>
        String(left.artistName || "").localeCompare(String(right.artistName || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  } else if (sort === "titleAsc") {
    items.sort(
      (left, right) =>
        String(left.title || "").localeCompare(String(right.title || "")) ||
        String(left.artistName || "").localeCompare(String(right.artistName || "")),
    );
  } else if (sort === "dateDesc") {
    items.sort(
      (left, right) =>
        String(right.releaseDate || "").localeCompare(String(left.releaseDate || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  }

  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function resolveArtistByName(name) {
  const result = await searchArtists(name, { limit: 10, offset: 0 });
  const ranked = rankArtistCandidates(name, result.items);
  return ranked[0]?.id || null;
}

function artistNameForms(name) {
  const value = String(name || "").trim();
  const parts = value.split(",").map((part) => part.trim());
  const variants = parts.length === 2 && parts.every(Boolean)
    ? [value, `${parts[1]} ${parts[0]}`]
    : [value];
  return variants
    .map((variant) => getNormalizedText(variant).replace(/^the /, ""))
    .filter(Boolean);
}

export async function resolveLibraryArtistByName(name) {
  const forms = new Set(artistNameForms(name));
  if (forms.size === 0) return null;
  const data = await request("/search/artist", { query: String(name).trim(), limit: 10 });
  const matches = new Set(
    (Array.isArray(data) ? data : [])
      .map(toNormalizedArtist)
      .filter((artist) =>
        artist.id &&
        [artist.name, ...artist.aliases].some((candidate) =>
          artistNameForms(candidate).some((form) => forms.has(form)),
        ),
      )
      .map((artist) => artist.id),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

export async function resolveAlbumByArtistAndTitle({
  artistName = "",
  albumTitle = "",
  releaseYear = null,
}) {
  const pickStrongMatch = (candidates) =>
    candidates.find(
      (candidate) => candidate?.id && scoreTextMatch(candidate.title, albumTitle) >= 85,
    );
  const firstPass = await searchAlbums(albumTitle, {
    artistName,
    limit: 10,
    offset: 0,
  });
  let ranked = rankAlbumCandidates(albumTitle, firstPass.items, {
    artistName,
    releaseYear,
  });
  const firstMatch = pickStrongMatch(ranked);
  if (firstMatch?.id) return firstMatch.id;

  const secondPass = await searchAlbums(albumTitle, {
    artistName: "",
    limit: 10,
    offset: 0,
  });
  ranked = rankAlbumCandidates(albumTitle, secondPass.items, {
    artistName,
    releaseYear,
  });
  return pickStrongMatch(ranked)?.id || null;
}

export async function listArtistAlbums(
  artistMbid,
  {
    releaseTypes = [],
    includeTrackCounts = false,
    hydrateLimit = 30,
    signal,
    forceRefresh = false,
  } = {},
) {
  const rawArtist = await request(`/artist/${artistMbid}`, {}, { signal, forceRefresh });
  const artist = toNormalizedArtist(rawArtist);
  let albums = (Array.isArray(rawArtist?.Albums) ? rawArtist.Albums : []).map((entry) =>
    toNormalizedArtistAlbum(entry),
  );
  albums = applyReleaseTypeFilter(albums, releaseTypes);
  albums.sort((left, right) => {
    const leftBootleg = (left.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    const rightBootleg = (right.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;
    const typeOrder = { Album: 0, EP: 1, Single: 2 };
    const leftType = typeOrder[left.type] ?? 9;
    const rightType = typeOrder[right.type] ?? 9;
    if (leftType !== rightType) return leftType - rightType;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });

  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) >= 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : 30;
  await Promise.all(
    albums.slice(0, safeHydrateLimit).map(async (album) => {
      try {
        const needsDate = !album.firstReleaseDate;
        const needsRating = includeTrackCounts;
        if (!needsDate && !needsRating) return;

        const hydrated = await getAlbumByMbid(album.id, { signal });
        if (needsDate) {
          album.firstReleaseDate = hydrated.releaseDate || album.firstReleaseDate;
        }
        if (needsRating) {
          album.rating = hydrated.rating || null;
        }
      } catch {}
    }),
  );

  return albums.map((album) => ({
    ...album,
    artistName: artist.name,
    artistId: artist.id,
  }));
}

export async function getArtistGenres(artistMbid) {
  const artist = await getArtistByMbid(artistMbid);
  return artist.genres || [];
}

export async function getArtistNameByMbid(artistMbid, { signal } = {}) {
  const artist = await getArtistByMbid(artistMbid, { signal });
  return artist.name || null;
}

export function getMetadataProviderHealthSnapshot() {
  return {
    brainzmash: {
      configuredProvider: healthState.configuredProvider,
      activeBaseUrl: getMetadataBaseUrl(),
      failoverActive: healthState.failoverActive,
      lastCheckedAt: healthState.lastCheckedAt,
      lastSuccessAt: healthState.lastSuccessAt,
      lastFailureAt: healthState.lastFailureAt,
      lastFailureReason: healthState.lastFailureReason,
    },
  };
}

export async function legacyMusicbrainzRequest(endpoint, params = {}) {
  const normalizedEndpoint = String(endpoint || "").trim();
  if (normalizedEndpoint.startsWith("/artist/")) {
    const mbid = normalizedEndpoint.replace(/^\/artist\//, "").trim();
    const artist = await getArtistByMbid(mbid);
    return toLegacyArtist(artist);
  }

  if (normalizedEndpoint === "/artist") {
    const result = await searchArtists(String(params.query || "").trim(), {
      limit: params.limit || 24,
      offset: params.offset || 0,
    });
    return {
      count: result.count,
      offset: result.offset,
      artists: result.items.map((item) => toLegacySearchArtistResult(item, item.score)),
    };
  }

  if (normalizedEndpoint.startsWith("/release-group/")) {
    const mbid = normalizedEndpoint.replace(/^\/release-group\//, "").trim();
    const album = await getAlbumByMbid(mbid);
    return toLegacyReleaseGroupSummary(album, album.artists[0], { score: 100 });
  }

  if (normalizedEndpoint === "/release-group") {
    if (params.artist) {
      const items = await listArtistAlbums(String(params.artist).trim(), {
        releaseTypes: [],
      });
      const offset = Number.parseInt(params.offset, 10) || 0;
      const limit = Number.parseInt(params.limit, 10) || items.length;
      const paged = items.slice(offset, offset + limit);
      return {
        "release-group-count": items.length,
        "release-groups": paged.map((item) =>
          toLegacyReleaseGroupSummary(item, {
            id: item.artistId,
            name: item.artistName,
          }),
        ),
      };
    }
    const result = await searchAlbums(String(params.query || "").trim(), {
      artistName: "",
      limit: params.limit || 24,
      offset: params.offset || 0,
      releaseTypes: [],
    });
    return {
      count: result.count,
      "release-group-count": result.count,
      "release-groups": result.items.map((item) => toLegacySearchAlbumResult(item)),
    };
  }

  if (normalizedEndpoint.startsWith("/release/")) {
    const releaseId = normalizedEndpoint.replace(/^\/release\//, "").trim();
    const cached = releaseCache.get(releaseId);
    if (!cached?.release) {
      throw new Error(`Release ${releaseId} not found in BrainzMash cache`);
    }
    return toLegacyRelease(cached.release);
  }

  throw new Error(`Unsupported legacy metadata endpoint: ${normalizedEndpoint}`);
}
