import axios from "../../lib/axiosFetch.js";
import http from "http";
import https from "https";
import { dbOps } from "../db/helpers/index.js";
import { logger } from "./logger.js";
import BoundedMap from "./boundedMap.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { musicbrainzGetArtistIdentityByMbid } from "./apiClients/musicbrainz.js";

const CIRCUIT_COOLDOWN_MS = 60000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const LIDARR_MAX_CONCURRENT = 12;
const LIDARR_ALBUM_LOOKUP_CONCURRENCY = 6;
export const LIDARR_ALBUM_LOOKUP_BATCH_MAX = 100;
const LIDARR_LIST_CACHE_MS = 30000;
const LIDARR_ARTIST_ALBUM_CACHE_MAX = 10;
const LIDARR_RETRY_ATTEMPTS = 2;
const LIDARR_RETRY_DELAY_MS = 800;
const LIDARR_STATUS_CACHE_MS = 10000;
const LIDARR_ARTIST_INDEX_TTL_MS = 15 * 60 * 1000;
const LIDARR_ARTIST_INDEX_CACHE_MAX = 5000;
const LIDARR_STATUS_CACHE_MAX = 100;
const VALID_MONITOR_OPTIONS = new Set([
  "none",
  "existing",
  "all",
  "future",
  "missing",
  "latest",
  "first",
]);

function normalizeRootFolderPath(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeProfileId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeLidarrArtistId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function isMetadataProviderIdError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("input string") && message.includes("correct format");
}

function normalizeMonitorOption(value) {
  const option = String(value || "none").trim();
  return VALID_MONITOR_OPTIONS.has(option) ? option : "none";
}

function getArtistMonitoringPayload(monitorOption, { forceArtistMonitored = true } = {}) {
  const option = normalizeMonitorOption(monitorOption);
  const monitored = forceArtistMonitored || option !== "none";
  const monitorNewItems = option === "all" || option === "future" ? "all" : "none";

  return {
    option,
    monitored,
    monitor: option,
    monitorNewItems,
  };
}

function mapTags(tags) {
  return Array.isArray(tags)
    ? tags
        .filter(
          (tag) =>
            normalizeProfileId(tag?.id) !== null &&
            typeof tag?.label === "string" &&
            tag.label.trim(),
        )
        .map((tag) => ({
          ...tag,
          id: normalizeProfileId(tag.id),
          label: tag.label.trim(),
        }))
    : [];
}

function createPreferenceError(statusCode, field, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.field = field;
  error.code = code;
  return error;
}

function mapRootFolders(rootFolders) {
  return Array.isArray(rootFolders)
    ? rootFolders
        .filter((item) => normalizeRootFolderPath(item?.path))
        .map((item) => ({
          ...item,
          path: normalizeRootFolderPath(item.path),
        }))
    : [];
}

function mapQualityProfiles(qualityProfiles) {
  return Array.isArray(qualityProfiles)
    ? qualityProfiles
        .filter((profile) => normalizeProfileId(profile?.id) !== null)
        .map((profile) => ({
          ...profile,
          id: normalizeProfileId(profile.id),
        }))
    : [];
}

function findRootFolder(rootFolders, rootFolderPath) {
  const normalizedPath = normalizeRootFolderPath(rootFolderPath);
  if (!normalizedPath) return null;
  return (
    rootFolders.find((folder) => normalizeRootFolderPath(folder?.path) === normalizedPath) || null
  );
}

function findQualityProfile(qualityProfiles, qualityProfileId) {
  const normalizedId = normalizeProfileId(qualityProfileId);
  if (normalizedId === null) return null;
  return (
    qualityProfiles.find((profile) => normalizeProfileId(profile?.id) === normalizedId) || null
  );
}

