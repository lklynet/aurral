import axios from "../../lib/axiosFetch.js";
import { dbOps } from "../db/helpers/index.js";
import { normalizeBaseUrl, normalizeInteger } from "./usenetClientCommon.js";

const DEFAULT_MUSIC_CATEGORIES = [3000];
const DEFAULT_MAX_RESULTS = 60;

let connectionCache = { checkedAt: 0, result: null };
let indexerCache = { key: null, at: 0, indexers: [] };
const INDEXER_CACHE_MS = 5 * 60 * 1000;

function normalizePositiveInteger(value, fallback) {
  const parsed = normalizeInteger(value, null);
  if (parsed == null || parsed <= 0) return fallback;
  return parsed;
}

function normalizeCategoryList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim());
  const categories = raw
    .map((entry) => normalizeInteger(entry, null))
    .filter((entry) => entry != null && entry > 0);
  return categories.length > 0 ? [...new Set(categories)] : DEFAULT_MUSIC_CATEGORIES;
}

function normalizeIndexerOverrides(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => {
          const id = normalizeInteger(entry?.id, null);
          if (id == null) return null;
          return [
            String(id),
            {
              enabled: entry?.enabled !== false,
              priority: normalizePositiveInteger(entry?.priority, null),
            },
          ];
        })
        .filter(Boolean),
    );
  }
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = normalizeInteger(key, null);
    if (id == null) continue;
    out[String(id)] = {
      enabled: entry?.enabled !== false,
      priority: normalizePositiveInteger(entry?.priority, null),
    };
  }
  return out;
}

function getSettings() {
  const prowlarr = dbOps.getSettings()?.integrations?.prowlarr || {};
  return {
    enabled: prowlarr.enabled === true,
    url: normalizeBaseUrl(prowlarr.url),
    apiKey: String(prowlarr.apiKey || "").trim(),
    categories: normalizeCategoryList(prowlarr.categories),
    maxResults: normalizePositiveInteger(prowlarr.maxResults, DEFAULT_MAX_RESULTS),
    indexers: normalizeIndexerOverrides(prowlarr.indexers),
  };
}

function buildClientFromCredentials(url, apiKey) {
  const trimmedUrl = normalizeBaseUrl(url);
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedUrl || !trimmedKey) {
    throw new Error("Prowlarr not configured");
  }
  return axios.create({
    baseURL: trimmedUrl,
    timeout: 45000,
    headers: {
      "X-Api-Key": trimmedKey,
      Accept: "application/json",
    },
    validateStatus: () => true,
  });
}

function buildClient() {
  const { url, apiKey } = getSettings();
  return buildClientFromCredentials(url, apiKey);
}

function normalizeProtocol(value) {
  const protocol = String(value || "")
    .trim()
    .toLowerCase();
  return protocol;
}

function readCategoryIds(categories) {
  if (!Array.isArray(categories)) return [];
  const ids = [];
  for (const category of categories) {
    const id = normalizeInteger(category?.id ?? category, null);
    if (id != null) ids.push(id);
  }
  return [...new Set(ids)];
}

function hasMusicCategory(indexer, configuredCategories = DEFAULT_MUSIC_CATEGORIES) {
  const supported = readCategoryIds(indexer?.capabilities?.categories);
  if (supported.length === 0) return true;
  return supported.some((id) =>
    configuredCategories.some((category) => {
      if (category % 1000 === 0) {
        return id >= category && id < category + 1000;
      }
      return id === category;
    }),
  );
}

