import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { dbOps } from "../db/helpers/index.ts";
import { asAppError } from "../../lib/errors.ts";
import { readMany, readOne } from "./integrationData.ts";
import {
  isUsenetClientKey,
  normalizeBaseUrl,
  normalizeInteger,
  type UsenetClientKey,
} from "./usenetClientCommon.ts";

const DEFAULT_MUSIC_CATEGORIES = [3000];
const DEFAULT_MAX_RESULTS = 60;

const categoriesSchema = v.nullish(v.array(v.looseObject({ id: v.number() })));

const statusSchema = v.looseObject({
  appName: v.nullish(v.string()),
  version: v.nullish(v.string()),
});

const indexerSchema = v.looseObject({
  id: v.number(),
  name: v.nullish(v.string()),
  protocol: v.optional(v.string()),
  enable: v.optional(v.boolean()),
  supportsSearch: v.optional(v.boolean()),
  priority: v.optional(v.number()),
  capabilities: v.nullish(
    v.looseObject({
      categories: categoriesSchema,
      musicSearchParams: v.nullish(v.array(v.string())),
    }),
  ),
});

const releaseSchema = v.looseObject({
  guid: v.nullish(v.string()),
  title: v.nullish(v.string()),
  size: v.optional(v.number()),
  files: v.nullish(v.number()),
  grabs: v.nullish(v.number()),
  indexerId: v.optional(v.number()),
  indexer: v.nullish(v.string()),
  publishDate: v.optional(v.string()),
  downloadUrl: v.nullish(v.string()),
  protocol: v.optional(v.string()),
  categories: categoriesSchema,
});

type ProwlarrIndexer = v.InferOutput<typeof indexerSchema>;

type ProwlarrRelease = v.InferOutput<typeof releaseSchema>;

type ProwlarrIndexerOverride = {
  enabled: boolean;
  priority: number | null;
  downloadClient: UsenetClientKey | null;
};

type ProwlarrIndexerOverrideInput = {
  enabled?: unknown;
  priority?: unknown;
  downloadClient?: unknown;
};

const normalizeIndexerOverride = (entry: ProwlarrIndexerOverrideInput | null | undefined) => ({
  enabled: entry?.enabled !== false,
  priority: normalizePositiveInteger(entry?.priority, null),
  downloadClient: isUsenetClientKey(entry?.downloadClient) ? entry.downloadClient : null,
});

type ProwlarrSettings = ReturnType<typeof getSettings>;

type NormalizedIndexer = ReturnType<typeof normalizeIndexer>;

type ProwlarrConnectionStatus = {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  message: string;
  version?: string | null;
  appName?: string;
  indexerCount?: number;
  usenetIndexerCount?: number;
  enabledUsenetIndexerCount?: number;
  indexers?: NormalizedIndexer[];
};

type ProwlarrSearchOptions = {
  indexers?: NormalizedIndexer[];
  categories?: number[];
  type?: string;
  limit?: number;
  offset?: number;
};

let connectionCache: { checkedAt: number; result: ProwlarrConnectionStatus | null } = {
  checkedAt: 0,
  result: null,
};
let indexerCache: { key: string | null; at: number; indexers: ProwlarrIndexer[] } = {
  key: null,
  at: 0,
  indexers: [],
};
const INDEXER_CACHE_MS = 5 * 60 * 1000;
const NZB_LIMIT_FALLBACK_MS = 60 * 60 * 1000;
const NZB_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;
const nzbLimitedUntil = new Map<string, number>();

function readRetryAfterMs(value: unknown) {
  const text = String(value ?? "").trim();
  const seconds = Number(text);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - Date.now();
  if (!text || !Number.isFinite(ms)) return NZB_LIMIT_FALLBACK_MS;
  return Math.min(Math.max(ms, 0), NZB_LIMIT_MAX_MS);
}

function nzbLimitError(indexer: string | null | undefined, until: number) {
  const minutes = Math.ceil((until - Date.now()) / 60000);
  const message = `${indexer || "The indexer"} has reached its NZB limit.`;
  if (minutes <= 0) return new Error(message);
  const wait =
    minutes >= 120
      ? `${Math.round(minutes / 60)} hours`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return new Error(`${message} Aurral will ask it again in ${wait}.`);
}