export class LidarrClient {
  constructor() {
    this.config = null;
    this.apiPath = "/api/v1";
    this._circuitOpen = false;
    this._circuitOpenedAt = 0;
    this._circuitFailures = 0;
    this._lastCircuitFailureAt = 0;
    this._circuitProbe = null;
    this._concurrent = 0;
    this._waitQueue = [];
    this._artistListCache = null;
    this._artistByMbidCache = new BoundedMap(LIDARR_ARTIST_INDEX_CACHE_MAX);
    this._artistByMbidInflight = new Map();
    this._albumCache = new BoundedMap(LIDARR_ARTIST_ALBUM_CACHE_MAX);
    this._albumMbidIndex = null;
    this._statusCache = new BoundedMap(LIDARR_STATUS_CACHE_MAX);
    this._inflightGets = new Map();
    this._httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: LIDARR_MAX_CONCURRENT,
      maxFreeSockets: 2,
      timeout: 60000,
    });
    this._httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: LIDARR_MAX_CONCURRENT,
      maxFreeSockets: 2,
      timeout: 60000,
    });
    this._httpsInsecureAgent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxSockets: LIDARR_MAX_CONCURRENT,
      maxFreeSockets: 2,
      timeout: 60000,
    });
    this.updateConfig();
  }

  _setArtistByMbidCacheEntry(mbid, artist) {
    const normalizedMbid = String(mbid || "").trim();
    if (!normalizedMbid) return;
    this._artistByMbidCache.set(normalizedMbid, {
      artist: artist || null,
      at: Date.now(),
    });
  }

  _getArtistByMbidCacheEntry(mbid) {
    const normalizedMbid = String(mbid || "").trim();
    if (!normalizedMbid) return undefined;
    const cached = this._artistByMbidCache.get(normalizedMbid);
    if (!cached) return undefined;
    if (Date.now() - cached.at >= LIDARR_ARTIST_INDEX_TTL_MS) {
      this._artistByMbidCache.delete(normalizedMbid);
      return undefined;
    }
    return cached.artist;
  }

  _populateArtistIndexes(artists) {
    const list = Array.isArray(artists) ? artists : [];
    const seenMbids = new Set();
    for (const artist of list) {
      const mbid = String(artist?.foreignArtistId || "").trim();
      if (!mbid) continue;
      seenMbids.add(mbid);
      this._setArtistByMbidCacheEntry(mbid, artist);
    }
    return seenMbids;
  }

  _invalidateArtistIndexes() {
    this._artistByMbidCache.clear();
    this._artistByMbidInflight.clear();
  }

  _acquireSlot() {
    if (this._concurrent < LIDARR_MAX_CONCURRENT) {
      this._concurrent++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._waitQueue.push(resolve);
    });
  }

  _releaseSlot() {
    this._concurrent--;
    if (this._waitQueue.length > 0) {
      this._concurrent++;
      const next = this._waitQueue.shift();
      if (next) next();
    }
  }

  _registerCircuitFailure() {
    const now = Date.now();
    if (this._lastCircuitFailureAt && now - this._lastCircuitFailureAt > CIRCUIT_COOLDOWN_MS) {
      this._circuitFailures = 0;
    }
    this._lastCircuitFailureAt = now;
    this._circuitFailures += 1;
    if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this._openCircuit(now);
    }
  }

  _openCircuit(now = Date.now()) {
    this._circuitFailures = Math.max(this._circuitFailures, CIRCUIT_FAILURE_THRESHOLD);
    this._lastCircuitFailureAt = now;
    this._circuitOpen = true;
    this._circuitOpenedAt = now;
  }

  _resetCircuitState() {
    this._circuitFailures = 0;
    this._lastCircuitFailureAt = 0;
    this._circuitOpen = false;
    this._circuitOpenedAt = 0;
  }

  _startCircuitProbe() {
    if (this._circuitProbe) return this._circuitProbe;
    const deferred = Promise.withResolvers();
    this._circuitProbe = {
      promise: deferred.promise,
      resolve: deferred.resolve,
    };
    return this._circuitProbe;
  }

  _finishCircuitProbe(probe, recovered) {
    if (!probe) return;
    if (this._circuitProbe === probe) {
      this._circuitProbe = null;
    }
    probe.resolve(Boolean(recovered));
  }

  isCircuitOpen() {
    if (this.config?.circuitDisabled) return false;
    return this._circuitOpen && Date.now() - this._circuitOpenedAt < CIRCUIT_COOLDOWN_MS;
  }

  _staleGetCache(method, endpoint) {
    if (method !== "GET") return null;
    if (endpoint === "/artist" && this._artistListCache) {
      return this._artistListCache.data;
    }
    if (endpoint === "/album" || endpoint.startsWith("/album?")) {
      const cached = this._albumCache.get(endpoint);
      if (cached) return cached.data;
    }
    if (endpoint === "/queue" || endpoint === "/command" || endpoint.startsWith("/history")) {
      const cached = this._statusCache.get(endpoint);
      if (cached) return cached.data;
    }
    return null;
  }

  updateConfig() {
    if (this._holdConfig) {
      return;
    }
    const previousConfig = this.config;
    const settings = dbOps.getSettings();
    const dbConfig = settings.integrations?.lidarr || {};
    let url = dbConfig.url || process.env.LIDARR_URL || "http://localhost:8686";

    url = url.replace(/\/+$/, "");

    const insecure =
      dbConfig.insecure === true ||
      process.env.LIDARR_INSECURE === "true" ||
      process.env.LIDARR_INSECURE === "1";

    const envTimeoutMs = Number(process.env.LIDARR_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 30000;

    const circuitDisabled =
      process.env.LIDARR_CIRCUIT_DISABLED === "true" || process.env.LIDARR_CIRCUIT_DISABLED === "1";

    const newConfig = {
      url: url,
      apiKey: (dbConfig.apiKey || process.env.LIDARR_API_KEY || "").trim(),
      insecure: !!insecure,
      timeoutMs,
      circuitDisabled,
    };

    const didConfigChange =
      !previousConfig ||
      previousConfig.url !== newConfig.url ||
      previousConfig.apiKey !== newConfig.apiKey ||
      previousConfig.insecure !== newConfig.insecure ||
      previousConfig.timeoutMs !== newConfig.timeoutMs ||
      previousConfig.circuitDisabled !== newConfig.circuitDisabled;

    this.config = newConfig;
    if (didConfigChange) {
      this._artistListCache = null;
      this._invalidateArtistIndexes();
      this._albumCache = new BoundedMap(LIDARR_ARTIST_ALBUM_CACHE_MAX);
      this._statusCache.clear();
    }
  }

  getConfig() {
    this.updateConfig();
    return this.config;
  }

  isConfigured(skipConfigUpdate = false) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }
    return !!this.config?.apiKey?.trim();
  }

  getAuthHeaders() {
    if (!this.config.apiKey) {
      return {};
    }
    return {
      "X-Api-Key": this.config.apiKey.trim(),
    };
  }

  async request(endpoint, method = "GET", data = null, skipConfigUpdate = false, options = {}) {
    const shouldDedupeGet =
      endpoint === "/artist" ||
      endpoint.startsWith("/album") ||
      endpoint === "/queue" ||
      endpoint.startsWith("/history?") ||
      endpoint === "/command";
    const dedupeKey =
      method === "GET" && shouldDedupeGet
        ? `${options.forceRefresh ? "refresh:" : "cached:"}${endpoint}`
        : null;
    if (!dedupeKey) {
      return this._request(endpoint, method, data, skipConfigUpdate, options);
    }
    const inflight = this._inflightGets.get(dedupeKey);
    if (inflight) return inflight;
    const promise = this._request(endpoint, method, data, skipConfigUpdate, options).finally(() => {
      this._inflightGets.delete(dedupeKey);
    });
    this._inflightGets.set(dedupeKey, promise);
    return promise;
  }

  async _request(endpoint, method = "GET", data = null, skipConfigUpdate = false, options = {}) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }

    if (!this.isConfigured(skipConfigUpdate)) {
      throw new Error("Lidarr API key not configured");
    }

    const now = Date.now();
    if (method === "GET" && endpoint === "/artist" && !options.forceRefresh) {
      if (this._artistListCache && now - this._artistListCache.at < LIDARR_LIST_CACHE_MS) {
        return this._artistListCache.data;
      }
    }
    if (
      method === "GET" &&
      !options.forceRefresh &&
      (endpoint === "/album" || endpoint.startsWith("/album?"))
    ) {
      const cached = this._albumCache.get(endpoint);
      if (cached && now - cached.at < LIDARR_LIST_CACHE_MS) {
        return cached.data;
      }
    }

    const isStatusRequest =
      method === "GET" &&
      (endpoint === "/queue" || endpoint === "/command" || endpoint.startsWith("/history"));
    if (isStatusRequest) {
      const cached = this._statusCache.get(endpoint);
      if (cached && now - cached.at < LIDARR_STATUS_CACHE_MS) {
        return cached.data;
      }
      if (cached) {
        this._statusCache.delete(endpoint);
      }
    }

    const bypassCircuit = options?.bypassCircuit === true;
    let circuitProbe = null;
    if (!this.config.circuitDisabled && this._circuitOpen && !bypassCircuit) {
      if (now - this._circuitOpenedAt < CIRCUIT_COOLDOWN_MS) {
        const stale = this._staleGetCache(method, endpoint);
        if (stale !== null) return stale;
        throw new Error("Lidarr unavailable (circuit open). Will retry after cooldown.");
      }
      if (this._circuitProbe) {
        const stale = this._staleGetCache(method, endpoint);
        if (stale !== null) return stale;
        const recovered = await this._circuitProbe.promise;
        if (!recovered) {
          throw new Error("Lidarr unavailable (recovery probe failed). Will retry after cooldown.");
        }
      } else {
        circuitProbe = this._startCircuitProbe();
      }
    }
    if (this.config.circuitDisabled && this._circuitOpen) {
      this._resetCircuitState();
    }

    const authHeaders = this.getAuthHeaders();

    if (
      method !== "GET" &&
      (endpoint === "/artist" ||
        endpoint.startsWith("/artist/") ||
        endpoint === "/album" ||
        endpoint.startsWith("/album/"))
    ) {
      this._artistListCache = null;
      this._invalidateArtistIndexes();
      this._albumCache = new BoundedMap(LIDARR_ARTIST_ALBUM_CACHE_MAX);
      this._albumMbidIndex = null;
    }
    if (method !== "GET" && endpoint.startsWith("/command")) {
      this._statusCache.delete("/command");
    }

    for (let attempt = 1; attempt <= LIDARR_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._acquireSlot();
        try {
          const fullUrl = `${this.config.url}${this.apiPath}${endpoint}`;

          const isHttps = fullUrl.startsWith("https:") || fullUrl.startsWith("HTTPS:");

          const requestConfig = {
            method,
            url: fullUrl,
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            timeout: this.config.timeoutMs,
            httpAgent: this._httpAgent,
            httpsAgent:
              isHttps && this.config.insecure ? this._httpsInsecureAgent : this._httpsAgent,
            validateStatus: function (status) {
              return status < 500;
            },
          };

          if (data) {
            requestConfig.data = data;
          }

          const response = await axios(requestConfig);

          if (response.status >= 400) {
            throw {
              response: {
                status: response.status,
                statusText: response.statusText,
                data: response.data,
                headers: response.headers,
              },
            };
          }

          if (method === "GET" && endpoint === "/artist") {
            this._artistListCache = { data: response.data, at: Date.now() };
            this._populateArtistIndexes(response.data);
          }
          if (method === "GET" && (endpoint === "/album" || endpoint.startsWith("/album?"))) {
            if (this._albumCache.size >= LIDARR_ARTIST_ALBUM_CACHE_MAX) {
              const oldestKey = this._albumCache.keys().next().value;
              this._albumCache.delete(oldestKey);
            }
            this._albumCache.set(endpoint, { data: response.data, at: Date.now() });
          }
          if (isStatusRequest) {
            this._statusCache.set(endpoint, {
              data: response.data,
              at: Date.now(),
            });
          }

          this._resetCircuitState();
          this._finishCircuitProbe(circuitProbe, true);
          return response.data;
        } finally {
          this._releaseSlot();
        }
      } catch (raw) {
        const error = raw && typeof raw === "object" ? raw : {};
        const status = error.response?.status;
        const msg = error.message != null ? String(error.message) : String(raw);
        const isTimeout = error.code === "ECONNABORTED" || msg.toLowerCase().includes("timeout");
        const isNoResponse = !error.response && (error.request || isTimeout);
        const isTransientStatus = typeof status === "number" && status >= 500;

        if (attempt < LIDARR_RETRY_ATTEMPTS && (isNoResponse || isTransientStatus)) {
          await new Promise((resolve) => setTimeout(resolve, LIDARR_RETRY_DELAY_MS));
          continue;
        }

        const transientFailure = isNoResponse || isTransientStatus;
        if (!this.config.circuitDisabled && transientFailure) {
          if (circuitProbe) {
            this._openCircuit();
          } else {
            this._registerCircuitFailure();
          }
        }
        if (circuitProbe && !transientFailure) {
          this._resetCircuitState();
        }
        this._finishCircuitProbe(circuitProbe, !transientFailure);

        if (error.response) {
          const statusText = error.response.statusText;
          const responseData = error.response.data;

          const isAlbum404 = status === 404 && endpoint.includes("/album/");
          if (!isAlbum404) {
            console.error(`Lidarr API error (${status}):`, {
              url: `${this.config.url}${this.apiPath}${endpoint}`,
              method: method,
              status: status,
              statusText: statusText,
              responseData: responseData,
              responseHeaders: error.response.headers,
            });
          }

          let errorMsg = statusText || "Unknown error";
          let errorDetails = "";

          if (typeof responseData === "string") {
            errorMsg = responseData;
            errorDetails = responseData;
          } else if (responseData) {
            errorMsg =
              responseData.message ||
              responseData.error ||
              responseData.title ||
              responseData.detail ||
              (typeof responseData === "object"
                ? JSON.stringify(responseData)
                : String(responseData));
            errorDetails = JSON.stringify(responseData, null, 2);
          }

          const responseText = typeof responseData === "string" ? responseData : errorMsg;
          const responseTextLower = responseText?.toLowerCase?.();
          const isLidarrSkyhookRefused =
            status >= 500 &&
            responseTextLower &&
            responseTextLower.includes("api.lidarr.audio") &&
            (responseTextLower.includes("connection refused") ||
              responseTextLower.includes("connect") ||
              responseTextLower.includes("econnrefused"));
          if (isLidarrSkyhookRefused) {
            const userError = new Error(
              "Lidarr cannot reach api.lidarr.audio from its container. Check Lidarr outbound internet/DNS or proxy settings.",
            );
            userError.response = raw.response;
            throw userError;
          }
          if (status === 400) {
            const userError = new Error(
              `Lidarr API returned 400 Bad Request: ${errorMsg}${
                errorDetails ? `\n\nFull Response: ${errorDetails}` : ""
              }`,
            );
            userError.response = raw.response;
            throw userError;
          }
          if (status === 401) {
            const userError = new Error(`Lidarr API authentication failed. Check your API key.`);
            userError.response = raw.response;
            throw userError;
          }
          if (status === 404) {
            const isAlbumEndpoint = endpoint.includes("/album/");
            if (isAlbumEndpoint) {
              return null;
            }
            const userError = new Error(
              `Lidarr endpoint not found: ${endpoint}. Check if Lidarr is running and the API version is correct.`,
            );
            userError.response = raw.response;
            throw userError;
          }
          const userError = new Error(
            `Lidarr API error: ${status} - ${
              responseData?.message || responseData?.error || statusText || "Unknown error"
            }`,
          );
          userError.response = raw.response;
          throw userError;
        } else if (error.request) {
          console.error("Lidarr API request failed - no response:", msg);
          throw new Error(
            `Cannot connect to Lidarr at ${this.config.url}. Check if Lidarr is running and the URL is correct.`,
          );
        } else {
          console.error("Lidarr API error:", msg);
          throw raw instanceof Error ? raw : new Error(msg);
        }
      }
    }
  }

  async testConnection(skipConfigUpdate = false) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }

    if (!this.isConfigured(skipConfigUpdate)) {
      return { connected: false, error: "Lidarr not configured" };
    }

    this.apiPath = "/api/v1";

    try {
      const status = await this.request("/system/status", "GET", null, skipConfigUpdate, {
        bypassCircuit: true,
      });
      return {
        connected: true,
        version: status.version || "unknown",
        instanceName: status.instanceName || "Lidarr",
        apiPath: this.apiPath,
      };
    } catch (error) {
      const errorMessage = error.message || "Unknown error";
      const errorDetails = error.response?.data
        ? typeof error.response.data === "string"
          ? error.response.data
          : JSON.stringify(error.response.data, null, 2)
        : "";

      return {
        connected: false,
        error: errorMessage,
        details: errorDetails,
        url: this.config.url,
        fullUrl: `${this.config.url}${this.apiPath}/system/status`,
        statusCode: error.response?.status,
        apiPath: this.apiPath,
        responseHeaders: error.response?.headers,
      };
    }
  }

  async getRootFolders() {
    return this.request("/rootFolder");
  }

  async getTags(skipConfigUpdate = false) {
    return this.request("/tag", "GET", null, skipConfigUpdate);
  }

  getArtistAddFallbacks({ rootFolders, qualityProfiles, settings } = {}) {
    const safeRootFolders = mapRootFolders(rootFolders);
    const safeQualityProfiles = mapQualityProfiles(qualityProfiles);
    const currentSettings = settings || dbOps.getSettings();

    const globalRootFolderPath = normalizeRootFolderPath(
      currentSettings.integrations?.lidarr?.rootFolderPath || currentSettings.rootFolderPath,
    );
    const legacyQualityProfileId = normalizeProfileId(
      currentSettings.integrations?.lidarr?.qualityProfileId,
    );

    const fallbackRootFolder =
      findRootFolder(safeRootFolders, globalRootFolderPath) || safeRootFolders[0];
    const fallbackQualityProfile =
      findQualityProfile(safeQualityProfiles, legacyQualityProfileId) || safeQualityProfiles[0];

    return {
      rootFolderPath: fallbackRootFolder?.path || null,
      qualityProfileId: fallbackQualityProfile?.id ?? null,
    };
  }

  async getArtistAddPreferenceSummary(user = null) {
    const settings = dbOps.getSettings();
    const savedTagId = normalizeProfileId(settings.integrations?.lidarr?.tagId);

    if (!this.isConfigured()) {
      return {
        configured: false,
        rootFolders: [],
        qualityProfiles: [],
        tags: [],
        savedDefaults: {
          rootFolderPath: normalizeRootFolderPath(user?.lidarrRootFolderPath),
          qualityProfileId: normalizeProfileId(user?.lidarrQualityProfileId),
          tagId: savedTagId,
        },
        fallbacks: {
          rootFolderPath: null,
          qualityProfileId: null,
          tagId: savedTagId,
        },
      };
    }

    const [rootFoldersRaw, qualityProfilesRaw, tagsRaw] = await Promise.all([
      this.getRootFolders(),
      this.getQualityProfiles(),
      this.getTags(),
    ]);
    const rootFolders = mapRootFolders(rootFoldersRaw);
    const qualityProfiles = mapQualityProfiles(qualityProfilesRaw);
    const tags = mapTags(tagsRaw);

    return {
      configured: true,
      rootFolders: rootFolders.map((folder) => ({ path: folder.path })),
      qualityProfiles: qualityProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name || `Profile ${profile.id}`,
      })),
      tags: tags.map((tag) => ({
        id: tag.id,
        label: tag.label,
      })),
      savedDefaults: {
        rootFolderPath: normalizeRootFolderPath(user?.lidarrRootFolderPath),
        qualityProfileId: normalizeProfileId(user?.lidarrQualityProfileId),
        tagId: savedTagId,
      },
      fallbacks: {
        ...this.getArtistAddFallbacks({
          rootFolders,
          qualityProfiles,
        }),
        tagId: savedTagId,
      },
    };
  }

  async resolveArtistAddConfiguration(options = {}) {
    const rootFolders = mapRootFolders(options.rootFolders || (await this.getRootFolders()));
    if (rootFolders.length === 0) {
      throw new Error("No root folders configured in Lidarr");
    }

    const qualityProfiles = mapQualityProfiles(
      options.qualityProfiles || (await this.getQualityProfiles()),
    );
    if (qualityProfiles.length === 0) {
      throw new Error("No quality profiles configured in Lidarr");
    }

    const fallbacks = this.getArtistAddFallbacks({
      rootFolders,
      qualityProfiles,
      settings: options.settings,
    });

    const requestedRootFolderPath = normalizeRootFolderPath(options.requestRootFolderPath);
    const requestedQualityProfileId = normalizeProfileId(options.requestQualityProfileId);
    const savedRootFolderPath = normalizeRootFolderPath(options.savedRootFolderPath);
    const savedQualityProfileId = normalizeProfileId(options.savedQualityProfileId);

    let resolvedRootFolderPath = fallbacks.rootFolderPath;
    let resolvedQualityProfileId = fallbacks.qualityProfileId;

    if (requestedRootFolderPath) {
      const requestRootFolder = findRootFolder(rootFolders, requestedRootFolderPath);
      if (!requestRootFolder) {
        throw createPreferenceError(
          400,
          "rootFolderPath",
          `Unknown Lidarr root folder: ${requestedRootFolderPath}`,
          "INVALID_ROOT_FOLDER_PATH",
        );
      }
      resolvedRootFolderPath = requestRootFolder.path;
    } else if (savedRootFolderPath) {
      const savedRootFolder = findRootFolder(rootFolders, savedRootFolderPath);
      if (!savedRootFolder) {
        throw createPreferenceError(
          409,
          "rootFolderPath",
          `Your saved Lidarr root folder no longer exists: ${savedRootFolderPath}. Update your Library Defaults or use Customize.`,
          "STALE_ROOT_FOLDER_PATH",
        );
      }
      resolvedRootFolderPath = savedRootFolder.path;
    }

    if (requestedQualityProfileId !== null) {
      const requestQualityProfile = findQualityProfile(qualityProfiles, requestedQualityProfileId);
      if (!requestQualityProfile) {
        throw createPreferenceError(
          400,
          "qualityProfileId",
          `Unknown Lidarr quality profile: ${requestedQualityProfileId}`,
          "INVALID_QUALITY_PROFILE_ID",
        );
      }
      resolvedQualityProfileId = requestQualityProfile.id;
    } else if (savedQualityProfileId !== null) {
      const savedQualityProfile = findQualityProfile(qualityProfiles, savedQualityProfileId);
      if (!savedQualityProfile) {
        throw createPreferenceError(
          409,
          "qualityProfileId",
          `Your saved Lidarr quality profile no longer exists: ${savedQualityProfileId}. Update your Library Defaults or use Customize.`,
          "STALE_QUALITY_PROFILE_ID",
        );
      }
      resolvedQualityProfileId = savedQualityProfile.id;
    }

    return {
      rootFolders,
      qualityProfiles,
      fallbacks,
      resolved: {
        rootFolderPath: resolvedRootFolderPath,
        qualityProfileId: resolvedQualityProfileId,
      },
    };
  }

  async addArtist(mbid, artistName, options = {}) {
    const settings = dbOps.getSettings();
    const { resolved } = await this.resolveArtistAddConfiguration({
      requestRootFolderPath: options.rootFolderPath,
      requestQualityProfileId: options.qualityProfileId,
      savedRootFolderPath: options.savedRootFolderPath,
      savedQualityProfileId: options.savedQualityProfileId,
      settings,
    });

    const albumOnly = options.albumOnly === true;
    const requestedMonitorOption = normalizeMonitorOption(
      options.monitorOption || options.monitor || "none",
    );
    const monitoring = getArtistMonitoringPayload(requestedMonitorOption);
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const albumMbid = String(options.albumMbid || "").trim();
    const albumsToMonitor = albumOnly && albumMbid ? [albumMbid] : [];

    const qualityProfileId = resolved.qualityProfileId;
    const defaultMetadataProfileId = settings.integrations?.lidarr?.metadataProfileId;
    let metadataProfileId = options.metadataProfileId || defaultMetadataProfileId || null;
    if (!metadataProfileId) {
      try {
        const metadataProfiles = await this.getMetadataProfiles();
        if (Array.isArray(metadataProfiles) && metadataProfiles.length > 0) {
          metadataProfileId = metadataProfiles[0].id;
        }
      } catch {}
    }
    if (!metadataProfileId) metadataProfileId = 1;

    const configuredTagId = normalizeProfileId(
      options.tagId ?? settings.integrations?.lidarr?.tagId,
    );
    const tags = configuredTagId !== null ? [configuredTagId] : [];

    const lidarrArtist = {
      artistName: artistName,
      foreignArtistId: mbid,
      rootFolderPath: resolved.rootFolderPath,
      qualityProfileId: qualityProfileId,
      metadataProfileId: metadataProfileId,
      monitored: monitoring.monitored,
      monitor: monitoring.monitor,
      monitorNewItems: monitoring.monitorNewItems,
      tags: tags,
      addOptions: {
        monitor: monitoring.monitor,
        searchForMissingAlbums: albumOnly ? options.triggerSearch === true : searchOnAdd,
        ...(albumsToMonitor.length > 0 ? { albumsToMonitor } : {}),
      },
    };

    const resolveMetadataProviderArtistIds = async () => {
      const identity = await this.resolveCanonicalArtistIdentity(mbid);
      const canonicalName = String(identity?.name || "").trim();
      const normalizedArtistName = String(artistName || "")
        .trim()
        .toLowerCase();
      const acceptedArtistNames = new Set(
        [canonicalName, ...(Array.isArray(identity?.aliases) ? identity.aliases : [])]
          .map((name) => String(name || "").trim().toLowerCase())
          .filter(Boolean),
      );
      if (!canonicalName || !acceptedArtistNames.has(normalizedArtistName)) {
        const error = new Error(
          `MusicBrainz artist name for ${mbid} does not match the requested artist name`,
        );
        error.code = "LIDARR_ARTIST_IDENTITY_MISMATCH";
        throw error;
      }

      const lookup = await this.request(
        `/artist/lookup?term=${encodeURIComponent(canonicalName)}`,
      );
      const canonicalProviderIds = new Set(
        (Array.isArray(identity?.providerIds) ? identity.providerIds : []).map((providerId) =>
          String(providerId || "").trim().toLowerCase(),
        ),
      );
      const lookupProviderIds = [];
      const lookupProviderSuffixes = new Set();
      let hasCanonicalLookupMatch = false;
      for (const candidate of Array.isArray(lookup) ? lookup : []) {
        const providerId = String(candidate?.foreignArtistId || "").trim();
        if (
          providerId &&
          String(candidate?.artistName || "").trim().toLowerCase() === canonicalName.toLowerCase()
        ) {
          hasCanonicalLookupMatch = true;
          const normalizedProviderId = providerId.toLowerCase();
          if (canonicalProviderIds.has(normalizedProviderId)) {
            lookupProviderIds.push(providerId);
          }
          const providerSuffix = normalizedProviderId.split("@").pop();
          if (providerSuffix && providerSuffix !== normalizedProviderId) {
            lookupProviderSuffixes.add(providerSuffix);
          }
        }
      }
      if (lookupProviderIds.length > 0) return [...new Set(lookupProviderIds)];
      if (!hasCanonicalLookupMatch) return [];
      return (Array.isArray(identity?.providerIds) ? identity.providerIds : []).filter(
        (providerId) => {
          const normalizedProviderId = String(providerId || "").trim().toLowerCase();
          const providerSuffix = normalizedProviderId.split("@").pop();
          return (
            normalizedProviderId &&
            (lookupProviderSuffixes.size === 0 || lookupProviderSuffixes.has(providerSuffix))
          );
        },
      );
    };

    const resolveAddedArtist = async (artist) => {
      if (normalizeLidarrArtistId(artist?.id)) {
        return artist;
      }
      let resolvedArtist = await this.getArtistByMbid(mbid);
      if (!normalizeLidarrArtistId(resolvedArtist?.id)) {
        resolvedArtist = await this.getArtistByMbid(mbid, { forceRefresh: true });
      }
      if (!normalizeLidarrArtistId(resolvedArtist?.id)) {
        throw new Error(`Lidarr add did not return a numeric artist ID for ${mbid}`);
      }
      return resolvedArtist;
    };

    const ensureArtistMonitored = async (artist) => {
      if (albumOnly && options.triggerSearch === true) {
        logger.info("library", "Queued Lidarr album search with artist add", {
          artistId: artist?.id ?? null,
          albumMbid,
        });
      }
      const artistId = normalizeLidarrArtistId(artist?.id);
      if (!artistId || artist.monitored === true) {
        return artist;
      }
      return this.updateArtistMonitoring(artistId, monitoring.option);
    };

    const postArtist = async (payload) => {
      try {
        return await this.request("/artist", "POST", payload);
      } catch (error) {
        if (isMetadataProviderIdError(error) || requestedMonitorOption !== "all") {
          throw error;
        }
        const fallbackArtist = {
          ...payload,
          monitor: "existing",
          addOptions: {
            ...payload.addOptions,
            monitor: "existing",
          },
        };
        return this.request("/artist", "POST", fallbackArtist);
      }
    };

    let result;
    try {
      result = await postArtist(lidarrArtist);
    } catch (error) {
      if (!isMetadataProviderIdError(error)) {
        throw error;
      }
      const providerArtistIds = await resolveMetadataProviderArtistIds();
      if (providerArtistIds.length === 0) {
        throw new Error(
          `Lidarr metadata provider could not resolve ${artistName} from its MusicBrainz ID. Search the artist in Lidarr first or use MusicBrainz metadata.`,
        );
      }
      let providerError = error;
      for (const providerArtistId of providerArtistIds) {
        try {
          result = await postArtist({ ...lidarrArtist, foreignArtistId: providerArtistId });
          try {
            dbOps.setLidarrArtistIdMap(mbid, providerArtistId);
          } catch (mappingError) {
            if (mappingError?.code !== "LIDARR_ARTIST_ID_CONFLICT") {
              throw mappingError;
            }
            logger.warn("library", "Failed to persist Lidarr artist ID mapping", {
              mbid,
              providerArtistId,
              error: mappingError.message,
            });
          }
          break;
        } catch (providerAttemptError) {
          if (!isMetadataProviderIdError(providerAttemptError)) {
            throw providerAttemptError;
          }
          providerError = providerAttemptError;
        }
      }
      if (!result) throw providerError;
    }
    return ensureArtistMonitored(await resolveAddedArtist(result));
  }

  async resolveCanonicalArtistIdentity(mbid) {
    return musicbrainzGetArtistIdentityByMbid(mbid);
  }

  async getArtist(artistId) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    return this.request(`/artist/${normalizedArtistId}`);
  }

  async getArtistByMbid(mbid, { forceRefresh = false } = {}) {
    const normalizedMbid = String(mbid || "").trim();
    if (!normalizedMbid) return null;
    const mappedLidarrArtistId = dbOps.getLidarrArtistIdMap(normalizedMbid);

    const matchesArtistId = (artist) =>
      artist?.foreignArtistId === normalizedMbid ||
      (mappedLidarrArtistId && artist?.foreignArtistId === mappedLidarrArtistId);

    if (forceRefresh) {
      this._artistByMbidCache.delete(normalizedMbid);
    } else {
      const cachedArtist = this._getArtistByMbidCacheEntry(normalizedMbid);
      if (cachedArtist !== undefined) {
        return cachedArtist;
      }

      if (this._artistListCache && Date.now() - this._artistListCache.at < LIDARR_LIST_CACHE_MS) {
        const artists = Array.isArray(this._artistListCache.data)
          ? this._artistListCache.data
          : [];
        this._populateArtistIndexes(artists);
        const artist = artists.find(matchesArtistId) || null;
        this._setArtistByMbidCacheEntry(normalizedMbid, artist);
        return artist;
      }
    }

    if (!forceRefresh) {
      const inflight = this._artistByMbidInflight.get(normalizedMbid);
      if (inflight) {
        return inflight;
      }
    }

    const startedAt = Date.now();
    const requestPromise = this.request("/artist", "GET", null, false, { forceRefresh })
      .then((artists) => {
        const list = Array.isArray(artists) ? artists : [];
        this._populateArtistIndexes(list);
        const artist = list.find(matchesArtistId) || null;
        if (artist || !forceRefresh) {
          this._setArtistByMbidCacheEntry(normalizedMbid, artist);
        }
        return artist;
      })
      .finally(() => {
        if (!forceRefresh) {
          this._artistByMbidInflight.delete(normalizedMbid);
        }
        const durationMs = Date.now() - startedAt;
        logger.debug("api", "Lidarr getArtistByMbid completed", {
          mbid: normalizedMbid,
          durationMs,
        });
      });

    if (!forceRefresh) {
      this._artistByMbidInflight.set(normalizedMbid, requestPromise);
    }
    return requestPromise;
  }

  async updateArtist(artistId, updates) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    const artist = await this.getArtist(normalizedArtistId);

    const updated = {
      ...artist,
      ...updates,
    };

    return this.request(`/artist/${normalizedArtistId}`, "PUT", updated);
  }

  async updateArtistMonitoring(artistId, monitorOption) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    const artist = await this.getArtist(normalizedArtistId);
    const monitoring = getArtistMonitoringPayload(monitorOption);

    const updated = {
      ...artist,
      monitored: monitoring.monitored,
      monitor: monitoring.monitor,
      monitorNewItems: monitoring.monitorNewItems,
      addOptions: {
        ...(artist.addOptions || {}),
        monitor: monitoring.monitor,
      },
    };

    try {
      return await this.request(`/artist/${normalizedArtistId}`, "PUT", updated);
    } catch (error) {
      if (monitoring.option !== "all") {
        throw error;
      }
      const fallbackUpdated = {
        ...updated,
        monitor: "existing",
        addOptions: {
          ...(updated.addOptions || {}),
          monitor: "existing",
        },
      };
      return this.request(`/artist/${normalizedArtistId}`, "PUT", fallbackUpdated);
    }
  }

  async addAlbum(artistId, albumMbid, albumName, options = {}) {
    const artist = await this.getArtist(artistId);
    if (!artist) {
      throw new Error(`Artist with ID ${artistId} not found in Lidarr`);
    }

    const effectiveArtist =
      artist.monitored === true
        ? artist
        : await this.updateArtistMonitoring(
            artistId,
            artist.monitor || artist.addOptions?.monitor || "none",
          );

    const lidarrAlbum = {
      title: albumName,
      foreignAlbumId: albumMbid,
      artistId: artistId,
      artist: effectiveArtist,
      monitored: options.monitored !== false,
      anyReleaseOk: true,
      images: [],
    };

    let result = await this.request("/album", "POST", lidarrAlbum);

    if (options.monitored !== false && result?.id && result.monitored !== true) {
      result = await this.monitorAlbum(result.id, true);
    }

    if (options.triggerSearch === true) {
      await this.triggerAlbumSearch(result.id);
    }

    return result;
  }

  async getAlbum(albumId) {
    return this.request(`/album/${albumId}`);
  }

  async getTracksByAlbumId(albumId) {
    try {
      const result = await this.request(`/track?albumId=${albumId}`);
      if (Array.isArray(result)) return result;
      if (result?.records && Array.isArray(result.records)) return result.records;
      return [];
    } catch {
      return [];
    }
  }

  async getTrackFilesByAlbumId(albumId) {
    try {
      const result = await this.request(`/trackfile?albumId=${albumId}`);
      if (Array.isArray(result)) return result;
      if (result?.records && Array.isArray(result.records)) return result.records;
      return [];
    } catch {
      return [];
    }
  }

  async getAllTracks() {
    try {
      const result = await this.request("/track");
      if (Array.isArray(result)) return result;
      if (result?.records && Array.isArray(result.records)) return result.records;
      return [];
    } catch {
      return [];
    }
  }

  async getAllTrackFiles() {
    try {
      const result = await this.request("/trackfile");
      if (Array.isArray(result)) return result;
      if (result?.records && Array.isArray(result.records)) return result.records;
      return [];
    } catch {
      return [];
    }
  }

  async getAllAlbums(options = {}) {
    const albums = await this.request("/album", "GET", null, false, options);
    return Array.isArray(albums) ? albums : [];
  }

  async getAlbumMbidIndex(options = {}) {
    const albums = await this.getAllAlbums(options);
    if (!options.forceRefresh && this._albumMbidIndex && this._albumMbidIndex.source === albums) {
      return this._albumMbidIndex.map;
    }
    const map = new Map();
    for (const album of albums) {
      const mbid = String(album?.foreignAlbumId || "").trim();
      if (mbid) map.set(mbid, album);
    }
    this._albumMbidIndex = { source: albums, map };
    return map;
  }

  async getAlbumByMbid(albumMbid, options = {}) {
    const normalizedMbid = String(albumMbid || "").trim();
    if (!normalizedMbid) return undefined;
    const normalizedMbidKey = normalizedMbid.toLowerCase();

    const albums = await this.request(
      `/album?foreignAlbumId=${encodeURIComponent(normalizedMbid)}`,
      "GET",
      null,
      false,
      options,
    );
    const candidates = Array.isArray(albums)
      ? albums
      : Array.isArray(albums?.records)
        ? albums.records
        : albums?.foreignAlbumId
          ? [albums]
          : [];
    return candidates.find(
      (album) =>
        String(album?.foreignAlbumId ?? "").trim().toLowerCase() === normalizedMbidKey,
    );
  }

  async getAlbumsByMbidsSettled(albumMbids, options = {}) {
    return mapWithConcurrency(albumMbids, LIDARR_ALBUM_LOOKUP_CONCURRENCY, async (albumMbid) => {
      try {
        return { status: "fulfilled", value: await this.getAlbumByMbid(albumMbid, options) };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    });
  }

  async updateAlbum(albumId, updates) {
    const album = await this.getAlbum(albumId);

    const updated = {
      ...album,
      ...updates,
    };

    return this.request(`/album/${albumId}`, "PUT", updated);
  }

  async monitorAlbum(albumId, monitored = true) {
    return this.updateAlbum(albumId, { monitored });
  }

  async triggerAlbumSearch(albumId) {
    const command = await this.request("/command", "POST", {
      name: "AlbumSearch",
      albumIds: [albumId],
    });
    logger.info("library", "Triggered Lidarr album search", {
      albumId,
      commandId: command?.id ?? null,
      commandStatus: command?.status ?? null,
    });
    return command;
  }

  async triggerArtistSearch(artistId) {
    return this.request("/command", "POST", {
      name: "ArtistSearch",
      artistIds: [artistId],
    });
  }

  async getQueue() {
    const response = await this.request("/queue");
    if (response && Array.isArray(response)) {
      return response;
    }
    return response.records || response || [];
  }

  async getQueueItem(queueId) {
    return this.request(`/queue/${queueId}`);
  }

  async getHistory(page = 1, pageSize = 20, sortKey = "date", sortDirection = "descending") {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
      sortKey,
      sortDirection,
    });
    return this.request(`/history?${params.toString()}`);
  }

  async getHistoryForAlbum(albumId) {
    const history = await this.getHistory(1, 100);
    return history.records?.filter((h) => h.albumId === albumId) || [];
  }

  async getHistoryForArtist(artistId) {
    const history = await this.getHistory(1, 100);
    return history.records?.filter((h) => h.artistId === artistId) || [];
  }

  async deleteArtist(artistId, deleteFiles = false) {
    const params = new URLSearchParams();
    if (deleteFiles) {
      params.append("deleteFiles", "true");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    const result = await this.request(`/artist/${artistId}${query}`, "DELETE");
    this._artistListCache = null;
    this._invalidateArtistIndexes();
    this._albumCache.clear();
    return result;
  }

  async deleteAlbum(albumId, deleteFiles = false) {
    const params = new URLSearchParams();
    if (deleteFiles) {
      params.append("deleteFiles", "true");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/album/${albumId}${query}`, "DELETE");
  }

  async getQualityProfiles(skipConfigUpdate = false) {
    return this.request("/qualityprofile", "GET", null, skipConfigUpdate);
  }

  async getMetadataProfiles(skipConfigUpdate = false) {
    return this.request("/metadataprofile", "GET", null, skipConfigUpdate);
  }

  async createMetadataProfile(profileData, skipConfigUpdate = false) {
    return this.request("/metadataprofile", "POST", profileData, skipConfigUpdate);
  }

  async updateMetadataProfile(profileId, profileData, skipConfigUpdate = false) {
    return this.request(`/metadataprofile/${profileId}`, "PUT", profileData, skipConfigUpdate);
  }

  async getQualityProfile(profileId, skipConfigUpdate = false) {
    return this.request(`/qualityprofile/${profileId}`, "GET", null, skipConfigUpdate);
  }

  async createQualityProfile(profileData, skipConfigUpdate = false) {
    return this.request("/qualityprofile", "POST", profileData, skipConfigUpdate);
  }

  async updateQualityProfile(profileId, profileData, skipConfigUpdate = false) {
    return this.request(`/qualityprofile/${profileId}`, "PUT", profileData, skipConfigUpdate);
  }

  async getCustomFormats(skipConfigUpdate = false) {
    return this.request("/customformat", "GET", null, skipConfigUpdate);
  }

  async createCustomFormat(formatData, skipConfigUpdate = false) {
    return this.request("/customformat", "POST", formatData, skipConfigUpdate);
  }

  async getNamingConfig(skipConfigUpdate = false) {
    return this.request("/config/naming", "GET", null, skipConfigUpdate);
  }

  async updateNamingConfig(configData, skipConfigUpdate = false) {
    return this.request("/config/naming", "PUT", configData, skipConfigUpdate);
  }

  async getReleaseProfiles(skipConfigUpdate = false) {
    return this.request("/releaseprofile", "GET", null, skipConfigUpdate);
  }

  async createReleaseProfile(profileData, skipConfigUpdate = false) {
    return this.request("/releaseprofile", "POST", profileData, skipConfigUpdate);
  }

  async updateReleaseProfile(profileId, profileData, skipConfigUpdate = false) {
    return this.request(`/releaseprofile/${profileId}`, "PUT", profileData, skipConfigUpdate);
  }

  async getQualityDefinitions(skipConfigUpdate = false) {
    return this.request("/qualitydefinition", "GET", null, skipConfigUpdate);
  }

  async updateQualityDefinition(id, data, skipConfigUpdate = false) {
    return this.request(`/qualitydefinition/${id}`, "PUT", data, skipConfigUpdate);
  }
}

export const lidarrClient = new LidarrClient();
