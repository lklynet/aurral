import axios from "axios";
import Bottleneck from "bottleneck";
import NodeCache from "node-cache";
import { dbOps } from "../config/db-helpers.js";
import {
  MUSICBRAINZ_API,
  AURRAL_MUSICBRAINZ_API,
  OFFICIAL_COVER_ART_ARCHIVE_API,
  LASTFM_API,
  LISTENBRAINZ_API,
  APP_NAME,
  APP_VERSION,
} from "../config/constants.js";
import {
  getAlbumByMbid as getMetadataAlbumByMbid,
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  getMetadataBaseUrl,
  getMetadataProviderHealthSnapshot as getBrainzmashHealthSnapshot,
  legacyMusicbrainzRequest,
  listArtistAlbums as listMetadataArtistAlbums,
  resolveAlbumByArtistAndTitle,
  resolveArtistByName as resolveMetadataArtistByName,
} from "./metadataProvider.js";
import { selectBestAlbumImage } from "./imageService.js";

const mbCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 500 });
const lastfmCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 5000,
});
const listenbrainzCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 500,
});
const deezerArtistCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});
const musicbrainzArtistNameCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});
const musicbrainzReleaseGroupsCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 120,
  maxKeys: 500,
});
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
const itunesAlbumArtCache = new NodeCache({
  stdTTL: 24 * 60 * 60,
  checkperiod: 10 * 60,
  maxKeys: 2000,
});

const METADATA_PROVIDER_HEALTH_CONFIG = {
  failureThreshold: 3,
  recoverySuccessThreshold: 2,
  healthyProbeIntervalMs: 60 * 1000,
  unhealthyProbeIntervalMs: 5 * 60 * 1000,
  probeTimeoutMs: 3000,
};

const createProviderHealthState = () => ({
  failoverActive: false,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: "",
  lastTransitionAt: null,
  probeInFlight: null,
});

const metadataProviderHealth = {
  musicbrainz: createProviderHealthState(),
};

let metadataProviderProbeTimer = null;

export const getLastfmApiKey = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.lastfm?.apiKey || process.env.LASTFM_API_KEY;
};

export const getTicketmasterApiKey = () => {
  const settings = dbOps.getSettings();
  const configuredValue = settings.integrations?.ticketmaster?.apiKey;
  if (configuredValue !== undefined && configuredValue !== null) {
    return String(configuredValue).trim();
  }
  return String(process.env.TICKETMASTER_API_KEY || "").trim();
};

export const getMusicBrainzContact = () => {
  const settings = dbOps.getSettings();
  return (
    settings.integrations?.musicbrainz?.email ||
    process.env.CONTACT_EMAIL ||
    "user@example.com"
  );
};

const normalizeMusicbrainzApiBaseUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return MUSICBRAINZ_API;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return MUSICBRAINZ_API;
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = trimmedPath.endsWith("/ws/2")
    ? trimmedPath
    : `${trimmedPath || ""}/ws/2`;

  return parsed.toString().replace(/\/+$/, "");
};

const nowIso = () => new Date().toISOString();

const getMetadataProviderSelection = (serviceKey) => {
  const settings = dbOps.getSettings();
  if (serviceKey === "musicbrainz") {
    const provider =
      settings.integrations?.musicbrainz?.provider || "aurralHosted";
    if (provider === "official") {
      return {
        mode: "manual",
        provider,
        activeProvider: "official",
        activeBaseUrl: MUSICBRAINZ_API,
      };
    }
    if (provider === "custom") {
      return {
        mode: "manual",
        provider,
        activeProvider: "custom",
        activeBaseUrl: normalizeMusicbrainzApiBaseUrl(
          settings.integrations?.musicbrainz?.customUrl,
        ),
      };
    }
    const state = metadataProviderHealth.musicbrainz;
    return {
      mode: "auto",
      provider,
      activeProvider: state.failoverActive ? "official" : "aurralHosted",
      activeBaseUrl: state.failoverActive
        ? MUSICBRAINZ_API
        : AURRAL_MUSICBRAINZ_API,
    };
  }
};

const markMetadataProviderProbeResult = (
  serviceKey,
  { success, reason = "" },
) => {
  const state = metadataProviderHealth[serviceKey];
  if (!state) return;

  state.lastCheckedAt = nowIso();

  if (success) {
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses += 1;
    state.lastSuccessAt = state.lastCheckedAt;
    state.lastFailureReason = "";

    if (
      state.failoverActive &&
      state.consecutiveSuccesses >=
        METADATA_PROVIDER_HEALTH_CONFIG.recoverySuccessThreshold
    ) {
      state.failoverActive = false;
      state.lastTransitionAt = state.lastCheckedAt;
      console.warn(
        `${serviceKey} hosted endpoint recovered; switching back to hosted`,
      );
    }
    return;
  }

  state.consecutiveSuccesses = 0;
  state.consecutiveFailures += 1;
  state.lastFailureAt = state.lastCheckedAt;
  state.lastFailureReason = String(reason || "").trim();

  if (
    !state.failoverActive &&
    state.consecutiveFailures >=
      METADATA_PROVIDER_HEALTH_CONFIG.failureThreshold
  ) {
    state.failoverActive = true;
    state.lastTransitionAt = state.lastCheckedAt;
    console.warn(
      `${serviceKey} hosted endpoint failed ${state.consecutiveFailures} health checks; switching to official`,
    );
  }
};

const probeMusicbrainzHostedHealth = async () => {
  const selection = getMetadataProviderSelection("musicbrainz");
  if (selection.provider !== "aurralHosted") return null;

  const state = metadataProviderHealth.musicbrainz;
  if (state.probeInFlight) return state.probeInFlight;

  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;

  state.probeInFlight = axios
    .get(`${AURRAL_MUSICBRAINZ_API}/artist`, {
      params: {
        fmt: "json",
        query: 'artist:"radiohead"',
        limit: 1,
      },
      headers: { "User-Agent": userAgent },
      timeout: METADATA_PROVIDER_HEALTH_CONFIG.probeTimeoutMs,
    })
    .then(() => {
      markMetadataProviderProbeResult("musicbrainz", { success: true });
      return true;
    })
    .catch((error) => {
      const status = error?.response?.status;
      const reason = status ? `HTTP ${status}` : error?.code || error?.message;
      markMetadataProviderProbeResult("musicbrainz", {
        success: false,
        reason,
      });
      return false;
    })
    .finally(() => {
      state.probeInFlight = null;
    });

  return state.probeInFlight;
};

