import axios from "axios";
import http from "http";
import https from "https";
import { dbOps } from "../config/db-helpers.js";

const CIRCUIT_COOLDOWN_MS = 60000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const LIDARR_MAX_CONCURRENT = 12;
const LIDARR_LIST_CACHE_MS = 30000;
const LIDARR_RETRY_ATTEMPTS = 2;
const LIDARR_RETRY_DELAY_MS = 800;
const LIDARR_STATUS_CACHE_MS = 10000;

export class LidarrClient {
  constructor() {
    this.config = null;
    this.apiPath = "/api/v1";
    this._circuitOpen = false;
    this._circuitOpenedAt = 0;
    this._circuitFailures = 0;
    this._lastCircuitFailureAt = 0;
    this._concurrent = 0;
    this._waitQueue = [];
    this._artistListCache = null;
    this._albumListCache = null;
    this._statusCache = new Map();
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
    if (
      this._lastCircuitFailureAt &&
      now - this._lastCircuitFailureAt > CIRCUIT_COOLDOWN_MS
    ) {
      this._circuitFailures = 0;
    }
    this._lastCircuitFailureAt = now;
    this._circuitFailures += 1;
    if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this._circuitOpen = true;
      this._circuitOpenedAt = now;
    }
  }

  _resetCircuitState() {
    this._circuitFailures = 0;
    this._lastCircuitFailureAt = 0;
    this._circuitOpen = false;
    this._circuitOpenedAt = 0;
  }

  updateConfig() {
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
    const timeoutMs =
      Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 30000;

    const circuitDisabled =
      process.env.LIDARR_CIRCUIT_DISABLED === "true" ||
      process.env.LIDARR_CIRCUIT_DISABLED === "1";

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
      this._albumListCache = null;
      this._statusCache.clear();
    }
  }

  getConfig() {
    this.updateConfig();
    return this.config;
  }

  isConfigured() {
    return !!this.config.apiKey;
  }

  getAuthHeaders() {
    if (!this.config.apiKey) {
      return {};
    }
    return {
      "X-Api-Key": this.config.apiKey.trim(),
    };
  }

  async request(
    endpoint,
    method = "GET",
    data = null,
    skipConfigUpdate = false,
    options = {},
  ) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }

    if (!this.isConfigured()) {
      throw new Error("Lidarr API key not configured");
    }

    const now = Date.now();
    if (method === "GET" && endpoint === "/artist") {
      if (
        this._artistListCache &&
        now - this._artistListCache.at < LIDARR_LIST_CACHE_MS
      ) {
        return this._artistListCache.data;
      }
    }
    if (
      method === "GET" &&
      (endpoint === "/album" || endpoint.startsWith("/album?"))
    ) {
      if (
        this._albumListCache &&
        now - this._albumListCache.at < LIDARR_LIST_CACHE_MS
      ) {
        return this._albumListCache.data;
      }
    }

    const isStatusRequest =
      method === "GET" &&
      (endpoint === "/queue" ||
        endpoint === "/command" ||
        endpoint.startsWith("/history"));
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
    if (!this.config.circuitDisabled && this._circuitOpen && !bypassCircuit) {
      if (now - this._circuitOpenedAt < CIRCUIT_COOLDOWN_MS) {
        throw new Error(
          "Lidarr unavailable (circuit open). Will retry after cooldown.",
        );
      }
      this._resetCircuitState();
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
      this._albumListCache = null;
    }
    if (method !== "GET" && endpoint.startsWith("/command")) {
      this._statusCache.delete("/command");
    }

    for (let attempt = 1; attempt <= LIDARR_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._acquireSlot();
        try {
          const fullUrl = `${this.config.url}${this.apiPath}${endpoint}`;

          const isHttps =
            fullUrl.startsWith("https:") || fullUrl.startsWith("HTTPS:");

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
              isHttps && this.config.insecure
                ? this._httpsInsecureAgent
                : this._httpsAgent,
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
          }
          if (
            method === "GET" &&
            (endpoint === "/album" || endpoint.startsWith("/album?"))
          ) {
            this._albumListCache = { data: response.data, at: Date.now() };
          }
          if (isStatusRequest) {
            this._statusCache.set(endpoint, {
              data: response.data,
              at: Date.now(),
            });
          }

          this._resetCircuitState();
          return response.data;
        } finally {
          this._releaseSlot();
        }
      } catch (raw) {
        const error = raw && typeof raw === "object" ? raw : {};
        const status = error.response?.status;
        const msg = error.message != null ? String(error.message) : String(raw);
        const isTimeout =
          error.code === "ECONNABORTED" ||
          msg.toLowerCase().includes("timeout");
        const isNoResponse = !error.response && (error.request || isTimeout);
        const isTransientStatus = typeof status === "number" && status >= 500;

        if (
          attempt < LIDARR_RETRY_ATTEMPTS &&
          (isNoResponse || isTransientStatus)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, LIDARR_RETRY_DELAY_MS),
          );
          continue;
        }

        if (
          !this.config.circuitDisabled &&
          (isNoResponse || isTransientStatus)
        ) {
          this._registerCircuitFailure();
        }

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

          const responseText =
            typeof responseData === "string" ? responseData : errorMsg;
          const responseTextLower = responseText?.toLowerCase?.();
          const isLidarrSkyhookRefused =
            status >= 500 &&
            responseTextLower &&
            responseTextLower.includes("api.lidarr.audio") &&
            (responseTextLower.includes("connection refused") ||
              responseTextLower.includes("connect") ||
              responseTextLower.includes("econnrefused"));
          if (isLidarrSkyhookRefused) {
            throw new Error(
              "Lidarr cannot reach api.lidarr.audio from its container. Check Lidarr outbound internet/DNS or proxy settings.",
            );
          }
          if (status === 400) {
            throw new Error(
              `Lidarr API returned 400 Bad Request: ${errorMsg}${
                errorDetails ? `\n\nFull Response: ${errorDetails}` : ""
              }`,
            );
          }
          if (status === 401) {
            throw new Error(
              `Lidarr API authentication failed. Check your API key.`,
            );
          }
          if (status === 404) {
            const isAlbumEndpoint = endpoint.includes("/album/");
            if (isAlbumEndpoint) {
              return null;
            }
            throw new Error(
              `Lidarr endpoint not found: ${endpoint}. Check if Lidarr is running and the API version is correct.`,
            );
          }
          throw new Error(
            `Lidarr API error: ${status} - ${
              responseData?.message ||
              responseData?.error ||
              statusText ||
              "Unknown error"
            }`,
          );
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

    if (!this.isConfigured()) {
      return { connected: false, error: "Lidarr not configured" };
    }

    const apiPaths = ["/api/v1", "/api"];

    for (const apiPath of apiPaths) {
      this.apiPath = apiPath;

      try {
        try {
          const rootFolders = await this.request(
            "/rootFolder",
            "GET",
            null,
            skipConfigUpdate,
            { bypassCircuit: true },
          );
          return {
            connected: true,
            version: "connected",
            instanceName: "Lidarr",
            rootFoldersCount: Array.isArray(rootFolders)
              ? rootFolders.length
              : 0,
            apiPath: apiPath,
          };
        } catch (rootFolderError) {
          if (
            rootFolderError.message.includes("404") ||
            rootFolderError.message.includes("400")
          ) {
            try {
              const status = await this.request(
                "/system/status",
                "GET",
                null,
                skipConfigUpdate,
                { bypassCircuit: true },
              );
              return {
                connected: true,
                version: status.version || "unknown",
                instanceName: status.instanceName || "Lidarr",
                apiPath: apiPath,
              };
            } catch (statusError) {
              if (apiPath === "/api/v1" && apiPaths.length > 1) {
                continue;
              }
              throw rootFolderError;
            }
          }
          if (apiPath === "/api/v1" && apiPaths.length > 1) {
            continue;
          }
          throw rootFolderError;
        }
      } catch (error) {
        if (apiPath === apiPaths[apiPaths.length - 1]) {
          const errorMessage = error.message || "Unknown error";
          const errorDetails = error.response?.data
            ? typeof error.response.data === "string"
              ? error.response.data
              : JSON.stringify(error.response.data, null, 2)
            : "";

          const fullUrl = `${this.config.url}${apiPath}/rootFolder`;

          return {
            connected: false,
            error: errorMessage,
            details: errorDetails,
            url: this.config.url,
            fullUrl: fullUrl,
            statusCode: error.response?.status,
            apiPath: apiPath,
            responseHeaders: error.response?.headers,
          };
        }
        continue;
      }
    }

    return {
      connected: false,
      error: "Failed to connect with any API path",
      url: this.config.url,
    };
  }

  async getRootFolders() {
    return this.request("/rootFolder");
  }

  async addArtist(mbid, artistName, options = {}) {
    const rootFolders = await this.getRootFolders();
    if (!rootFolders || rootFolders.length === 0) {
      throw new Error("No root folders configured in Lidarr");
    }

    const rootFolder = rootFolders[0];
    const settings = dbOps.getSettings();

    const albumOnly = options.albumOnly === true;
    const monitorOption = options.monitorOption || options.monitor || "none";
    const lidarrMonitorOption = monitorOption;
    const artistMonitored = albumOnly || monitorOption !== "none";
    const effectiveMonitor = albumOnly ? "missing" : lidarrMonitorOption;
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const monitorNewItems = monitorOption === "none" ? "none" : "all";

    const defaultQualityProfileId =
      settings.integrations?.lidarr?.qualityProfileId;
    const qualityProfileId =
      options.qualityProfileId || defaultQualityProfileId || 1;
    const defaultMetadataProfileId =
      settings.integrations?.lidarr?.metadataProfileId;
    let metadataProfileId =
      options.metadataProfileId || defaultMetadataProfileId || null;
    if (!metadataProfileId) {
      try {
        const metadataProfiles = await this.getMetadataProfiles();
        if (Array.isArray(metadataProfiles) && metadataProfiles.length > 0) {
          metadataProfileId = metadataProfiles[0].id;
        }
      } catch {}
    }
    if (!metadataProfileId) metadataProfileId = 1;

    const lidarrArtist = {
      artistName: artistName,
      foreignArtistId: mbid,
      rootFolderPath: rootFolder.path,
      qualityProfileId: qualityProfileId,
      metadataProfileId: metadataProfileId,
      monitored: artistMonitored,
      monitor: effectiveMonitor,
      monitorNewItems: monitorNewItems,
      albumsToMonitor: [],
      addOptions: {
        monitor: effectiveMonitor,
        searchForMissingAlbums: searchOnAdd,
      },
    };

    try {
      const result = await this.request("/artist", "POST", lidarrArtist);
      return result;
    } catch (error) {
      if (monitorOption !== "all") {
        throw error;
      }
      const fallbackArtist = {
        ...lidarrArtist,
        monitor: "existing",
        addOptions: {
          ...lidarrArtist.addOptions,
          monitor: "existing",
        },
      };
      return this.request("/artist", "POST", fallbackArtist);
    }
  }

  async getArtist(artistId) {
    return this.request(`/artist/${artistId}`);
  }

  async getArtistByMbid(mbid) {
    const artists = await this.request("/artist");
    return artists.find((a) => a.foreignArtistId === mbid);
  }

  async updateArtist(artistId, updates) {
    const artist = await this.getArtist(artistId);

    const updated = {
      ...artist,
      ...updates,
    };

    return this.request(`/artist/${artistId}`, "PUT", updated);
  }

  async updateArtistMonitoring(artistId, monitorOption) {
    const artist = await this.getArtist(artistId);
    const lidarrMonitorOption = monitorOption;
    const monitorNewItems = monitorOption === "none" ? "none" : "all";

    const updated = {
      ...artist,
      monitored: monitorOption !== "none",
      monitor: lidarrMonitorOption,
      monitorNewItems: monitorNewItems,
      addOptions: {
        ...(artist.addOptions || {}),
        monitor: lidarrMonitorOption,
      },
    };

    try {
      return await this.request(`/artist/${artistId}`, "PUT", updated);
    } catch (error) {
      if (monitorOption !== "all") {
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
      return this.request(`/artist/${artistId}`, "PUT", fallbackUpdated);
    }
  }

  async addAlbum(artistId, albumMbid, albumName, options = {}) {
    const artist = await this.getArtist(artistId);
    if (!artist) {
      throw new Error(`Artist with ID ${artistId} not found in Lidarr`);
    }

    const lidarrAlbum = {
      title: albumName,
      foreignAlbumId: albumMbid,
      artistId: artistId,
      artist: artist,
      monitored: options.monitored !== false,
      anyReleaseOk: true,
      images: [],
    };

    const result = await this.request("/album", "POST", lidarrAlbum);

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
      if (result?.records && Array.isArray(result.records))
        return result.records;
      return [];
    } catch {
      return [];
    }
  }

  async getAlbumByMbid(albumMbid) {
    const albums = await this.request("/album");
    return albums.find((a) => a.foreignAlbumId === albumMbid);
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
    return this.request("/command", "POST", {
      name: "AlbumSearch",
      albumIds: [albumId],
    });
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

  async getHistory(
    page = 1,
    pageSize = 20,
    sortKey = "date",
    sortDirection = "descending",
  ) {
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
    return this.request(`/artist/${artistId}${query}`, "DELETE");
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
    return this.request(
      "/metadataprofile",
      "POST",
      profileData,
      skipConfigUpdate,
    );
  }

  async updateMetadataProfile(
    profileId,
    profileData,
    skipConfigUpdate = false,
  ) {
    return this.request(
      `/metadataprofile/${profileId}`,
      "PUT",
      profileData,
      skipConfigUpdate,
    );
  }

  async getQualityProfile(profileId, skipConfigUpdate = false) {
    return this.request(
      `/qualityprofile/${profileId}`,
      "GET",
      null,
      skipConfigUpdate,
    );
  }

  async createQualityProfile(profileData, skipConfigUpdate = false) {
    return this.request(
      "/qualityprofile",
      "POST",
      profileData,
      skipConfigUpdate,
    );
  }

  async updateQualityProfile(profileId, profileData, skipConfigUpdate = false) {
    return this.request(
      `/qualityprofile/${profileId}`,
      "PUT",
      profileData,
      skipConfigUpdate,
    );
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
    return this.request(
      "/releaseprofile",
      "POST",
      profileData,
      skipConfigUpdate,
    );
  }

  async updateReleaseProfile(profileId, profileData, skipConfigUpdate = false) {
    return this.request(
      `/releaseprofile/${profileId}`,
      "PUT",
      profileData,
      skipConfigUpdate,
    );
  }

  async getQualityDefinitions(skipConfigUpdate = false) {
    return this.request("/qualitydefinition", "GET", null, skipConfigUpdate);
  }

  async updateQualityDefinition(id, data, skipConfigUpdate = false) {
    return this.request(
      `/qualitydefinition/${id}`,
      "PUT",
      data,
      skipConfigUpdate,
    );
  }
}

export const lidarrClient = new LidarrClient();
