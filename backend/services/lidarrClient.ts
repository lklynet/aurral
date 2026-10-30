import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import http from "http";
import https from "https";
import { dbOps } from "../db/helpers/index.ts";
import type { AppSettings } from "../db/helpers/settings.ts";
import type { UserRecord } from "../db/helpers/users.ts";
import { asAppError } from "../../lib/errors.ts";
import { logger } from "./logger.ts";
import BoundedMap from "./boundedMap.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import { musicbrainzGetArtistIdentityByMbid } from "./apiClients/musicbrainz.ts";

const CIRCUIT_COOLDOWN_MS = 60000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const LIDARR_MAX_CONCURRENT = 12;
export const LIDARR_TRACK_FILE_ID_BATCH_SIZE = 400;
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
// Lidarr omits album/artist from queue records unless asked and pages the
// queue at 10 items by default.
const QUEUE_ENDPOINT = "/queue?includeArtist=true&includeAlbum=true&pageSize=200";
const isQueueEndpoint = (endpoint: string) =>
  endpoint === "/queue" || endpoint.startsWith("/queue?");
const VALID_MONITOR_OPTIONS = new Set([
  "none",
  "existing",
  "all",
  "future",
  "missing",
  "latest",
  "first",
]);

type LidarrAxiosConfig = Parameters<typeof axios>[0];
type LidarrHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface LidarrPage<T> {
  records: T[];
}

const text = v.nullish(v.string());
const ids = v.nullish(v.array(v.number()));

const statisticsSchema = v.looseObject({
  albumCount: v.optional(v.number()),
  trackCount: v.optional(v.number()),
  trackFileCount: v.optional(v.number()),
  percentOfTracks: v.optional(v.number()),
  sizeOnDisk: v.optional(v.number()),
});

const artistLookupSchema = v.looseObject({
  id: v.optional(v.union([v.number(), v.string()])),
  artistName: text,
  foreignArtistId: text,
  sortName: text,
  monitored: v.optional(v.boolean()),
  monitorNewItems: text,
  metadataProfileId: v.optional(v.number()),
  path: text,
  added: v.optional(v.string()),
  statistics: v.nullish(statisticsSchema),
  addOptions: v.nullish(
    v.looseObject({
      monitor: text,
    }),
  ),
});

const artistSchema = v.looseObject({ ...artistLookupSchema.entries, id: v.number() });

const albumSchema = v.looseObject({
  id: v.number(),
  title: text,
  foreignAlbumId: v.string(),
  artistId: v.optional(v.number()),
  artist: v.nullish(artistSchema),
  monitored: v.optional(v.boolean()),
  releaseDate: text,
  statistics: v.nullish(statisticsSchema),
});

const qualitySchema = v.nullish(
  v.looseObject({ quality: v.nullish(v.looseObject({ name: text })) }),
);

const trackFileSchema = v.looseObject({
  id: v.number(),
  path: text,
  size: v.optional(v.number()),
  dateAdded: v.optional(v.string()),
  quality: qualitySchema,
});

const trackSchema = v.looseObject({
  id: v.number(),
  trackFileId: v.optional(v.number()),
  foreignTrackId: text,
  foreignRecordingId: text,
  title: text,
  trackNumber: text,
  hasFile: v.optional(v.boolean()),
  trackFile: v.nullish(trackFileSchema),
});

const queueItemSchema = v.looseObject({
  id: v.number(),
  artistId: v.nullish(v.number()),
  albumId: v.nullish(v.number()),
  artist: v.nullish(artistSchema),
  album: v.nullish(albumSchema),
  title: text,
  status: text,
  trackedDownloadStatus: text,
  trackedDownloadState: text,
  errorMessage: text,
  statusMessages: v.nullish(
    v.array(v.looseObject({ title: text, messages: v.nullish(v.array(v.string())) })),
  ),
  size: v.optional(v.number()),
  sizeleft: v.optional(v.number()),
  added: text,
});

const historyItemSchema = v.looseObject({
  id: v.number(),
  albumId: v.optional(v.number()),
  artistId: v.optional(v.number()),
  sourceTitle: text,
  date: v.optional(v.string()),
  eventDate: text,
  eventType: text,
  album: v.nullish(albumSchema),
  artist: v.nullish(artistSchema),
});

const commandSchema = v.looseObject({
  id: v.optional(v.number()),
  name: text,
  commandName: text,
  status: text,
  body: v.nullish(v.looseObject({ albumIds: ids })),
  albumIds: ids,
  ended: text,
  completedAt: text,
  endTime: text,
});

const rootFolderSchema = v.looseObject({
  path: text,
});

const tagSchema = v.looseObject({ id: v.number(), label: text });

export type LidarrQualityItem = {
  [key: string]: unknown;
  quality?: { [key: string]: unknown; id?: number; name?: string | null } | null;
  items?: LidarrQualityItem[] | null;
};

const qualityItemSchema: v.GenericSchema<LidarrQualityItem> = v.looseObject({
  quality: v.nullish(v.looseObject({ id: v.optional(v.number()), name: text })),
  items: v.nullish(v.array(v.lazy(() => qualityItemSchema))),
});

const qualityProfileSchema = v.looseObject({
  id: v.number(),
  name: v.string(),
  cutoff: v.optional(v.number()),
  items: v.nullish(v.array(qualityItemSchema)),
});

const albumTypeOptionSchema = v.union([
  v.string(),
  v.looseObject({
    name: text,
    value: text,
    albumType: v.nullish(v.looseObject({ name: text })),
    allowed: v.optional(v.boolean()),
  }),
]);

const metadataProfileSchema = v.looseObject({
  id: v.number(),
  name: v.string(),
  primaryAlbumTypes: v.nullish(v.array(albumTypeOptionSchema)),
  secondaryAlbumTypes: v.nullish(v.array(albumTypeOptionSchema)),
});

const customFormatSchema = v.looseObject({ id: v.number(), name: v.string() });

const releaseProfileSchema = v.looseObject({
  id: v.number(),
  name: text,
  ignored: v.nullish(v.union([v.array(v.string()), v.string()])),
});