const runMetadataProviderHealthProbes = () =>
  Promise.allSettled([probeMusicbrainzHostedHealth()]);

const getMetadataProviderProbeIntervalMs = () => {
  const states = Object.values(metadataProviderHealth);
  return states.some((state) => state.failoverActive)
    ? METADATA_PROVIDER_HEALTH_CONFIG.unhealthyProbeIntervalMs
    : METADATA_PROVIDER_HEALTH_CONFIG.healthyProbeIntervalMs;
};

const ensureMetadataProviderProbeLoop = () => {
  if (metadataProviderProbeTimer) return;

  const tick = async () => {
    await runMetadataProviderHealthProbes();
    clearInterval(metadataProviderProbeTimer);
    metadataProviderProbeTimer = setInterval(
      tick,
      getMetadataProviderProbeIntervalMs(),
    );
    metadataProviderProbeTimer.unref?.();
  };

  metadataProviderProbeTimer = setInterval(
    tick,
    getMetadataProviderProbeIntervalMs(),
  );
  metadataProviderProbeTimer.unref?.();
  queueMicrotask(() => {
    tick().catch(() => {});
  });
};

const getMusicbrainzProvider = () => "brainzmash";

export const getMusicbrainzApiBaseUrl = () => {
  return getMetadataBaseUrl();
};

export const getMusicbrainzApiBaseUrls = () => {
  return [getMusicbrainzApiBaseUrl()];
};

export const getCoverArtArchiveApiBaseUrl = () => {
  return OFFICIAL_COVER_ART_ARCHIVE_API;
};

export const getCoverArtArchiveApiBaseUrls = () => {
  return [getCoverArtArchiveApiBaseUrl()];
};

export const getMetadataProviderHealthSnapshot = () => {
  return getBrainzmashHealthSnapshot();
};

export const __setMetadataProviderHealthStateForTests = (
  serviceKey,
  patch = {},
) => {
  if (!metadataProviderHealth[serviceKey]) return;
  Object.assign(
    metadataProviderHealth[serviceKey],
    createProviderHealthState(),
    patch,
  );
};

// Legacy MusicBrainz probing is intentionally disabled on the BrainzMash-native path.

const requestMusicbrainz = async (
  baseUrl,
  endpoint,
  queryParams,
  userAgent,
  forceIpv4 = false,
) =>
  axios.get(`${baseUrl}${endpoint}?${queryParams}`, {
    headers: { "User-Agent": userAgent },
    timeout: 5000,
    ...(forceIpv4 ? { family: 4 } : {}),
  });

const mbLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000,
});

const configureMusicbrainzLimiter = async () => {
  const { activeProvider } = getMetadataProviderSelection("musicbrainz");
  if (activeProvider === "official") {
    await mbLimiter.updateSettings({
      maxConcurrent: 1,
      minTime: 1000,
    });
    return;
  }

  await mbLimiter.updateSettings({
    maxConcurrent: 20,
    minTime: 0,
  });
};

const lastfmLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 200,
});
const listenbrainzLimiter = new Bottleneck({
  maxConcurrent: 4,
  minTime: 250,
});
const itunesLimiter = new Bottleneck({
  reservoir: 20,
  reservoirRefreshAmount: 20,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 20,
  minTime: 0,
});

let musicbrainzLast503Log = 0;
const musicbrainzInflightRequests = new Map();
const musicbrainzRetryLogAt = new Map();
const musicbrainzErrorLogAt = new Map();
const lastfmInflightRequests = new Map();
const lastfmErrorLogAt = new Map();
const listenbrainzInflightRequests = new Map();
const listenbrainzErrorLogAt = new Map();

const LASTFM_TIMEOUT_MS = 6000;
const LASTFM_MAX_RETRIES = 2;
const LISTENBRAINZ_TIMEOUT_MS = 6000;
const LISTENBRAINZ_MAX_RETRIES = 2;

const getProviderRequestCacheKey = (prefix, endpointOrPath, params = {}) =>
  `${prefix}:${endpointOrPath}:${JSON.stringify(params)}`;

const shouldEmitThrottledLog = (logMap, key, throttleMs = 15000) => {
  const now = Date.now();
  const last = logMap.get(key) || 0;
  if (now - last < throttleMs) return false;
  logMap.set(key, now);
  return true;
};