function normalizeIndexer(indexer, settings = getSettings()) {
  const id = normalizeInteger(indexer?.id, null);
  const override = id != null ? settings.indexers[String(id)] : null;
  const priority = override?.priority ?? normalizePositiveInteger(indexer?.priority, 25);
  const musicParams = (indexer?.capabilities?.musicSearchParams || [])
    .map((param) => String(param || "").toLowerCase());
  return {
    musicSearch: musicParams.includes("artist") || musicParams.includes("album"),
    id,
    name: String(indexer?.name || indexer?.definitionName || `Indexer ${id}`).trim(),
    protocol: normalizeProtocol(indexer?.protocol),
    enabledInProwlarr: indexer?.enable === true,
    enabled: indexer?.enable === true && override?.enabled !== false,
    supportsSearch: indexer?.supportsSearch !== false,
    priority,
    categories: readCategoryIds(indexer?.capabilities?.categories),
    raw: indexer,
  };
}

function resolveProwlarrUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const base = getSettings().url;
  if (!base) return url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

function normalizeRelease(release) {
  const indexerId = normalizeInteger(release?.indexerId, null);
  const title = String(release?.title || release?.sortTitle || "").trim();
  const downloadUrl = resolveProwlarrUrl(release?.downloadUrl);
  return {
    id: release?.id ?? null,
    guid: String(release?.guid || release?.releaseHash || "").trim() || null,
    title,
    size: Number(release?.size || 0),
    files: normalizeInteger(release?.files, null),
    grabs: normalizeInteger(release?.grabs, null),
    indexerId,
    indexer: String(release?.indexer || "").trim() || null,
    publishDate: release?.publishDate || null,
    downloadUrl,
    infoUrl: resolveProwlarrUrl(release?.infoUrl),
    protocol: normalizeProtocol(release?.protocol),
    categories: readCategoryIds(release?.categories),
    raw: release,
  };
}

function formatHttpErrorBody(data) {
  if (!data) return "";
  if (typeof data === "string") return data.trim().slice(0, 500);
  if (Array.isArray(data)) {
    return data
      .map((entry) => formatHttpErrorBody(entry))
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
  }
  if (typeof data === "object") {
    const message =
      data.message ||
      data.errorMessage ||
      data.error ||
      data.title ||
      data.detail ||
      data.description;
    if (message) return String(message).trim().slice(0, 500);
    try {
      return JSON.stringify(data).slice(0, 500);
    } catch {
      return "";
    }
  }
  return String(data).trim().slice(0, 500);
}

function buildSearchParams({ query, indexerIds, categories, type = "search", limit, offset = 0 }) {
  const params = new URLSearchParams();
  params.set("query", String(query || "").trim());
  params.set("type", type);
  if (Array.isArray(indexerIds) && indexerIds.length > 0) {
    for (const indexerId of indexerIds) {
      params.append("indexerIds", String(indexerId));
    }
  }
  for (const category of normalizeCategoryList(categories)) {
    params.append("categories", String(category));
  }
  if (limit != null) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  return params.toString();
}

export class ProwlarrClient {
  isConfigured() {
    const { enabled, url, apiKey } = getSettings();
    return enabled && !!(url && apiKey);
  }

  getStatus() {
    const settings = getSettings();
    const cached = connectionCache.result;
    return {
      enabled: settings.enabled,
      configured: this.isConfigured(),
      connected: cached?.connected === true,
      indexerCount: cached?.indexerCount || 0,
      usenetIndexerCount: cached?.usenetIndexerCount || 0,
    };
  }