const qualityDefinitionSchema = v.looseObject({
  id: v.number(),
  title: text,
  quality: v.nullish(v.looseObject({ id: v.optional(v.number()), name: text })),
});

const namingConfigSchema = v.looseObject({ id: v.number() });

const systemStatusSchema = v.looseObject({ version: text, instanceName: text });

type LidarrArtistLookup = v.InferOutput<typeof artistLookupSchema>;
export type LidarrArtist = v.InferOutput<typeof artistSchema>;
export type LidarrAlbum = v.InferOutput<typeof albumSchema>;
export type LidarrTrack = v.InferOutput<typeof trackSchema>;
export type LidarrTrackFile = v.InferOutput<typeof trackFileSchema>;
export type LidarrQueueItem = v.InferOutput<typeof queueItemSchema>;
export type LidarrHistoryItem = v.InferOutput<typeof historyItemSchema>;
export type LidarrCommand = v.InferOutput<typeof commandSchema>;
export type LidarrTag = v.InferOutput<typeof tagSchema>;
export type LidarrQualityProfile = v.InferOutput<typeof qualityProfileSchema>;
export type LidarrAlbumTypeOption = v.InferOutput<typeof albumTypeOptionSchema>;
export type LidarrMetadataProfile = v.InferOutput<typeof metadataProfileSchema>;
export type LidarrCustomFormat = v.InferOutput<typeof customFormatSchema>;
export type LidarrReleaseProfile = v.InferOutput<typeof releaseProfileSchema>;
export type LidarrQualityDefinition = v.InferOutput<typeof qualityDefinitionSchema>;
export type LidarrNamingConfig = v.InferOutput<typeof namingConfigSchema>;
type LidarrRootFolderResource = v.InferOutput<typeof rootFolderSchema>;

export type LidarrRootFolder = { path: string };

type LidarrParse<T> = (data: unknown, endpoint: string) => T;

const unreadable = (endpoint: string, reason: string) =>
  new Error(`Lidarr sent ${endpoint.split("?")[0]} data Aurral can't read: ${reason}`);

const one =
  <Schema extends v.GenericSchema>(schema: Schema): LidarrParse<v.InferOutput<Schema>> =>
  (data, endpoint) => {
    const result = v.safeParse(schema, data);
    if (!result.success) throw unreadable(endpoint, v.summarize(result.issues));
    return result.output;
  };

const many =
  <Schema extends v.GenericSchema>(schema: Schema): LidarrParse<v.InferOutput<Schema>[]> =>
  (data, endpoint) => {
    const records = Array.isArray(data) ? data : readResponseField(data, "records");
    if (!Array.isArray(records)) throw unreadable(endpoint, "expected a list");
    const items: v.InferOutput<Schema>[] = [];
    let skipped = 0;
    let issue = "";
    for (const record of records) {
      const result = v.safeParse(schema, record);
      if (result.success) {
        items.push(result.output);
      } else {
        skipped += 1;
        issue ||= v.summarize(result.issues);
      }
    }
    if (skipped > 0) {
      logger.warn("library", "Skipped Lidarr records Aurral can't read", {
        endpoint: endpoint.split("?")[0],
        skipped,
        issue,
      });
    }
    return items;
  };

type LidarrError = Error & {
  statusCode?: number;
  field?: string;
  code?: string;
  response?: unknown;
};

interface LidarrRequestOptions {
  forceRefresh?: boolean;
  bypassCircuit?: boolean;
}

type LidarrParseOptions = LidarrRequestOptions & { parse?: LidarrParse<unknown> };

type LidarrAlbumListOptions = LidarrRequestOptions & { artistIds?: Array<number | string> };

interface LidarrRequestFailure {
  code?: string;
  message?: unknown;
  request?: unknown;
  response?: {
    status?: number;
    statusText?: string;
    data?: unknown;
    headers?: unknown;
  };
}

interface LidarrCacheEntry {
  data: unknown;
  at: number;
}

interface LidarrConfig {
  url: string;
  apiKey: string;
  rootFolderPath: string | null;
  rootFolderPaths: Array<string | null>;
  insecure: boolean;
  timeoutMs: number;
  circuitDisabled: boolean;
  enabled?: boolean;
}

interface LidarrCircuitProbe {
  promise: Promise<boolean>;
  resolve: (recovered: boolean) => void;
}

interface LidarrAddRequest {
  albumOnly?: boolean;
  albumMbid?: string | null;
  triggerSearch?: boolean;
  monitorOption?: string | null;
  monitor?: string | null;
  rootFolderPath?: string | null;
  qualityProfileId?: number | string | null;
  savedRootFolderPath?: string | null;
  savedQualityProfileId?: number | string | null;
  tagId?: number | string | null;
  metadataProfileId?: number | string | null;
}

interface LidarrArtistAddConfigurationOptions {
  rootFolders?: LidarrRootFolderResource[] | null;
  qualityProfiles?: LidarrQualityProfile[] | null;
  settings?: AppSettings;
  requestRootFolderPath?: string | null;
  requestQualityProfileId?: number | string | null;
  savedRootFolderPath?: string | null;
  savedQualityProfileId?: number | string | null;
}

export function normalizeLidarrUrl(value: unknown) {
  return String(value || "").replace(/\/+$/, "");
}

export function normalizeLidarrApiKey(value: unknown) {
  return String(value || "").trim();
}

function normalizeRootFolderPath(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeRootFolderPaths(values: unknown) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(normalizeRootFolderPath)
        .filter(Boolean) as string[],
    ),
  ];
}

function normalizeProfileId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeLidarrArtistId(value: unknown): string | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function normalizeLidarrArtistIds(values: unknown) {
  return [
    ...new Set((Array.isArray(values) ? values : []).map(normalizeLidarrArtistId).filter(Boolean)),
  ];
}

function normalizeLidarrTrackFileIds(values: unknown) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => {
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
        })
        .filter(Boolean),
    ),
  ];
}

function readResponseField(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}