const musicbrainzRequestWithRetry = async (
  endpoint,
  params = {},
  retryCount = 0,
  forceIpv4 = false,
) => {
  const cacheKey = getProviderRequestCacheKey("mb", endpoint, params);
  const cached = mbCache.get(cacheKey);
  if (cached) return cached;

  const MAX_RETRIES = 3;
  const queryParams = new URLSearchParams({
    fmt: "json",
    ...params,
  });

  const isConnectionError = (error) => {
    const connectionErrors = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ERR_BAD_RESPONSE",
      "ERR_NETWORK",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_TIMED_OUT",
      "ERR_INTERNET_DISCONNECTED",
    ];
    return (
      connectionErrors.some(
        (err) => error.code === err || error.message.includes(err),
      ) ||
      (error.code &&
        (error.code.startsWith("E") || error.code.startsWith("ERR_")))
    );
  };

  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
  const shouldTryFallbackBaseUrl = (error) =>
    isConnectionError(error) ||
    (error.response &&
      [429, 500, 502, 503, 504].includes(error.response.status));

  const baseUrl = getMusicbrainzApiBaseUrl();
  let error;
  try {
    const response = await requestMusicbrainz(
      baseUrl,
      endpoint,
      queryParams,
      userAgent,
      forceIpv4,
    );
    const responseData = response.data;

    mbCache.set(cacheKey, responseData);
    return responseData;
  } catch (requestError) {
    error = requestError;
    if (
      getMusicbrainzProvider() === "aurralHosted" &&
      getMetadataProviderSelection("musicbrainz").activeProvider ===
        "aurralHosted" &&
      shouldTryFallbackBaseUrl(requestError)
    ) {
      probeMusicbrainzHostedHealth().catch(() => {});
    }
  }

  const connectionError = isConnectionError(error);
  const shouldRetry =
    retryCount < MAX_RETRIES &&
    (connectionError ||
      (error.response &&
        [429, 500, 502, 503, 504].includes(error.response.status)));

  if (shouldRetry) {
    const delay = 300 * Math.pow(2, retryCount);
    const errorType = error.response
      ? `HTTP ${error.response.status}`
      : error.code || error.message;
    const logKey = `${errorType}:retry:${retryCount + 1}`;
    if (shouldEmitThrottledLog(musicbrainzRetryLogAt, logKey, 5000)) {
      console.warn(
        `MusicBrainz error (${errorType}), retrying in ${delay}ms... (attempt ${
          retryCount + 1
        }/${MAX_RETRIES})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    return musicbrainzRequestWithRetry(
      endpoint,
      params,
      retryCount + 1,
      forceIpv4 || connectionError,
    );
  }

  if (error.response && error.response.status === 404) {
    console.warn(`MusicBrainz 404 Not Found for ${endpoint}`);
    throw error;
  }

  const status = error.response?.status;
  if (status === 502 || status === 503 || status === 504) {
    if (!musicbrainzLast503Log || Date.now() - musicbrainzLast503Log > 15000) {
      musicbrainzLast503Log = Date.now();
      console.warn(`MusicBrainz ${status} (suppressing further logs for 15s)`);
    }
  } else {
    const errorType = status ? `HTTP ${status}` : error.code || error.message;
    const logKey = `${errorType}:final`;
    if (shouldEmitThrottledLog(musicbrainzErrorLogAt, logKey)) {
      console.error("MusicBrainz API error:", error.message);
    }
  }
  throw error;
};

export const musicbrainzRequest = async (endpoint, params = {}) =>
  legacyMusicbrainzRequest(endpoint, params);

const normalizeItunesArtworkUrl = (url) =>
  String(url || "")
    .trim()
    .replace(/\/100x100([a-z]+)(?=[/?#]|$)/i, "/600x600$1")
    .replace(/\/\d+x\d+([a-z]+)(?=[/?#]|$)/i, "/600x600$1");

export async function fetchItunesAlbumArt(artistName, albumName) {
  const _artist = artistName;
  const _album = albumName;
  return null;
}

export async function fetchCoverArtArchiveReleaseGroup(releaseGroupMbid) {
  if (!releaseGroupMbid) return null;
  try {
    const album = await getMetadataAlbumByMbid(releaseGroupMbid);
    const image = selectBestAlbumImage(album?.images);
    if (image?.url) {
      return {
        imageUrl: image.url,
        types: [image.kind || "Front"],
      };
    }
    return { imageUrl: null, types: [], notFound: true };
  } catch {
    return { imageUrl: null, types: [], transientError: true };
  }
}

export const lastfmRequest = lastfmLimiter.wrap(
  async (method, params = {}, options = {}) => {
    const apiKey = getLastfmApiKey();
    if (!apiKey) return null;

    const cacheKey = `lfm:${method}:${JSON.stringify(params)}`;
    const cached = lastfmCache.get(cacheKey);
    if (cached) return cached;
    const inflight = lastfmInflightRequests.get(cacheKey);
    if (inflight) return inflight;
    const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
      ? Math.max(500, Math.floor(Number(options.timeoutMs)))
      : LASTFM_TIMEOUT_MS;
    const maxRetries = Number.isFinite(Number(options?.maxRetries))
      ? Math.max(0, Math.floor(Number(options.maxRetries)))
      : LASTFM_MAX_RETRIES;

    const requestPromise = (async () => {
      const isRetryable = (error) => {
        const status = error.response?.status;
        const code = error.code;
        return (
          code === "ECONNABORTED" ||
          code === "ETIMEDOUT" ||
          code === "ECONNRESET" ||
          code === "ENOTFOUND" ||
          code === "EAI_AGAIN" ||
          [408, 425, 429, 500, 502, 503, 504].includes(status)
        );
      };
      const getLogKey = (details) =>
        `${details.method}:${details.status || "none"}:${details.code || "none"}`;
      const logError = (message, details) => {
        const key = getLogKey(details);
        const now = Date.now();
        const last = lastfmErrorLogAt.get(key) || 0;
        if (now - last < 15000) return;
        lastfmErrorLogAt.set(key, now);
        console.error(message, details);
      };
      let lastError = null;
      for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        try {
          const response = await axios.get(LASTFM_API, {
            params: {
              method,
              api_key: apiKey,
              format: "json",
              ...params,
            },
            timeout: timeoutMs,
          });
          lastfmCache.set(cacheKey, response.data);
          return response.data;
        } catch (error) {
          lastError = error;
          if (retryCount < maxRetries && isRetryable(error)) {
            const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        }
      }
      const status = lastError?.response?.status || null;
      const payloadError =
        lastError?.response?.data?.message ||
        lastError?.response?.data?.error ||
        null;
      const details = {
        method,
        status,
        code: lastError?.code || null,
        message: lastError?.message || "Unknown Last.fm error",
        error: payloadError,
      };
      if (details.code === "ECONNABORTED") {
        logError(`Last.fm API timeout (${method})`, details);
      } else {
        logError(`Last.fm API error (${method})`, details);
      }
      return null;
    })();
    lastfmInflightRequests.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      lastfmInflightRequests.delete(cacheKey);
    }
  },
);

export const listenbrainzRequest = listenbrainzLimiter.wrap(
  async (path, params = {}) => {
    const cacheKey = `lb:${path}:${JSON.stringify(params)}`;
    const cached = listenbrainzCache.get(cacheKey);
    if (cached) return cached;
    const inflight = listenbrainzInflightRequests.get(cacheKey);
    if (inflight) return inflight;

    const requestPromise = (async () => {
      const isRetryable = (error) => {
        const status = error.response?.status;
        const code = error.code;
        return (
          code === "ECONNABORTED" ||
          code === "ETIMEDOUT" ||
          code === "ECONNRESET" ||
          code === "ENOTFOUND" ||
          code === "EAI_AGAIN" ||
          [408, 425, 429, 500, 502, 503, 504].includes(status)
        );
      };
      const getLogKey = (details) =>
        `${details.path}:${details.status || "none"}:${details.code || "none"}`;
      const logError = (message, details) => {
        const key = getLogKey(details);
        const now = Date.now();
        const last = listenbrainzErrorLogAt.get(key) || 0;
        if (now - last < 15000) return;
        listenbrainzErrorLogAt.set(key, now);
        console.error(message, details);
      };

      let lastError = null;
      for (
        let retryCount = 0;
        retryCount <= LISTENBRAINZ_MAX_RETRIES;
        retryCount++
      ) {
        try {
          const response = await axios.get(`${LISTENBRAINZ_API}${path}`, {
            params,
            timeout: LISTENBRAINZ_TIMEOUT_MS,
            validateStatus: (status) =>
              (status >= 200 && status < 300) || status === 204,
          });
          const payload = response.status === 204 ? null : response.data;
          listenbrainzCache.set(cacheKey, payload);
          return payload;
        } catch (error) {
          lastError = error;
          if (retryCount < LISTENBRAINZ_MAX_RETRIES && isRetryable(error)) {
            const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        }
      }

      const details = {
        path,
        status: lastError?.response?.status || null,
        code: lastError?.code || null,
        message: lastError?.message || "Unknown ListenBrainz error",
        error:
          lastError?.response?.data?.error ||
          lastError?.response?.data?.message ||
          null,
      };
      logError("ListenBrainz API error:", details);
      throw lastError;
    })();

    listenbrainzInflightRequests.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      listenbrainzInflightRequests.delete(cacheKey);
    }
  },
);

async function getDeezerArtist(artistName) {
  const normalizedName = artistName.toLowerCase().trim();
  const cached = deezerArtistCache.get(normalizedName);
  if (cached !== undefined) return cached;

  try {
    const searchRes = await axios.get("https://api.deezer.com/search/artist", {
      params: { q: artistName, limit: 5 },
      timeout: 3000,
    });
    const artists = searchRes.data?.data;
    if (!artists?.length) {
      deezerArtistCache.set(normalizedName, null);
      return null;
    }

    const searchLower = normalizedName.replace(/^the\s+/i, "");
    let bestMatch = null;

    for (const a of artists) {
      if (!a?.id) continue;
      const aNameLower = (a.name || "").toLowerCase().replace(/^the\s+/i, "");
      if (aNameLower === searchLower || aNameLower === normalizedName) {
        bestMatch = a;
        break;
      }
      if (!bestMatch && aNameLower.includes(searchLower)) {
        bestMatch = a;
      }
    }

    if (!bestMatch) {
      bestMatch = artists[0];
    }

    if (!bestMatch?.id) {
      deezerArtistCache.set(normalizedName, null);
      return null;
    }

    const result = {
      id: bestMatch.id,
      name: bestMatch.name,
      imageUrl:
        bestMatch.picture_big ||
        bestMatch.picture_medium ||
        bestMatch.picture ||
        null,
    };
    deezerArtistCache.set(normalizedName, result);
    return result;
  } catch (e) {
    return null;
  }
}

export async function getDeezerArtistById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `id:${normalizedId}`;
  const cached = deezerArtistCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}`,
      {
        timeout: 3000,
      },
    );
    const data = res.data;
    if (!data?.id) {
      deezerArtistCache.set(cacheKey, null);
      return null;
    }
    const result = {
      id: data.id,
      name: data.name || null,
      imageUrl: data.picture_big || data.picture_medium || data.picture || null,
    };
    deezerArtistCache.set(cacheKey, result);
    return result;
  } catch (e) {
    deezerArtistCache.set(cacheKey, null);
    return null;
  }
}

const deezerBioCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 500,
});

const wikiBioCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});

const wikidataTitleCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});

/**
 * Fetch artist biography from Deezer (GET /artist/{id}).
 * Returns bio string or null. Deezer's public API may not include bio for all artists.
 */
export async function deezerGetArtistBio(artistName) {
  if (!artistName || typeof artistName !== "string") return null;
  const artist = await getDeezerArtist(artistName);
  if (!artist?.id) return null;
  const cacheKey = `dz-bio:${artist.id}`;
  const cached = deezerBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(`https://api.deezer.com/artist/${artist.id}`, {
      timeout: 3000,
    });
    const data = res.data;
    const bio =
      (data && (data.biography || data.bio || data.description)) || null;
    const value = typeof bio === "string" && bio.trim() ? bio.trim() : null;
    deezerBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    deezerBioCache.set(cacheKey, null);
    return null;
  }
}

export async function deezerGetArtistBioById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return null;
  const cacheKey = `dz-bio:${normalizedId}`;
  const cached = deezerBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}`,
      {
        timeout: 3000,
      },
    );
    const data = res.data;
    const bio =
      (data && (data.biography || data.bio || data.description)) || null;
    const value = typeof bio === "string" && bio.trim() ? bio.trim() : null;
    deezerBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    deezerBioCache.set(cacheKey, null);
    return null;
  }
}

async function wikidataGetWikipediaTitleByMbid(mbid) {
  if (!mbid) return null;
  const cacheKey = `wd:v2:${mbid}`;
  const cached = wikidataTitleCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const query = [
      "PREFIX wdt: <http://www.wikidata.org/prop/direct/>",
      "PREFIX schema: <http://schema.org/>",
      `SELECT ?article WHERE { ?band wdt:P434 "${mbid}" . ?article schema:about ?band . ?article schema:isPartOf <https://en.wikipedia.org/> . } LIMIT 1`,
    ].join(" ");
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    const res = await axios.get("https://query.wikidata.org/sparql", {
      params: { query, format: "json" },
      headers: {
        "User-Agent": userAgent,
        Accept: "application/sparql-results+json",
      },
      timeout: 5000,
    });
    const bindings = res.data?.results?.bindings || [];
    const url = bindings[0]?.article?.value || null;
    if (!url) {
      wikidataTitleCache.set(cacheKey, null);
      return null;
    }
    const slug = url.split("/").pop() || "";
    const title = decodeURIComponent(slug).replace(/_/g, " ").trim();
    const value = title || null;
    wikidataTitleCache.set(cacheKey, value);
    return value;
  } catch (e) {
    wikidataTitleCache.set(cacheKey, null);
    return null;
  }
}