function normalizePositiveInteger(value: unknown, fallback: number): number;
function normalizePositiveInteger(value: unknown, fallback: null): number | null;
function normalizePositiveInteger(value: unknown, fallback: number | null): number | null {
  const parsed = normalizeInteger(value, null);
  if (parsed == null || parsed <= 0) return fallback;
  return parsed;
}

function normalizeCategoryList(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim());
  const categories = raw
    .map((entry) => normalizeInteger(entry, null))
    .filter((entry): entry is number => entry != null && entry > 0);
  return categories.length > 0 ? [...new Set(categories)] : DEFAULT_MUSIC_CATEGORIES;
}

function normalizeIndexerOverrides(value: unknown): Record<string, ProwlarrIndexerOverride> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry): [string, ProwlarrIndexerOverride] | null => {
          const id = normalizeInteger(entry?.id, null);
          if (id == null) return null;
          return [String(id), normalizeIndexerOverride(entry)];
        })
        .filter(Boolean) as [string, ProwlarrIndexerOverride][],
    );
  }
  if (!value || typeof value !== "object") return {};
  const out: Record<string, ProwlarrIndexerOverride> = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = normalizeInteger(key, null);
    if (id == null) continue;
    out[String(id)] = normalizeIndexerOverride(entry);
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

function buildClientFromCredentials(url: string, apiKey: string) {
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

function hasMusicCategory(supported: number[], configuredCategories = DEFAULT_MUSIC_CATEGORIES) {
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

function normalizeIndexer(indexer: ProwlarrIndexer, settings: ProwlarrSettings = getSettings()) {
  const override = settings.indexers[String(indexer.id)];
  const musicParams = indexer.capabilities?.musicSearchParams ?? [];
  return {
    musicSearch: musicParams.includes("artist") || musicParams.includes("album"),
    id: indexer.id,
    name: indexer.name?.trim() || `Indexer ${indexer.id}`,
    protocol: indexer.protocol ?? "",
    enabledInProwlarr: indexer.enable === true,
    enabled: indexer.enable === true && override?.enabled !== false,
    supportsSearch: indexer.supportsSearch !== false,
    priority: override?.priority ?? normalizePositiveInteger(indexer.priority, 25),
    categories: indexer.capabilities?.categories?.map((category) => category.id) ?? [],
  };
}

function resolveProwlarrUrl(value: unknown) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const base = getSettings().url;
  if (!base) return url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

function normalizeRelease(release: ProwlarrRelease) {
  return {
    guid: release.guid?.trim() || null,
    title: release.title?.trim() ?? "",
    size: release.size ?? 0,
    files: release.files ?? null,
    grabs: release.grabs ?? null,
    indexerId: release.indexerId ?? null,
    indexer: release.indexer?.trim() || null,
    publishDate: release.publishDate || null,
    downloadUrl: resolveProwlarrUrl(release.downloadUrl),
    protocol: release.protocol ?? "",
    categories: release.categories?.map((category) => category.id) ?? [],
  };
}

function formatHttpErrorBody(data: unknown): string {
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
      Reflect.get(data, "message") ||
      Reflect.get(data, "errorMessage") ||
      Reflect.get(data, "error") ||
      Reflect.get(data, "title") ||
      Reflect.get(data, "detail") ||
      Reflect.get(data, "description");
    if (message) return String(message).trim().slice(0, 500);
    try {
      return JSON.stringify(data).slice(0, 500);
    } catch {
      return "";
    }
  }
  return String(data).trim().slice(0, 500);
}

function buildSearchParams({
  query,
  indexerIds,
  categories,
  type = "search",
  limit,
  offset = 0,
}: {
  query: string;
  indexerIds?: number[];
  categories?: unknown;
  type?: string;
  limit?: number | null;
  offset?: number;
}) {
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

  getIndexerDownloadClient(indexerId: unknown) {
    return getSettings().indexers[String(indexerId ?? "")]?.downloadClient ?? null;
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

  async testConnection({
    force = false,
  }: { force?: boolean } = {}): Promise<ProwlarrConnectionStatus> {
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
      const status = readOne(statusSchema, statusRes.data, {
        service: "Prowlarr",
        endpoint: "/api/v1/system/status",
      });
      const indexers = readMany(indexerSchema, indexerRes.data, {
        service: "Prowlarr",
        endpoint: "/api/v1/indexer",
      });
      const usenet = indexers
        .map((entry) => normalizeIndexer(entry, settings))
        .filter(
          (entry) =>
            entry.protocol === "usenet" &&
            entry.supportsSearch &&
            hasMusicCategory(entry.categories, settings.categories),
        );
      const result = {
        ok: true,
        configured: true,
        connected: true,
        version: status.version || null,
        appName: status.appName || "Prowlarr",
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
        message: asAppError(error)?.message || "Failed to reach Prowlarr",
      };
      connectionCache = { checkedAt: Date.now(), result };
      return result;
    }
  }

  // Every search reads the indexer list, so it is kept for a few minutes.
  // The settings page asks for a fresh list.
  async listUsenetIndexers({ force = false }: { force?: boolean } = {}) {
    const settings = getSettings();
    if (!this.isConfigured()) return [];
    const key = `${settings.url}\0${settings.apiKey}`;
    if (force || indexerCache.key !== key || Date.now() - indexerCache.at > INDEXER_CACHE_MS) {
      const response = await buildClient().get("/api/v1/indexer");
      if (response.status !== 200) {
        throw new Error(`Prowlarr indexer list failed: HTTP ${response.status}`);
      }
      indexerCache = {
        key,
        at: Date.now(),
        indexers: readMany(indexerSchema, response.data, {
          service: "Prowlarr",
          endpoint: "/api/v1/indexer",
        }),
      };
    }
    return indexerCache.indexers
      .map((entry) => normalizeIndexer(entry, settings))
      .filter(
        (entry) =>
          entry.protocol === "usenet" &&
          entry.supportsSearch &&
          hasMusicCategory(entry.categories, settings.categories),
      )
      .sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        return left.name.localeCompare(right.name);
      });
  }

  async getEnabledUsenetIndexers() {
    const indexers = await this.listUsenetIndexers();
    return indexers.filter((entry) => entry.enabled);
  }

  async search(query: string, options: ProwlarrSearchOptions = {}) {
    if (!this.isConfigured()) {
      throw new Error("Prowlarr is not configured");
    }
    const settings = getSettings();
    const indexers =
      Array.isArray(options.indexers) && options.indexers.length > 0
        ? options.indexers
        : await this.getEnabledUsenetIndexers();
    if (indexers.length === 0) return [];
    const queryString = buildSearchParams({
      query,
      indexerIds: indexers.map((entry) => entry.id),
      categories: options.categories || settings.categories,
      type: options.type || "search",
      limit: normalizePositiveInteger(options.limit, settings.maxResults),
      offset: normalizeInteger(options.offset, 0),
    });
    const endpoint = `/api/v1/search?${queryString}`;
    const response = await buildClient().get(endpoint);
    if (response.status !== 200) {
      const detail = formatHttpErrorBody(response.data);
      throw new Error(
        `Prowlarr search failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return readMany(releaseSchema, response.data, { service: "Prowlarr", endpoint })
      .map(normalizeRelease)
      .filter((release) => release.protocol === "usenet" && release.downloadUrl && release.title);
  }

  // Like Lidarr, Aurral fetches the NZB itself and hands the download client
  // the file, so the client never needs to reach Prowlarr at Aurral's address.
  async downloadNzb(
    downloadUrl: string | null | undefined,
    {
      indexerId = null,
      indexer = "",
    }: { indexerId?: string | number | null; indexer?: string | null } = {},
  ) {
    const url = String(downloadUrl || "").trim();
    if (!url) throw new Error("No Usenet release URL available");
    const limitKey = String(indexerId ?? "").trim();
    const limitedUntil = nzbLimitedUntil.get(limitKey) || 0;
    if (limitKey && limitedUntil > Date.now()) throw nzbLimitError(indexer, limitedUntil);
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      validateStatus: () => true,
    });
    if (response.status === 429) {
      const until = Date.now() + readRetryAfterMs(response.headers?.["retry-after"]);
      if (limitKey) nzbLimitedUntil.set(limitKey, until);
      throw nzbLimitError(indexer, until);
    }
    if (response.status !== 200) {
      throw new Error(`The indexer did not return the NZB: HTTP ${response.status}`);
    }
    const content = Buffer.from(response.data || []);
    const head = content.subarray(0, 65536).toString("utf8");
    if (!/<nzb[\s>]/iu.test(head)) {
      const error: Error & { nzbGrabSpent?: boolean } = new Error(
        "The indexer did not return an NZB file",
      );
      error.nzbGrabSpent = !/<error[\s>]/iu.test(head);
      throw error;
    }
    return content;
  }
}

export const prowlarrClient = new ProwlarrClient();