function isMetadataProviderIdError(error: unknown) {
  const message = String(asAppError(error)?.message || "").toLowerCase();
  return message.includes("input string") && message.includes("correct format");
}

function normalizeMonitorOption(value: unknown) {
  const option = String(value || "none").trim();
  return VALID_MONITOR_OPTIONS.has(option) ? option : "none";
}

function getArtistMonitoringPayload(
  monitorOption: unknown,
  { forceArtistMonitored = true }: { forceArtistMonitored?: boolean } = {},
) {
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

function mapTags(tags: LidarrTag[] | null | undefined) {
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
          id: normalizeProfileId(tag.id)!,
          label: tag.label!.trim(),
        }))
    : [];
}

function createPreferenceError(
  statusCode: number,
  field: string,
  message: string,
  code: string,
): LidarrError {
  const error: LidarrError = new Error(message);
  error.statusCode = statusCode;
  error.field = field;
  error.code = code;
  return error;
}

function mapRootFolders(rootFolders: LidarrRootFolderResource[] | null | undefined) {
  return Array.isArray(rootFolders)
    ? rootFolders
        .filter((item) => normalizeRootFolderPath(item?.path))
        .map((item) => ({
          ...item,
          path: normalizeRootFolderPath(item.path)!,
        }))
    : [];
}

function mapQualityProfiles(qualityProfiles: LidarrQualityProfile[] | null | undefined) {
  return Array.isArray(qualityProfiles)
    ? qualityProfiles
        .filter((profile) => normalizeProfileId(profile?.id) !== null)
        .map((profile) => ({
          ...profile,
          id: normalizeProfileId(profile.id)!,
        }))
    : [];
}

function findRootFolder<T extends { path?: string | null }>(
  rootFolders: T[],
  rootFolderPath: unknown,
) {
  const normalizedPath = normalizeRootFolderPath(rootFolderPath);
  if (!normalizedPath) return null;
  return (
    rootFolders.find((folder) => normalizeRootFolderPath(folder?.path) === normalizedPath) || null
  );
}

function findQualityProfile<T extends { id: number | null }>(
  qualityProfiles: T[],
  qualityProfileId: unknown,
) {
  const normalizedId = normalizeProfileId(qualityProfileId);
  if (normalizedId === null) return null;
  return (
    qualityProfiles.find((profile) => normalizeProfileId(profile?.id) === normalizedId) || null
  );
}

export class LidarrClient {
  declare _persistRootFolderPaths: boolean;
  declare config: LidarrConfig;
  declare apiPath: string;
  declare _holdConfig?: boolean;
  declare _circuitOpen: boolean;
  declare _circuitOpenedAt: number;
  declare _circuitFailures: number;
  declare _lastCircuitFailureAt: number;
  declare _circuitProbe: LidarrCircuitProbe | null;
  declare _concurrent: number;
  declare _waitQueue: Array<(value: void) => void>;
  declare _artistListCache: LidarrCacheEntry | null;
  declare _artistByMbidCache: Map<string, { artist: LidarrArtist | null; at: number }>;
  declare _artistByMbidInflight: Map<string, Promise<LidarrArtist | null>>;
  declare _albumCache: Map<string, LidarrCacheEntry>;
  declare _albumMbidIndex: { source: LidarrAlbum[]; map: Map<string, LidarrAlbum> } | null;
  declare _statusCache: Map<string, LidarrCacheEntry>;
  declare _rootFoldersCache: { data: LidarrRootFolder[]; at: number } | null;
  declare _inflightGets: Map<string, Promise<unknown>>;
  declare _httpAgent: http.Agent;
  declare _httpsAgent: https.Agent;
  declare _httpsInsecureAgent: https.Agent;

  constructor({ persistRootFolderPaths = true }: { persistRootFolderPaths?: boolean } = {}) {
    this._persistRootFolderPaths = persistRootFolderPaths;
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
    this._rootFoldersCache = null;
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

  _setArtistByMbidCacheEntry(mbid: string, artist: LidarrArtist | null | undefined) {
    const normalizedMbid = String(mbid || "").trim();
    if (!normalizedMbid) return;
    this._artistByMbidCache.set(normalizedMbid, {
      artist: artist || null,
      at: Date.now(),
    });
  }

  _getArtistByMbidCacheEntry(mbid: string) {
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

  _populateArtistIndexes(artists: LidarrArtist[]) {
    for (const artist of artists) {
      const mbid = String(artist.foreignArtistId || "").trim();
      if (mbid) this._setArtistByMbidCacheEntry(mbid, artist);
    }
  }

  _invalidateArtistIndexes() {
    this._artistByMbidCache.clear();
    this._artistByMbidInflight.clear();
  }

  _acquireSlot(): Promise<void> {
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
    const deferred = Promise.withResolvers<boolean>();
    this._circuitProbe = {
      promise: deferred.promise,
      resolve: deferred.resolve,
    };
    return this._circuitProbe;
  }

  _finishCircuitProbe(probe: LidarrCircuitProbe | null, recovered: boolean) {
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

  _staleGetCache(method: LidarrHttpMethod, endpoint: string): unknown {
    if (method !== "GET") return null;
    if (endpoint === "/artist" && this._artistListCache) {
      return this._artistListCache.data;
    }
    if (endpoint === "/rootFolder" && this._rootFoldersCache) {
      return this._rootFoldersCache.data;
    }
    if (endpoint === "/album" || endpoint.startsWith("/album?")) {
      const cached = this._albumCache.get(endpoint);
      if (cached) return cached.data;
    }
    if (isQueueEndpoint(endpoint) || endpoint === "/command" || endpoint.startsWith("/history")) {
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

    url = normalizeLidarrUrl(url);

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
      apiKey: normalizeLidarrApiKey(dbConfig.apiKey || process.env.LIDARR_API_KEY || ""),
      rootFolderPath: normalizeRootFolderPath(dbConfig.rootFolderPath),
      rootFolderPaths: normalizeRootFolderPaths(dbConfig.rootFolderPaths),
      insecure: !!insecure,
      timeoutMs,
      circuitDisabled,
      enabled: dbConfig.enabled !== false,
    };

    const didConfigChange =
      !previousConfig ||
      previousConfig.url !== newConfig.url ||
      previousConfig.apiKey !== newConfig.apiKey ||
      previousConfig.rootFolderPath !== newConfig.rootFolderPath ||
      JSON.stringify(previousConfig.rootFolderPaths) !==
        JSON.stringify(newConfig.rootFolderPaths) ||
      previousConfig.insecure !== newConfig.insecure ||
      previousConfig.timeoutMs !== newConfig.timeoutMs ||
      previousConfig.circuitDisabled !== newConfig.circuitDisabled ||
      previousConfig.enabled !== newConfig.enabled;

    this.config = newConfig;
    if (didConfigChange) {
      this._artistListCache = null;
      this._invalidateArtistIndexes();
      this._albumCache = new BoundedMap(LIDARR_ARTIST_ALBUM_CACHE_MAX);
      this._statusCache.clear();
      this._rootFoldersCache = null;
    }
  }

  getConfig() {
    this.updateConfig();
    return this.config;
  }

  isEnabled() {
    this.updateConfig();
    return this.config?.enabled !== false;
  }

  isConfigured(skipConfigUpdate = false) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }
    if (this.config?.enabled === false) {
      return false;
    }
    return !!this.config?.apiKey?.trim();
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.config.apiKey) {
      return {};
    }
    return {
      "X-Api-Key": this.config.apiKey.trim(),
    };
  }