  async testConnection({ force = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "Prowlarr is disabled",
      };
    }
    if (!settings.url || !settings.apiKey) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "Prowlarr URL and API key are required",
      };
    }
    if (!force && connectionCache.result && Date.now() - connectionCache.checkedAt < 30000) {
      return connectionCache.result;
    }
    const client = buildClient();
    try {
      const [statusRes, indexerRes] = await Promise.all([
        client.get("/api/v1/system/status"),
        client.get("/api/v1/indexer"),
      ]);
      if (statusRes.status !== 200) {
        const result = {
          ok: false,
          configured: true,
          connected: false,
          message: `Prowlarr returned HTTP ${statusRes.status}`,
        };
        connectionCache = { checkedAt: Date.now(), result };
        return result;
      }
      const indexers = Array.isArray(indexerRes.data) ? indexerRes.data : [];
      const normalized = indexers.map((entry) => normalizeIndexer(entry, settings));
      const usenet = normalized.filter(
        (entry) =>
          entry.protocol === "usenet" &&
          entry.supportsSearch &&
          hasMusicCategory(entry.raw, settings.categories),
      );
      const result = {
        ok: true,
        configured: true,
        connected: true,
        version: statusRes.data?.version || null,
        appName: statusRes.data?.appName || "Prowlarr",
        indexerCount: indexers.length,
        usenetIndexerCount: usenet.length,
        enabledUsenetIndexerCount: usenet.filter((entry) => entry.enabled).length,
        indexers: usenet,
        message: `Prowlarr is connected with ${usenet.length} Usenet indexer(s)`,
      };
      connectionCache = { checkedAt: Date.now(), result };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach Prowlarr",
      };
      connectionCache = { checkedAt: Date.now(), result };
      return result;
    }
  }

  // Every search reads the indexer list, so it is kept for a few minutes.
  // The settings page asks for a fresh list.
  async listUsenetIndexers({ force = false } = {}) {
    const settings = getSettings();
    if (!this.isConfigured()) return [];
    const key = `${settings.url}\0${settings.apiKey}`;
    if (force || indexerCache.key !== key || Date.now() - indexerCache.at > INDEXER_CACHE_MS) {
      const response = await buildClient().get("/api/v1/indexer");
      if (response.status !== 200) {
        throw new Error(`Prowlarr indexer list failed: HTTP ${response.status}`);
      }
      indexerCache = { key, at: Date.now(), indexers: Array.isArray(response.data) ? response.data : [] };
    }
    return indexerCache.indexers
      .map((entry) => normalizeIndexer(entry, settings))
      .filter(
        (entry) =>
          entry.id != null &&
          entry.protocol === "usenet" &&
          entry.supportsSearch &&
          hasMusicCategory(entry.raw, settings.categories),
      )
      .sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        return String(left.name).localeCompare(String(right.name));
      });
  }

  async getEnabledUsenetIndexers() {
    const indexers = await this.listUsenetIndexers();
    return indexers.filter((entry) => entry.enabled);
  }

  async search(query, options = {}) {
    if (!this.isConfigured()) {
      throw new Error("Prowlarr is not configured");
    }
    const settings = getSettings();
    const indexers =
      Array.isArray(options.indexers) && options.indexers.length > 0
        ? options.indexers
        : await this.getEnabledUsenetIndexers();
    if (indexers.length === 0) return [];
    const indexerIds = indexers.map((entry) => entry.id).filter((id) => id != null);
    const queryString = buildSearchParams({
      query,
      indexerIds,
      categories: options.categories || settings.categories,
      type: options.type || "search",
      limit: normalizePositiveInteger(options.limit, settings.maxResults),
      offset: normalizeInteger(options.offset, 0),
    });
    const response = await buildClient().get(`/api/v1/search?${queryString}`);
    if (response.status !== 200) {
      const detail = formatHttpErrorBody(response.data);
      throw new Error(
        `Prowlarr search failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (Array.isArray(response.data) ? response.data : [])
      .map(normalizeRelease)
      .filter((release) => release.protocol === "usenet" && release.downloadUrl && release.title);
  }

  // Like Lidarr, Aurral fetches the NZB itself and hands the download client
  // the file, so the client never needs to reach Prowlarr at Aurral's address.
  async downloadNzb(downloadUrl) {
    const url = String(downloadUrl || "").trim();
    if (!url) throw new Error("No Usenet release URL available");
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      throw new Error(`The indexer did not return the NZB: HTTP ${response.status}`);
    }
    const content = Buffer.from(response.data || []);
    if (!/<nzb[\s>]/iu.test(content.subarray(0, 65536).toString("utf8"))) {
      throw new Error("The indexer did not return an NZB file");
    }
    return content;
  }
}

export const prowlarrClient = new ProwlarrClient();