async function wikipediaGetBioByTitle(title) {
  if (!title) return null;
  const cacheKey = `wp:v2:${title.toLowerCase()}`;
  const cached = wikiBioCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const urlTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    const res = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${urlTitle}`,
      { timeout: 5000, headers: { "User-Agent": userAgent } },
    );
    const extract = res.data?.extract || null;
    const isDisambiguation =
      res.data?.type === "disambiguation" || /may refer to/.test(extract || "");
    const value =
      typeof extract === "string" && extract.trim() && !isDisambiguation
        ? extract.trim()
        : null;
    wikiBioCache.set(cacheKey, value);
    return value;
  } catch (e) {
    wikiBioCache.set(cacheKey, null);
    return null;
  }
}

export async function wikipediaGetArtistBioByMbid(mbid) {
  const title = await wikidataGetWikipediaTitleByMbid(mbid);
  if (!title) return null;
  return wikipediaGetBioByTitle(title);
}

async function resolveFirstNonEmpty(promises) {
  const pending = Array.isArray(promises) ? promises.length : 0;
  if (pending === 0) return null;

  return new Promise((resolve) => {
    let remaining = pending;
    let settled = false;

    const finishIfDone = () => {
      remaining -= 1;
      if (!settled && remaining <= 0) {
        settled = true;
        resolve(null);
      }
    };

    promises.forEach((promise) => {
      Promise.resolve(promise)
        .then((value) => {
          if (settled) return;
          if (typeof value === "string" && value.trim()) {
            settled = true;
            resolve(value.trim());
            return;
          }
          finishIfDone();
        })
        .catch(() => {
          if (settled) return;
          finishIfDone();
        });
    });
  });
}

/**
 * Strip basic HTML tags and decode entities from a string (e.g. Last.fm bio).
 */
function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetch artist biography from Last.fm (artist.getInfo). Returns summary or content (HTML stripped).
 */
export async function lastfmGetArtistBio(mbid) {
  if (!mbid) return null;
  try {
    const data = await lastfmRequest("artist.getInfo", { mbid });
    const bio = data?.artist?.bio;
    if (!bio) return null;
    const summary =
      typeof bio.summary === "string" && bio.summary.trim()
        ? stripHtml(bio.summary.trim())
        : null;
    const content =
      typeof bio.content === "string" && bio.content.trim()
        ? stripHtml(bio.content.trim())
        : null;
    return summary || content || null;
  } catch (e) {
    return null;
  }
}

/**
 * Get artist biography quickly by resolving the first available source.
 */
export async function getArtistBio(_artistName, mbid) {
  if (!mbid) return null;
  return resolveFirstNonEmpty([
    wikipediaGetArtistBioByMbid(mbid),
    lastfmGetArtistBio(mbid),
  ]);
}

export async function deezerSearchArtist(artistName) {
  const artist = await getDeezerArtist(artistName);
  if (!artist || !artist.imageUrl) return null;
  return artist;
}

export async function deezerGetArtistTopTracks(artistName) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];

    const topRes = await axios.get(
      `https://api.deezer.com/artist/${artist.id}/top`,
      { params: { limit: 5 }, timeout: 3000 },
    );
    const tracks = topRes.data?.data || [];
    return tracks
      .filter((t) => t.preview)
      .slice(0, 5)
      .map((t) => ({
        id: String(t.id),
        title: t.title,
        album: t.album?.title ?? null,
        preview_url: t.preview,
        duration_ms: (t.duration || 0) * 1000,
      }));
  } catch (e) {
    return [];
  }
}

export async function deezerGetArtistTopTracksById(artistId) {
  const normalizedId = String(artistId || "").trim();
  if (!normalizedId) return [];
  try {
    const topRes = await axios.get(
      `https://api.deezer.com/artist/${normalizedId}/top`,
      { params: { limit: 5 }, timeout: 3000 },
    );
    const tracks = topRes.data?.data || [];
    return tracks
      .filter((t) => t.preview)
      .slice(0, 5)
      .map((t) => ({
        id: String(t.id),
        title: t.title,
        album: t.album?.title ?? null,
        preview_url: t.preview,
        duration_ms: (t.duration || 0) * 1000,
      }));
  } catch (e) {
    return [];
  }
}

const deezerAlbumCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 500,
});
const deezerAlbumTrackCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
  maxKeys: 1000,
});
const deezerPreviewMatchCache = new NodeCache({
  stdTTL: 6 * 3600,
  checkperiod: 600,
  maxKeys: 2000,
});
const youtubeVideoCache = new NodeCache({
  stdTTL: 24 * 3600,
  checkperiod: 600,
  maxKeys: 2000,
});

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(
      /\s*[\(\[](deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4}).*[\)\]]/gi,
      "",
    )
    .replace(
      /\s+-\s+(deluxe|remaster|anniversary|expanded|bonus|edition|live|mono|stereo|\d{4}).*$/gi,
      "",
    )
    .replace(/[’']/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getReleaseYear(value) {
  const match = String(value || "").match(/\d{4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function normalizeDeezerPrimaryType(value) {
  const normalized = String(value || "album").toLowerCase();
  if (normalized === "ep") return "EP";
  if (normalized === "single") return "Single";
  return "Album";
}

function normalizeMbidTrackNumber(value) {
  const raw = String(value || "").trim();
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackPosition(track) {
  const raw =
    track?.trackPosition ??
    track?.track_position ??
    track?.trackNumber ??
    track?.tracknumber ??
    track?.position;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return normalizeMbidTrackNumber(raw);
}

function getTrackMedium(track) {
  const numeric = Number.parseInt(
    track?.mediumNumber ??
      track?.mediumnumber ??
      track?.disk_number ??
      track?.diskNumber,
    10,
  );
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackDurationMs(track) {
  const raw =
    track?.durationMs ??
    track?.duration_ms ??
    track?.durationms ??
    track?.length ??
    null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTrackTitle(track) {
  return track?.title || track?.trackName || track?.trackname || "";
}

async function getDeezerAlbumsForArtist(artist) {
  if (!artist?.id) return [];
  const cacheKey = `dz-albums:${artist.id}`;
  const cached = deezerAlbumCache.get(cacheKey);
  if (cached) return cached;

  const res = await axios.get(
    `https://api.deezer.com/artist/${artist.id}/albums`,
    { params: { limit: 100 }, timeout: 3000 },
  );
  const raw = res.data?.data || [];
  const allowed = ["album", "ep", "single"];
  const albums = raw
    .filter((a) =>
      allowed.includes((a.record_type || a.type || "").toLowerCase()),
    )
    .map((a) => {
      const primaryType = normalizeDeezerPrimaryType(a.record_type || a.type);
      const title = a.title || "";
      const releaseDate = a.release_date || "";
      return {
        id: a.id,
        title,
        "first-release-date": releaseDate ? releaseDate.slice(0, 4) : null,
        "primary-type": primaryType,
        "secondary-types": [],
        _coverUrl: a.cover_big || a.cover_medium || a.cover || null,
        fans: typeof a.fans === "number" ? a.fans : 0,
        _normalizedTitle: normalizeTitle(title),
        _releaseDate: releaseDate,
      };
    });

  deezerAlbumCache.set(cacheKey, albums);
  return albums;
}

function selectBestDeezerAlbumMatch(
  deezerAlbums,
  { albumTitle = "", releaseType = "", releaseDate = "" } = {},
) {
  if (
    !Array.isArray(deezerAlbums) ||
    deezerAlbums.length === 0 ||
    !albumTitle
  ) {
    return null;
  }
  const targetTitle = normalizeTitle(albumTitle);
  const targetType = String(releaseType || "").trim();
  const targetYear = getReleaseYear(releaseDate);

  const ranked = deezerAlbums
    .map((album) => {
      const albumTitle = album._normalizedTitle || normalizeTitle(album.title);
      let score = 0;
      if (albumTitle === targetTitle) {
        score += 100;
      } else if (
        albumTitle.includes(targetTitle) ||
        targetTitle.includes(albumTitle)
      ) {
        score += 45;
      }

      if (targetType && album["primary-type"] === targetType) {
        score += 20;
      }

      const albumYear = getReleaseYear(
        album._releaseDate || album["first-release-date"],
      );
      if (targetYear && albumYear) {
        const distance = Math.abs(targetYear - albumYear);
        if (distance === 0) score += 20;
        else if (distance <= 1) score += 10;
        else if (distance <= 3) score += 3;
      }

      score += Math.min(10, Math.log10(Math.max(1, album.fans || 0) + 1) * 2);
      return { album, score };
    })
    .filter((entry) => entry.score >= 80)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.album || null;
}

async function resolveDeezerAlbumForPreview({
  artistName = "",
  deezerArtistId = null,
  albumTitle = "",
  releaseType = "",
  releaseDate = "",
} = {}) {
  const artist = deezerArtistId
    ? await getDeezerArtistById(deezerArtistId)
    : await getDeezerArtist(artistName);
  if (!artist) return null;

  const albums = await getDeezerAlbumsForArtist(artist);
  return selectBestDeezerAlbumMatch(albums, {
    albumTitle,
    releaseType,
    releaseDate,
  });
}

function scoreDeezerTrackMatch(track, deezerTrack) {
  const targetTitle = normalizeTitle(getTrackTitle(track));
  const candidateTitle = normalizeTitle(getTrackTitle(deezerTrack));
  const trackPosition = getTrackPosition(track);
  const deezerPosition = getTrackPosition(deezerTrack);
  const trackMedium = getTrackMedium(track);
  const deezerMedium = getTrackMedium(deezerTrack);
  const trackDuration = getTrackDurationMs(track);
  const deezerDuration = getTrackDurationMs(deezerTrack);

  let score = 0;
  if (targetTitle && candidateTitle) {
    if (targetTitle === candidateTitle) {
      score += 70;
    } else if (
      targetTitle.includes(candidateTitle) ||
      candidateTitle.includes(targetTitle)
    ) {
      score += 35;
    }
  }

  if (trackPosition && deezerPosition && trackPosition === deezerPosition) {
    score += 25;
  }
  if (trackMedium && deezerMedium && trackMedium === deezerMedium) {
    score += 10;
  }
  if (trackDuration && deezerDuration) {
    const diff = Math.abs(trackDuration - deezerDuration);
    if (diff <= 3000) score += 15;
    else if (diff <= 10000) score += 8;
    else if (diff <= 20000) score += 3;
  }

  return score;
}

function attachDeezerTrackPreviews(tracks, deezerTracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  if (!Array.isArray(deezerTracks) || deezerTracks.length === 0) return tracks;

  const used = new Set();
  return tracks.map((track) => {
    let best = null;
    for (const candidate of deezerTracks) {
      if (!candidate?.preview_url || used.has(candidate.id)) continue;
      const score = scoreDeezerTrackMatch(track, candidate);
      if (!best || score > best.score) {
        best = { track: candidate, score };
      }
    }
    if (!best || best.score < 80) return track;
    used.add(best.track.id);
    return {
      ...track,
      preview_url: best.track.preview_url,
      previewProvider: "deezer",
      previewTrackId: best.track.id,
    };
  });
}

const ALLOWED_PRIMARY_TYPES = new Set(["album", "ep", "single"]);

function normalizeArtistReleaseTypeSelection(selectedReleaseTypes = []) {
  const list = Array.isArray(selectedReleaseTypes) ? selectedReleaseTypes : [];
  const normalized = new Set(list.map((value) => String(value || "").trim()));
  const primaryTypes = PRIMARY_RELEASE_TYPES.filter((type) =>
    normalized.has(type),
  );
  const secondaryTypes = SECONDARY_RELEASE_TYPES.filter((type) =>
    normalized.has(type),
  );
  return {
    primaryTypes,
    secondaryTypes,
  };
}

function buildArtistReleaseGroupQuery(mbid, primaryTypes, secondaryTypes) {
  const clauses = [`arid:${mbid}`];

  if (Array.isArray(primaryTypes) && primaryTypes.length > 0) {
    if (primaryTypes.length === 1) {
      clauses.push(`primarytype:${primaryTypes[0].toLowerCase()}`);
    } else {
      clauses.push(
        `(${primaryTypes
          .map((type) => `primarytype:${type.toLowerCase()}`)
          .join(" OR ")})`,
      );
    }
  }

  if (Array.isArray(secondaryTypes) && secondaryTypes.length === 0) {
    clauses.push("-secondarytype:*");
  }

  return clauses.join(" AND ");
}

/**
 * One MusicBrainz call: fetch canonical release-groups for an artist.
 * Returns array of { id, title, "first-release-date", "primary-type", "secondary-types" }.
 */
export async function musicbrainzGetArtistReleaseGroups(
  mbid,
  selectedReleaseTypes = null,
  { includeTrackCounts = true, hydrateLimit = includeTrackCounts ? 30 : 6 } = {},
) {
  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) > 0
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
  { limit = 100, offset = 0 } = {},
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
  { limit = 24 } = {},
) {
  if (!mbid) return [];
  const safeLimit = Math.min(
    250,
    Math.max(1, Number.parseInt(limit, 10) || 24),
  );
  const cacheKey = `appears-on:${mbid}:${safeLimit}`;
  const cached = musicbrainzReleaseGroupsCache.get(cacheKey);
  if (cached) return cached;

  const directIds = new Set(
    (Array.isArray(directReleaseGroups) ? directReleaseGroups : [])
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean),
  );

  try {
    const byReleaseGroupId = new Map();
    const pageSize = 100;
    const maxRecordingCount = Math.min(1000, Math.max(pageSize, safeLimit * 4));

    for (let offset = 0; offset < maxRecordingCount; offset += pageSize) {
      const data = await officialMusicbrainzRecordingSearch(mbid, {
        limit: pageSize,
        offset,
      });
      const recordings = Array.isArray(data?.recordings) ? data.recordings : [];

      for (const recording of recordings) {
        if (!artistCreditIncludesMbid(recording?.["artist-credit"], mbid)) {
          continue;
        }
        for (const release of Array.isArray(recording?.releases)
          ? recording.releases
          : []) {
          const releaseGroup = release?.["release-group"];
          const releaseGroupId = String(releaseGroup?.id || "").trim();
          if (!releaseGroupId || directIds.has(releaseGroupId)) continue;
          if (getReleaseGroupArtistId(releaseGroup) === mbid) continue;
          if (!byReleaseGroupId.has(releaseGroupId)) {
            byReleaseGroupId.set(
              releaseGroupId,
              mapAppearsOnReleaseGroup(releaseGroup, release, recording, mbid),
            );
          }
        }
      }

      if (byReleaseGroupId.size >= safeLimit || recordings.length < pageSize) {
        break;
      }
    }

    const mapped = [...byReleaseGroupId.values()]
      .sort((left, right) =>
        String(right["first-release-date"] || "").localeCompare(
          String(left["first-release-date"] || ""),
        ),
      )
      .slice(0, safeLimit);
    musicbrainzReleaseGroupsCache.set(cacheKey, mapped);
    return mapped;
  } catch {
    return [];
  }
}

export async function musicbrainzGetArtistReleaseGroupsPreview(
  mbid,
  limit = 50,
) {
  if (!mbid) return [];
  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(100, parsedLimit)
      : 50;
  const items = await musicbrainzGetArtistReleaseGroups(mbid);
  return items.slice(0, safeLimit);
}

/**
 * Enrich MusicBrainz release-groups with Deezer data: cover URL, fans count, and Deezer album ID for tracks.
 * Mutates and returns the same array (adds _coverUrl, fans, _deezerAlbumId when matched).
 */
export async function enrichReleaseGroupsWithDeezer(
  mbReleaseGroups,
  artistName,
  deezerArtistId = null,
) {
  if (!mbReleaseGroups?.length || !artistName) return mbReleaseGroups;
  try {
    const artist = deezerArtistId
      ? await getDeezerArtistById(deezerArtistId)
      : await getDeezerArtist(artistName);
    if (!artist) return mbReleaseGroups;

    const albums = await getDeezerAlbumsForArtist(artist);
    const byKey = new Map();
    for (const a of albums) {
      const primaryType = a["primary-type"] || "Album";
      const title = a.title || "";
      const key = `${primaryType}:${normalizeTitle(title)}`;
      const fans = typeof a.fans === "number" ? a.fans : 0;
      const coverUrl = a._coverUrl || null;
      const existing = byKey.get(key);
      if (
        !existing ||
        fans > existing.fans ||
        (fans === existing.fans &&
          (a._releaseDate || "") < (existing.release_date || ""))
      ) {
        byKey.set(key, {
          id: a.id,
          fans,
          coverUrl,
          release_date: a._releaseDate || "",
        });
      }
    }

    for (const rg of mbReleaseGroups) {
      const key = `${rg["primary-type"]}:${normalizeTitle(rg.title)}`;
      const match = byKey.get(key);
      if (match) {
        rg._coverUrl = match.coverUrl;
        rg.fans = match.fans;
        rg._deezerAlbumId = match.id;
      }
    }
    return mbReleaseGroups;
  } catch (e) {
    return mbReleaseGroups;
  }
}

export async function enrichReleaseGroupsWithLastfm(
  mbReleaseGroups,
  artistName,
  artistMbid = null,
) {
  if (!mbReleaseGroups?.length || !artistName || !getLastfmApiKey())
    return mbReleaseGroups;
  try {
    const params = artistMbid
      ? { mbid: artistMbid, limit: 200 }
      : { artist: artistName, limit: 200 };
    const data = await lastfmRequest("artist.getTopAlbums", params);
    const raw = data?.topalbums?.album;
    const albums = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!albums.length) return mbReleaseGroups;

    const byTitle = new Map();
    for (const album of albums) {
      const title = album?.name || album?.title || "";
      if (!title) continue;
      const listeners = parseInt(album?.listeners || album?.playcount || 0, 10);
      if (!listeners) continue;
      const key = normalizeTitle(title);
      const existing = byTitle.get(key) || 0;
      if (listeners > existing) byTitle.set(key, listeners);
    }

    for (const rg of mbReleaseGroups) {
      rg.fans = 0;
      const key = normalizeTitle(rg.title);
      const listeners = byTitle.get(key);
      if (typeof listeners === "number") {
        rg.fans = listeners;
      }
    }
    return mbReleaseGroups;
  } catch (e) {
    return mbReleaseGroups;
  }
}

export async function deezerGetArtistAlbums(artistName) {
  try {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];
    const mapped = (await getDeezerAlbumsForArtist(artist)).map((a) => ({
      id: `dz-${a.id}`,
      title: a.title,
      "first-release-date": a["first-release-date"],
      "primary-type": a["primary-type"],
      "secondary-types": [],
      _coverUrl: a._coverUrl,
      _fans: a.fans || 0,
      _normalizedTitle: a._normalizedTitle,
      _releaseDate: a._releaseDate || "",
    }));
    const byKey = new Map();
    for (const item of mapped) {
      const key = `${item["primary-type"]}:${item._normalizedTitle}`;
      const existing = byKey.get(key);
      if (
        !existing ||
        item._fans > existing._fans ||
        (item._fans === existing._fans &&
          item._releaseDate < existing._releaseDate)
      ) {
        byKey.set(key, item);
      }
    }
    const albums = Array.from(byKey.values()).map(
      ({ _fans, _normalizedTitle, _releaseDate, ...rest }) => ({
        ...rest,
        fans: _fans,
      }),
    );
    return albums;
  } catch (e) {
    return [];
  }
}

export async function deezerGetAlbumTracks(deezerAlbumId) {
  const id = String(deezerAlbumId).replace(/^dz-/, "");
  if (!id || id === "dz") return [];
  const cacheKey = `dz-tracks:${id}`;
  const cached = deezerAlbumTrackCache.get(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(`https://api.deezer.com/album/${id}/tracks`, {
      timeout: 3000,
    });
    const raw = res.data?.data || [];
    const tracks = raw.map((t, i) => ({
      id: String(t.id),
      mbid: String(t.id),
      title: t.title || "",
      trackName: t.title || "",
      trackNumber: t.track_position || i + 1,
      position: t.track_position || i + 1,
      mediumNumber: t.disk_number || null,
      length: t.duration ? t.duration * 1000 : null,
      duration_ms: t.duration ? t.duration * 1000 : null,
      preview_url: t.preview || null,
    }));
    deezerAlbumTrackCache.set(cacheKey, tracks);
    return tracks;
  } catch (e) {
    return [];
  }
}

export async function enrichTracksWithDeezerPreviews(
  tracks,
  {
    artistName = "",
    deezerArtistId = null,
    deezerAlbumId = null,
    albumTitle = "",
    releaseType = "",
    releaseDate = "",
    cacheKey = "",
  } = {},
) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks || [];
  const normalizedCacheKey =
    cacheKey ||
    `preview:${deezerAlbumId || deezerArtistId || artistName}:${albumTitle}:${releaseType}:${releaseDate}`;
  const cached = deezerPreviewMatchCache.get(normalizedCacheKey);
  if (cached) return cached;

  try {
    let resolvedAlbumId = String(deezerAlbumId || "")
      .replace(/^dz-/, "")
      .trim();
    if (!resolvedAlbumId) {
      const album = await resolveDeezerAlbumForPreview({
        artistName,
        deezerArtistId,
        albumTitle,
        releaseType,
        releaseDate,
      });
      resolvedAlbumId = album?.id ? String(album.id) : "";
    }
    if (!resolvedAlbumId) return tracks;

    const deezerTracks = await deezerGetAlbumTracks(resolvedAlbumId);
    const enriched = attachDeezerTrackPreviews(tracks, deezerTracks);
    deezerPreviewMatchCache.set(normalizedCacheKey, enriched);
    return enriched;
  } catch {
    return tracks;
  }
}

export async function lastfmGetArtistNameByMbid(mbid) {
  const data = await lastfmRequest("artist.getInfo", { mbid });
  const name = data?.artist?.name;
  return name && typeof name === "string" ? name.trim() : null;
}

export async function lastfmGetArtistImageUrlByName(artistName) {
  const name = String(artistName || "").trim();
  if (!name) return null;
  try {
    const data = await lastfmRequest("artist.getInfo", { artist: name });
    const images = Array.isArray(data?.artist?.image) ? data.artist.image : [];
    for (let index = images.length - 1; index >= 0; index -= 1) {
      const url = String(images[index]?.["#text"] || "").trim();
      if (url) return url;
    }
    return null;
  } catch {
    return null;
  }
}

export async function musicbrainzGetArtistNameByMbid(mbid) {
  if (!mbid) return null;
  const cached = musicbrainzArtistNameCache.get(mbid);
  if (cached !== undefined) return cached;
  try {
    const name = await getMetadataArtistNameByMbid(mbid);
    const normalized = name && typeof name === "string" ? name.trim() : null;
    musicbrainzArtistNameCache.set(mbid, normalized);
    return normalized;
  } catch (e) {
    musicbrainzArtistNameCache.set(mbid, null);
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

function normalizeArtistAlbumKey(artistName, albumName) {
  const a = String(artistName || "")
    .trim()
    .toLowerCase();
  const b = String(albumName || "")
    .trim()
    .toLowerCase();
  return `aa:${a}\0${b}`;
}

export async function resolveDeezerAlbumToMbid(
  artistName,
  albumName,
  deezerAlbumId,
) {
  const dzKey = `dz:${String(deezerAlbumId || "").replace(/^dz-/, "")}`;
  const aaKey = normalizeArtistAlbumKey(artistName, albumName);
  const cached =
    dbOps.getDeezerMbidCache(dzKey) || dbOps.getDeezerMbidCache(aaKey);
  if (cached) return cached;

  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  if (!artist || !album) return null;

  try {
    const id = await resolveAlbumByArtistAndTitle({
      artistName: artist,
      albumTitle: album,
    });
    if (!id) return null;
    dbOps.setDeezerMbidCache(dzKey, id);
    dbOps.setDeezerMbidCache(aaKey, id);
    return id;
  } catch (e) {
    return null;
  }
}

export async function youtubeFindTopSongVideo(artistName, trackTitle) {
  const artist = String(artistName || "").trim();
  const title = String(trackTitle || "").trim();
  if (!artist || !title) return null;

  const cacheKey = `${artist.toLowerCase()}\0${title.toLowerCase()}`;
  const cached = youtubeVideoCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const query = `${artist} ${title} official video`;
    const response = await axios.get("https://www.youtube.com/results", {
      params: { search_query: query },
      timeout: 5000,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    const matches = [
      ...String(response.data || "").matchAll(
        /"videoId":"([a-zA-Z0-9_-]{11})"/g,
      ),
    ];
    const videoId = [...new Set(matches.map((match) => match[1]))][0] || null;
    const result = videoId
      ? {
          videoId,
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
          query,
        }
      : null;
    youtubeVideoCache.set(cacheKey, result);
    return result;
  } catch (e) {
    youtubeVideoCache.set(cacheKey, null, 300);
    return null;
  }
}

function toLastfmResultList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function lastfmSearchArtists(query, { limit = 5 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed || !getLastfmApiKey()) return [];
  const data = await lastfmRequest("artist.search", {
    artist: trimmed,
    limit: Math.min(30, Math.max(1, limit)),
  });
  return toLastfmResultList(data?.results?.artistmatches?.artist);
}

export async function lastfmSearchAlbums(query, { limit = 5 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed || !getLastfmApiKey()) return [];
  const data = await lastfmRequest("album.search", {
    album: trimmed,
    limit: Math.min(30, Math.max(1, limit)),
  });
  return toLastfmResultList(data?.results?.albummatches?.album);
}

export async function lastfmSearchTracks(query, { limit = 5 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed || !getLastfmApiKey()) return [];
  const data = await lastfmRequest("track.search", {
    track: trimmed,
    limit: Math.min(30, Math.max(1, limit)),
  });
  return toLastfmResultList(data?.results?.trackmatches?.track);
}

export async function searchMusicbrainzRecordings(query, { limit = 5 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  try {
    const data = await mbLimiter.schedule(() =>
      musicbrainzRequestWithRetry("/recording", {
        query: trimmed,
        limit: Math.min(25, Math.max(1, limit)),
        inc: "artist-credits+releases",
      }),
    );
    return Array.isArray(data?.recordings) ? data.recordings : [];
  } catch {
    return [];
  }
}

export function clearApiCaches() {
  mbCache.flushAll();
  lastfmCache.flushAll();
  listenbrainzCache.flushAll();
  deezerArtistCache.flushAll();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzReleaseGroupsCache.flushAll();
  deezerAlbumCache.flushAll();
  deezerBioCache.flushAll();
  youtubeVideoCache.flushAll();
}