  request<T>(
    endpoint: string,
    method: LidarrHttpMethod,
    data: unknown,
    skipConfigUpdate: boolean,
    options: LidarrRequestOptions & { parse: LidarrParse<T> },
  ): Promise<T>;
  request(
    endpoint: string,
    method?: LidarrHttpMethod,
    data?: unknown,
    skipConfigUpdate?: boolean,
    options?: LidarrRequestOptions,
  ): Promise<unknown>;
  async request(
    endpoint: string,
    method: LidarrHttpMethod = "GET",
    data: unknown = null,
    skipConfigUpdate = false,
    options: LidarrParseOptions = {},
  ) {
    const shouldDedupeGet =
      endpoint === "/artist" ||
      endpoint === "/rootFolder" ||
      endpoint.startsWith("/album") ||
      isQueueEndpoint(endpoint) ||
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

  async _request(
    endpoint: string,
    method: LidarrHttpMethod = "GET",
    data: unknown = null,
    skipConfigUpdate = false,
    options: LidarrParseOptions = {},
  ): Promise<unknown> {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }

    if (!this.isConfigured(skipConfigUpdate)) {
      if (this.config?.enabled === false) {
        throw new Error("Lidarr is disabled");
      }
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
      (isQueueEndpoint(endpoint) || endpoint === "/command" || endpoint.startsWith("/history"));
    if (isStatusRequest && !options.forceRefresh) {
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

          const requestConfig: LidarrAxiosConfig & { httpAgent: http.Agent } = {
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

          const body = options.parse ? options.parse(response.data, endpoint) : response.data;

          if (method === "GET" && endpoint === "/artist") {
            this._artistListCache = { data: body, at: Date.now() };
          }
          if (method === "GET" && (endpoint === "/album" || endpoint.startsWith("/album?"))) {
            if (this._albumCache.size >= LIDARR_ARTIST_ALBUM_CACHE_MAX) {
              const oldestKey = this._albumCache.keys().next().value;
              this._albumCache.delete(oldestKey!);
            }
            this._albumCache.set(endpoint, { data: body, at: Date.now() });
          }
          if (isStatusRequest) {
            this._statusCache.set(endpoint, {
              data: body,
              at: Date.now(),
            });
          }

          this._resetCircuitState();
          this._finishCircuitProbe(circuitProbe, true);
          return body;
        } finally {
          this._releaseSlot();
        }
      } catch (raw) {
        const error: LidarrRequestFailure = raw && typeof raw === "object" ? raw : {};
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

          const isMissingResource =
            status === 404 && method === "GET" && /^\/(?:artist|album)\/\d+$/.test(endpoint);
          if (!isMissingResource) {
            console.error(`Lidarr API error (${status}):`, {
              url: `${this.config.url}${this.apiPath}${endpoint}`,
              method: method,
              status: status,
              statusText: statusText,
              responseData: responseData,
              responseHeaders: error.response.headers,
            });
          }

          let errorMsg: unknown = statusText || "Unknown error";
          let errorDetails = "";

          if (typeof responseData === "string") {
            errorMsg = responseData;
            errorDetails = responseData;
          } else if (responseData) {
            errorMsg =
              readResponseField(responseData, "message") ||
              readResponseField(responseData, "error") ||
              readResponseField(responseData, "title") ||
              readResponseField(responseData, "detail") ||
              (typeof responseData === "object"
                ? JSON.stringify(responseData)
                : String(responseData));
            errorDetails = JSON.stringify(responseData, null, 2);
          }

          const responseText = typeof responseData === "string" ? responseData : errorMsg;
          const responseTextLower =
            typeof responseText === "string" ? responseText.toLowerCase() : undefined;
          const isLidarrSkyhookRefused =
            status !== undefined &&
            status >= 500 &&
            responseTextLower &&
            responseTextLower.includes("api.lidarr.audio") &&
            (responseTextLower.includes("connection refused") ||
              responseTextLower.includes("connect") ||
              responseTextLower.includes("econnrefused"));
          if (isLidarrSkyhookRefused) {
            const userError: LidarrError = new Error(
              "Lidarr cannot reach api.lidarr.audio from its container. Check Lidarr outbound internet/DNS or proxy settings.",
            );
            userError.response = error.response;
            throw userError;
          }
          if (status === 400) {
            const userError: LidarrError = new Error(
              `Lidarr API returned 400 Bad Request: ${errorMsg}${
                errorDetails ? `\n\nFull Response: ${errorDetails}` : ""
              }`,
            );
            userError.response = error.response;
            throw userError;
          }
          if (status === 401) {
            const userError: LidarrError = new Error(
              `Lidarr API authentication failed. Check your API key.`,
            );
            userError.response = error.response;
            throw userError;
          }
          if (status === 404) {
            if (isMissingResource) {
              return null;
            }
            const userError: LidarrError = new Error(
              `Lidarr endpoint not found: ${endpoint}. Check if Lidarr is running and the API version is correct.`,
            );
            userError.response = error.response;
            throw userError;
          }
          const userError: LidarrError = new Error(
            `Lidarr API error: ${status} - ${
              readResponseField(responseData, "message") ||
              readResponseField(responseData, "error") ||
              statusText ||
              "Unknown error"
            }`,
          );
          userError.response = error.response;
          throw userError;
        } else if (error.request) {
          logger.error("library", "Lidarr API request failed with no response", {
            endpoint: endpoint.split("?")[0],
            method,
            message: msg,
            code: error.code || null,
            timeoutMs: this.config.timeoutMs,
          });
          throw new Error(
            `Lidarr request failed with no response: ${method} ${endpoint.split("?")[0]}: ${msg}`,
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
        parse: one(systemStatusSchema),
      });
      return {
        connected: true,
        version: status.version || "unknown",
        instanceName: status.instanceName || "Lidarr",
        apiPath: this.apiPath,
      };
    } catch (error) {
      const failure = asAppError(error);
      const errorMessage = failure?.message || "Unknown error";
      const errorDetails = failure?.response?.data
        ? typeof failure.response.data === "string"
          ? failure.response.data
          : JSON.stringify(failure.response.data, null, 2)
        : "";

      return {
        connected: false,
        error: errorMessage,
        details: errorDetails,
        url: this.config.url,
        fullUrl: `${this.config.url}${this.apiPath}/system/status`,
        statusCode: failure?.response?.status,
        apiPath: this.apiPath,
        responseHeaders: failure?.response?.headers,
      };
    }
  }

  getConfiguredRootFolderPaths() {
    this.updateConfig();
    return normalizeRootFolderPaths([
      ...(Array.isArray(this.config.rootFolderPaths) ? this.config.rootFolderPaths : []),
      this.config.rootFolderPath,
    ]);
  }

  async getRootFolders({ forceRefresh = false }: { forceRefresh?: boolean } = {}) {
    this.updateConfig();
    if (!forceRefresh && this._rootFoldersCache) return this._rootFoldersCache.data;
    const configured = this.getConfiguredRootFolderPaths();
    if (!forceRefresh && configured.length > 0) {
      const folders = configured.map((path) => ({ path }));
      this._rootFoldersCache = { data: folders, at: Date.now() };
      return folders;
    }
    const folders = mapRootFolders(
      await this.request("/rootFolder", "GET", null, false, {
        forceRefresh,
        parse: many(rootFolderSchema),
      }),
    );
    this._rootFoldersCache = { data: folders, at: Date.now() };
    const paths = folders.map((folder) => folder.path);
    this.config.rootFolderPaths = this._persistRootFolderPaths
      ? dbOps.setLidarrRootFolderPaths(paths)
      : paths;
    return folders;
  }

  async getTags(skipConfigUpdate = false) {
    return this.request("/tag", "GET", null, skipConfigUpdate, { parse: many(tagSchema) });
  }

  getArtistAddFallbacks({
    rootFolders,
    qualityProfiles,
    settings,
  }: {
    rootFolders?: LidarrRootFolderResource[] | null;
    qualityProfiles?: LidarrQualityProfile[] | null;
    settings?: AppSettings;
  } = {}) {
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

  async getArtistAddPreferenceSummary(
    user: Pick<UserRecord, "lidarrRootFolderPath" | "lidarrQualityProfileId"> | null = null,
  ) {
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

  async resolveArtistAddConfiguration(options: LidarrArtistAddConfigurationOptions = {}) {
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

  async addArtist(mbid: string, artistName: string, options: LidarrAddRequest = {}) {
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
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const albumMbid = String(options.albumMbid || "").trim();
    const albumsToMonitor = albumOnly && albumMbid ? [albumMbid] : [];
    // Lidarr disables the artist for "none", even with explicit albumsToMonitor.
    // The explicit album list takes precedence over "missing", so other albums stay unmonitored.
    const monitoring = getArtistMonitoringPayload(
      albumsToMonitor.length > 0 && requestedMonitorOption === "none"
        ? "missing"
        : requestedMonitorOption,
    );

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
          .map((name) =>
            String(name || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      );
      if (!canonicalName || !acceptedArtistNames.has(normalizedArtistName)) {
        const error: LidarrError = new Error(
          `MusicBrainz artist name for ${mbid} does not match the requested artist name`,
        );
        error.code = "LIDARR_ARTIST_IDENTITY_MISMATCH";
        throw error;
      }

      const lookup = await this.request(
        `/artist/lookup?term=${encodeURIComponent(canonicalName)}`,
        "GET",
        null,
        false,
        { parse: many(artistLookupSchema) },
      );
      const canonicalProviderIds = new Set(
        (Array.isArray(identity?.providerIds) ? identity.providerIds : []).map((providerId) =>
          String(providerId || "")
            .trim()
            .toLowerCase(),
        ),
      );
      const lookupProviderIds = [];
      const lookupProviderSuffixes = new Set();
      let hasCanonicalLookupMatch = false;
      for (const candidate of Array.isArray(lookup) ? lookup : []) {
        const providerId = String(candidate?.foreignArtistId || "").trim();
        if (
          providerId &&
          String(candidate?.artistName || "")
            .trim()
            .toLowerCase() === canonicalName.toLowerCase()
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
          const normalizedProviderId = String(providerId || "")
            .trim()
            .toLowerCase();
          const providerSuffix = normalizedProviderId.split("@").pop();
          return (
            normalizedProviderId &&
            (lookupProviderSuffixes.size === 0 || lookupProviderSuffixes.has(providerSuffix))
          );
        },
      );
    };

    const resolveAddedArtist = async (artist: LidarrArtistLookup) => {
      const foreignArtistId = String(artist.foreignArtistId || "").trim();
      if (
        v.is(artistSchema, artist) &&
        normalizeLidarrArtistId(artist.id) &&
        foreignArtistId === mbid
      ) {
        return artist;
      }
      const lookupId = foreignArtistId || mbid;
      let resolvedArtist = await this.getArtistByMbid(lookupId);
      if (!normalizeLidarrArtistId(resolvedArtist?.id)) {
        resolvedArtist = await this.getArtistByMbid(lookupId, { forceRefresh: true });
      }
      if (!normalizeLidarrArtistId(resolvedArtist?.id)) {
        throw new Error(`Lidarr add did not return a numeric artist ID for ${mbid}`);
      }
      return resolvedArtist!;
    };

    const ensureArtistMonitored = async (artist: LidarrArtist) => {
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

    const postArtist = async (payload: typeof lidarrArtist) => {
      try {
        return await this.request("/artist", "POST", payload, false, {
          parse: one(artistLookupSchema),
        });
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
        return this.request("/artist", "POST", fallbackArtist, false, {
          parse: one(artistLookupSchema),
        });
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
            const mappingFailure = asAppError(mappingError);
            if (mappingFailure?.code !== "LIDARR_ARTIST_ID_CONFLICT") {
              throw mappingError;
            }
            logger.warn("library", "Failed to persist Lidarr artist ID mapping", {
              mbid,
              providerArtistId,
              error: mappingFailure.message,
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

  async resolveCanonicalArtistIdentity(mbid: string) {
    return musicbrainzGetArtistIdentityByMbid(mbid);
  }

  async getArtist(artistId: number | string) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    return this.request(`/artist/${normalizedArtistId}`, "GET", null, false, {
      parse: one(v.nullable(artistSchema)),
    });
  }

  async getArtists(options: LidarrRequestOptions = {}) {
    const artists = await this.request("/artist", "GET", null, false, {
      ...options,
      parse: many(artistSchema),
    });
    this._populateArtistIndexes(artists);
    return artists;
  }

  async getArtistByMbid(mbid: string, { forceRefresh = false }: LidarrRequestOptions = {}) {
    const normalizedMbid = String(mbid || "").trim();
    if (!normalizedMbid) return null;
    const mappedLidarrArtistId = dbOps.getLidarrArtistIdMap(normalizedMbid);

    const matchesArtistId = (artist: LidarrArtist) =>
      artist.foreignArtistId === normalizedMbid ||
      (mappedLidarrArtistId && artist.foreignArtistId === mappedLidarrArtistId);

    if (forceRefresh) {
      this._artistByMbidCache.delete(normalizedMbid);
    } else {
      const cachedArtist = this._getArtistByMbidCacheEntry(normalizedMbid);
      if (cachedArtist !== undefined) {
        return cachedArtist;
      }
      const inflight = this._artistByMbidInflight.get(normalizedMbid);
      if (inflight) {
        return inflight;
      }
    }

    const startedAt = Date.now();
    const requestPromise = this.getArtists({ forceRefresh })
      .then((artists) => {
        const artist = artists.find(matchesArtistId) || null;
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

  async updateArtist(artistId: number | string, updates: Partial<LidarrArtist>) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    const artist = await this.getArtist(normalizedArtistId);
    if (!artist) {
      throw new Error(`Artist with ID ${normalizedArtistId} not found in Lidarr`);
    }

    const updated = {
      ...artist,
      ...updates,
    };

    return this.request(`/artist/${normalizedArtistId}`, "PUT", updated, false, {
      parse: one(artistSchema),
    });
  }

  async updateArtistMonitoring(
    artistId: number | string,
    monitorOption: string | null | undefined,
  ) {
    const normalizedArtistId = normalizeLidarrArtistId(artistId);
    if (!normalizedArtistId) {
      throw new Error(`Lidarr artist ID must be numeric: ${artistId}`);
    }
    const artist = await this.getArtist(normalizedArtistId);
    if (!artist) {
      throw new Error(`Artist with ID ${normalizedArtistId} not found in Lidarr`);
    }
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
      return await this.request(`/artist/${normalizedArtistId}`, "PUT", updated, false, {
        parse: one(artistSchema),
      });
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
      return this.request(`/artist/${normalizedArtistId}`, "PUT", fallbackUpdated, false, {
        parse: one(artistSchema),
      });
    }
  }

  async addAlbum(
    artistId: number | string,
    albumMbid: string,
    albumName: string,
    options: { monitored?: boolean; triggerSearch?: boolean } = {},
  ) {
    const artist = await this.getArtist(artistId);
    if (!artist) {
      throw new Error(`Artist with ID ${artistId} not found in Lidarr`);
    }

    const effectiveArtist =
      artist.monitored === true
        ? artist
        : await this.updateArtistMonitoring(artistId, artist.addOptions?.monitor || "none");

    const lidarrAlbum = {
      title: albumName,
      foreignAlbumId: albumMbid,
      artistId: artistId,
      artist: effectiveArtist,
      monitored: options.monitored !== false,
      anyReleaseOk: true,
      images: [],
    };

    let result = await this.request("/album", "POST", lidarrAlbum, false, {
      parse: one(albumSchema),
    });

    if (options.monitored !== false && result?.id && result.monitored !== true) {
      result = await this.monitorAlbum(result.id, true);
    }

    if (options.triggerSearch === true) {
      await this.triggerAlbumSearch(result.id);
    }

    return result;
  }

  async getAlbum(albumId: number | string) {
    return this.request(`/album/${albumId}`, "GET", null, false, {
      parse: one(v.nullable(albumSchema)),
    });
  }

  async getTracksByAlbumId(albumId: number | string) {
    try {
      return await this.request(`/track?albumId=${albumId}`, "GET", null, false, {
        parse: many(trackSchema),
      });
    } catch {
      return [];
    }
  }

  async getTrackFilesByAlbumId(albumId: number | string) {
    try {
      return await this.request(`/trackfile?albumId=${albumId}`, "GET", null, false, {
        parse: many(trackFileSchema),
      });
    } catch {
      return [];
    }
  }

  async getAllTracks(
    options: LidarrRequestOptions & {
      artistIds?: Array<number | string>;
      throwOnError?: boolean;
    } = {},
  ): Promise<LidarrTrack[]> {
    const { artistIds, throwOnError = false, ...requestOptions } = options;
    try {
      const normalizedArtistIds = normalizeLidarrArtistIds(artistIds);
      if (normalizedArtistIds.length === 0) {
        throw new Error("Lidarr artist IDs are required for bulk track reads");
      }
      const results = await mapWithConcurrency(
        normalizedArtistIds,
        LIDARR_MAX_CONCURRENT,
        async (artistId: string | null) => {
          return this.request(`/track?artistId=${artistId}`, "GET", null, false, {
            ...requestOptions,
            parse: many(trackSchema),
          });
        },
        { stopOnError: true },
      );
      return results.flat();
    } catch (error) {
      if (throwOnError) throw error;
      return [];
    }
  }

  async getAllTrackFiles(
    options: LidarrRequestOptions & {
      artistIds?: Array<number | string>;
      throwOnError?: boolean;
    } = {},
  ): Promise<LidarrTrackFile[]> {
    const { artistIds, throwOnError = false, ...requestOptions } = options;
    try {
      const normalizedArtistIds = normalizeLidarrArtistIds(artistIds);
      if (normalizedArtistIds.length === 0) {
        throw new Error("Lidarr artist IDs are required for bulk track-file reads");
      }
      const results = await mapWithConcurrency(
        normalizedArtistIds,
        LIDARR_MAX_CONCURRENT,
        async (artistId: string | null) => {
          return this.request(`/trackfile?artistId=${artistId}`, "GET", null, false, {
            ...requestOptions,
            parse: many(trackFileSchema),
          });
        },
        { stopOnError: true },
      );
      return results.flat();
    } catch (error) {
      if (throwOnError) throw error;
      return [];
    }
  }

  async getTrackFilesByIds(
    trackFileIds: Array<number | string>,
    options: LidarrRequestOptions & { throwOnError?: boolean } = {},
  ): Promise<LidarrTrackFile[]> {
    const { throwOnError = false, ...requestOptions } = options;
    try {
      const normalizedTrackFileIds = normalizeLidarrTrackFileIds(trackFileIds);
      if (normalizedTrackFileIds.length === 0) return [];
      const batches = [];
      for (
        let index = 0;
        index < normalizedTrackFileIds.length;
        index += LIDARR_TRACK_FILE_ID_BATCH_SIZE
      ) {
        batches.push(normalizedTrackFileIds.slice(index, index + LIDARR_TRACK_FILE_ID_BATCH_SIZE));
      }
      const results = await mapWithConcurrency(
        batches,
        LIDARR_MAX_CONCURRENT,
        async (batch: Array<string | null>) => {
          const query = batch
            .map((trackFileId: string | null) => `trackFileIds=${encodeURIComponent(trackFileId!)}`)
            .join("&");
          return this.request(`/trackfile?${query}`, "GET", null, false, {
            ...requestOptions,
            parse: many(trackFileSchema),
          });
        },
      );
      return results.flat();
    } catch (error) {
      if (throwOnError) throw error;
      return [];
    }
  }

  async getAllAlbums(options: LidarrAlbumListOptions = {}): Promise<LidarrAlbum[]> {
    const { artistIds, ...requestOptions } = options;
    if (Array.isArray(artistIds)) {
      const normalizedArtistIds = normalizeLidarrArtistIds(artistIds);
      if (normalizedArtistIds.length === 0) return [];
      const results = await mapWithConcurrency(
        normalizedArtistIds,
        LIDARR_MAX_CONCURRENT,
        async (artistId: string | null) => {
          return this.request(`/album?artistId=${artistId}`, "GET", null, false, {
            ...requestOptions,
            parse: many(albumSchema),
          });
        },
        { stopOnError: true },
      );
      return results.flat();
    }
    return this.request("/album", "GET", null, false, {
      ...requestOptions,
      parse: many(albumSchema),
    });
  }

  async getAlbumMbidIndex(options: LidarrAlbumListOptions = {}) {
    const albums = await this.getAllAlbums(options);
    if (!options.forceRefresh && this._albumMbidIndex && this._albumMbidIndex.source === albums) {
      return this._albumMbidIndex.map;
    }
    const map = new Map<string, LidarrAlbum>();
    for (const album of albums) {
      const mbid = String(album?.foreignAlbumId || "").trim();
      if (mbid) map.set(mbid, album);
    }
    this._albumMbidIndex = { source: albums, map };
    return map;
  }

  async getAlbumByMbid(albumMbid: string, options: LidarrRequestOptions = {}) {
    const normalizedMbid = String(albumMbid || "").trim();
    if (!normalizedMbid) return undefined;
    const normalizedMbidKey = normalizedMbid.toLowerCase();

    const albums = await this.request(
      `/album?foreignAlbumId=${encodeURIComponent(normalizedMbid)}`,
      "GET",
      null,
      false,
      { ...options, parse: many(albumSchema) },
    );
    return albums.find((album) => album.foreignAlbumId.trim().toLowerCase() === normalizedMbidKey);
  }

  async getAlbumsByMbidsSettled(albumMbids: string[], options: LidarrRequestOptions = {}) {
    return mapWithConcurrency(
      albumMbids,
      LIDARR_ALBUM_LOOKUP_CONCURRENCY,
      async (albumMbid: string): Promise<PromiseSettledResult<LidarrAlbum | undefined>> => {
        try {
          return { status: "fulfilled", value: await this.getAlbumByMbid(albumMbid, options) };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      },
    );
  }

  async updateAlbum(albumId: number | string, updates: Partial<LidarrAlbum>) {
    const album = await this.getAlbum(albumId);
    if (!album) {
      throw new Error(`Album with ID ${albumId} not found in Lidarr`);
    }

    const updated = {
      ...album,
      ...updates,
    };

    return this.request(`/album/${albumId}`, "PUT", updated, false, { parse: one(albumSchema) });
  }

  async monitorAlbum(albumId: number | string, monitored = true) {
    return this.updateAlbum(albumId, { monitored });
  }

  async triggerAlbumSearch(albumId: number) {
    const command = await this.request(
      "/command",
      "POST",
      { name: "AlbumSearch", albumIds: [albumId] },
      false,
      { parse: one(commandSchema) },
    );
    logger.info("library", "Triggered Lidarr album search", {
      albumId,
      commandId: command?.id ?? null,
      commandStatus: command?.status ?? null,
    });
    return command;
  }

  async triggerArtistSearch(artistId: number) {
    return this.request(
      "/command",
      "POST",
      { name: "ArtistSearch", artistIds: [artistId] },
      false,
      { parse: one(commandSchema) },
    );
  }

  async getQueue(options: LidarrRequestOptions = {}) {
    return this.request(QUEUE_ENDPOINT, "GET", null, false, {
      ...options,
      parse: many(queueItemSchema),
    });
  }

  async getQueueItem(queueId: number | string) {
    return this.request(`/queue/${queueId}`, "GET", null, false, { parse: one(queueItemSchema) });
  }

  async getCommands(options: LidarrRequestOptions = {}) {
    return this.request("/command", "GET", null, false, {
      ...options,
      parse: many(commandSchema),
    });
  }

  async getHistory(
    page = 1,
    pageSize = 20,
    sortKey = "date",
    sortDirection = "descending",
    options: LidarrRequestOptions = {},
  ): Promise<LidarrPage<LidarrHistoryItem>> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
      sortKey,
      sortDirection,
      includeArtist: "true",
      includeAlbum: "true",
    });
    const records = await this.request(`/history?${params.toString()}`, "GET", null, false, {
      ...options,
      parse: many(historyItemSchema),
    });
    return { records };
  }

  async getHistoryForAlbum(albumId: number) {
    const history = await this.getHistory(1, 100);
    return history.records?.filter((h) => h.albumId === albumId) || [];
  }

  async getHistoryForArtist(artistId: number) {
    const history = await this.getHistory(1, 100);
    return history.records?.filter((h) => h.artistId === artistId) || [];
  }

  async deleteArtist(artistId: number | string, deleteFiles = false) {
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

  async deleteAlbum(albumId: number | string, deleteFiles = false) {
    const params = new URLSearchParams();
    if (deleteFiles) {
      params.append("deleteFiles", "true");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/album/${albumId}${query}`, "DELETE");
  }

  async deleteTrackFile(trackFileId: number | string) {
    const result = await this.request(`/trackfile/${trackFileId}`, "DELETE");
    this._albumCache.clear();
    return result;
  }

  async getQualityProfiles(skipConfigUpdate = false) {
    return this.request("/qualityprofile", "GET", null, skipConfigUpdate, {
      parse: many(qualityProfileSchema),
    });
  }

  async getMetadataProfiles(skipConfigUpdate = false) {
    return this.request("/metadataprofile", "GET", null, skipConfigUpdate, {
      parse: many(metadataProfileSchema),
    });
  }

  async createMetadataProfile(profileData: unknown, skipConfigUpdate = false) {
    return this.request("/metadataprofile", "POST", profileData, skipConfigUpdate, {
      parse: one(metadataProfileSchema),
    });
  }

  async updateMetadataProfile(profileId: number, profileData: unknown, skipConfigUpdate = false) {
    return this.request(`/metadataprofile/${profileId}`, "PUT", profileData, skipConfigUpdate, {
      parse: one(metadataProfileSchema),
    });
  }

  async getQualityProfile(profileId: number, skipConfigUpdate = false) {
    return this.request(`/qualityprofile/${profileId}`, "GET", null, skipConfigUpdate, {
      parse: one(qualityProfileSchema),
    });
  }

  async createQualityProfile(profileData: unknown, skipConfigUpdate = false) {
    return this.request("/qualityprofile", "POST", profileData, skipConfigUpdate, {
      parse: one(qualityProfileSchema),
    });
  }

  async updateQualityProfile(profileId: number, profileData: unknown, skipConfigUpdate = false) {
    return this.request(`/qualityprofile/${profileId}`, "PUT", profileData, skipConfigUpdate, {
      parse: one(qualityProfileSchema),
    });
  }

  async getCustomFormats(skipConfigUpdate = false) {
    return this.request("/customformat", "GET", null, skipConfigUpdate, {
      parse: many(customFormatSchema),
    });
  }

  async createCustomFormat(formatData: unknown, skipConfigUpdate = false) {
    return this.request("/customformat", "POST", formatData, skipConfigUpdate, {
      parse: one(customFormatSchema),
    });
  }

  async getNamingConfig(skipConfigUpdate = false) {
    return this.request("/config/naming", "GET", null, skipConfigUpdate, {
      parse: one(namingConfigSchema),
    });
  }

  async updateNamingConfig(configData: unknown, skipConfigUpdate = false) {
    return this.request("/config/naming", "PUT", configData, skipConfigUpdate);
  }

  async getReleaseProfiles(skipConfigUpdate = false) {
    return this.request("/releaseprofile", "GET", null, skipConfigUpdate, {
      parse: many(releaseProfileSchema),
    });
  }

  async createReleaseProfile(profileData: unknown, skipConfigUpdate = false) {
    return this.request("/releaseprofile", "POST", profileData, skipConfigUpdate, {
      parse: one(releaseProfileSchema),
    });
  }

  async updateReleaseProfile(profileId: number, profileData: unknown, skipConfigUpdate = false) {
    return this.request(`/releaseprofile/${profileId}`, "PUT", profileData, skipConfigUpdate, {
      parse: one(releaseProfileSchema),
    });
  }

  async getQualityDefinitions(skipConfigUpdate = false) {
    return this.request("/qualitydefinition", "GET", null, skipConfigUpdate, {
      parse: many(qualityDefinitionSchema),
    });
  }

  async updateQualityDefinition(id: number, data: unknown, skipConfigUpdate = false) {
    return this.request(`/qualitydefinition/${id}`, "PUT", data, skipConfigUpdate);
  }
}

export const lidarrClient = new LidarrClient();
