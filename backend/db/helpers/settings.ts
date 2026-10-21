import crypto from "crypto";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptIntegrations, encryptIntegrations } from "../../config/encryption.ts";
import { normalizePathMappings, syncPathMappings } from "../../services/pathMappings.ts";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../../services/downloadFolderConfig.ts";
import { normalizeExistingFileMode } from "../../services/downloadJobs/fileReuseMode.ts";
import { normalizeDateTimeFormat } from "../../config/constants.ts";
import {
  normalizeIntervalDays,
  normalizeQualityProfile,
} from "../../services/qualityProfileModel.ts";
import type { SettingsRow } from "../rows.ts";
import type { CacheOps } from "./cache.ts";
import type { DiscoveryCacheOps } from "./discovery.ts";
import type { ArtistOverrideOps } from "./overrides.ts";
import type { LidarrArtistIdMapOps } from "./lidarr.ts";
import type { AurralHistoryOps } from "./history.ts";
import type { InboxOps } from "./inbox.ts";

interface LidarrIntegration {
  url: string;
  externalUrl: string;
  apiKey: string;
  rootFolderPath: string | null;
  rootFolderPaths: string[];
  qualityProfileId: number | null;
  metadataProfileId: number | null;
  tagId: number | null;
  defaultMonitorOption: string;
  searchOnAdd: boolean;
  enabled?: boolean;
  insecure?: boolean;
}

interface NavidromeIntegration {
  url: string;
  username: string;
  password: string;
  prefixOwnerUsername: boolean;
  m3uPathMode?: unknown;
  pathMappings?: unknown;
}

interface PlexIntegration {
  url: string;
  token: string;
  clientId: string;
  machineIdentifier: string;
  downloadsPath: string;
  plexUsername: string;
  mainLibrarySectionId: string;
  loginEnabled?: boolean;
  configuredByUserId?: number;
}

interface LastfmIntegration {
  apiKey: string;
  apiSecret: string;
  discoveryPeriod: string;
  discoveryAutoRefreshHours: number;
  discoveryRecommendationsPerRefresh: number;
  discoveryMode: string;
}

interface SlskdIntegration {
  enabled: boolean;
  url: string;
  apiKey: string;
  priority: number;
  preferredFormat: string;
  preferredFormatStrict: boolean;
  cleanupAfterRuns?: boolean;
}

interface ProwlarrIntegration {
  enabled: boolean;
  url: string;
  apiKey: string;
  indexers: Record<string, unknown>;
  categories: number[];
  maxResults: number;
}

interface NzbgetIntegration {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  category: string;
  priority: number;
  nzbPriority: number;
  addPaused: boolean;
  completedPath: string;
  deleteLeftovers?: boolean;
}

interface SabnzbdIntegration {
  enabled: boolean;
  url: string;
  apiKey: string;
  category: string;
  priority: number;
  addPaused: boolean;
}

interface YtdlpIntegration {
  enabled: boolean;
  priority: number;
  stagingPath: string;
}

interface DeemixIntegration {
  enabled: boolean;
  url: string;
  bitrate: number;
  priority: number;
}

interface TicketmasterIntegration {
  apiKey: string;
  searchRadiusMiles: number;
  localDiscoveryIncludeRecommendations: boolean;
  localDiscoveryIncludeTrending: boolean;
}

interface NewsFeed {
  url: string;
  [field: string]: unknown;
}

interface NewsIntegration {
  enabled: boolean;
  feeds: NewsFeed[];
  groups?: Record<string, boolean>;
}

interface MetadataIntegration {
  provider: string;
  baseUrl: string;
  userAgentSuffix: string;
  enableNarrowFallbacks: boolean;
}

interface GeneralIntegration {
  authUser: string;
  authPassword: string;
  apiKey?: string;
}

interface GotifyIntegration {
  url: string;
  token: string;
  notifyDiscoveryUpdated: boolean;
  notifyWeeklyFlowDone: boolean;
  notifyRequestMade: boolean;
  notifyRequestAvailable: boolean;
}

interface JellyfinIntegration {
  url: string;
  apiKey: string;
  userId: string;
}

interface GoogleIntegration {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface WebhookTarget {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

interface WebhookEvents {
  notifyDiscoveryUpdated: boolean;
  notifyWeeklyFlowDone: boolean;
  notifyRequestMade: boolean;
  notifyRequestAvailable: boolean;
}

export interface StoredIntegrations {
  [service: string]: unknown;
  navidrome?: Partial<NavidromeIntegration>;
  plex?: Partial<PlexIntegration>;
  jellyfin?: Partial<JellyfinIntegration>;
  lastfm?: Partial<LastfmIntegration>;
  slskd?: Partial<SlskdIntegration>;
  prowlarr?: Partial<ProwlarrIntegration>;
  nzbget?: Partial<NzbgetIntegration>;
  sabnzbd?: Partial<SabnzbdIntegration>;
  ytdlp?: Partial<YtdlpIntegration>;
  deemix?: Partial<DeemixIntegration>;
  ticketmaster?: Partial<TicketmasterIntegration>;
  news?: Partial<NewsIntegration>;
  lidarr?: Partial<LidarrIntegration>;
  metadata?: Partial<MetadataIntegration>;
  general?: Partial<GeneralIntegration>;
  gotify?: Partial<GotifyIntegration>;
  google?: Partial<GoogleIntegration>;
  webhooks?: WebhookTarget[];
  webhookEvents?: Partial<WebhookEvents>;
  soulseek?: unknown;
  musicbrainz?: { email?: string; customUrl?: string };
  coverArtArchive?: unknown;
}

export interface SettingsPlaylistWorker {
  concurrency: number;
  retryCycleMinutes: number;
  retryPausedPlaylistIds: string[];
  existingFileMode: string;
}

interface SettingsPlaylistArtwork {
  style: "aurral" | "photo";
}

interface SettingsMissingTrackSearch {
  enabled: boolean;
  intervalDays: number;
}

interface SettingsInbox {
  enabled: boolean;
  releases: boolean;
  shows: boolean;
  news: boolean;
  recommendedNews: boolean;
  discoveries: boolean;
}

interface StoredSecurity {
  localNetworkBypass?: { enabled?: boolean };
  ssoOnly?: boolean;
}

interface StoredPlaylistWorker {
  concurrency?: unknown;
  retryPausedPlaylistIds?: unknown;
  existingFileMode?: unknown;
}

interface StoredPlaylistArtwork {
  style?: unknown;
}

interface StoredMissingTrackSearch {
  enabled?: unknown;
  intervalDays?: unknown;
}

interface StoredInbox {
  enabled?: boolean;
  releases?: boolean;
  shows?: boolean;
  news?: boolean;
  recommendedNews?: boolean;
  discoveries?: boolean;
}

interface StoredBlocklist {
  artists?: string[];
  tags?: string[];
}

export interface QualityProfile {
  order: string[];
  enabled: string[];
  cutoff?: string;
  automaticUpgrades: boolean;
  intervalDays: number;
}

export interface AppSettings {
  integrations: StoredIntegrations;
  quality: string;
  dateTimeFormat: string;
  qualityProfile: QualityProfile;
  queueCleaner: Record<string, unknown>;
  security: StoredSecurity;
  rootFolderPath: string | null;
  downloadFolderPath: string | null;
  pathMappings: unknown;
  releaseTypes: string[];
  flows: unknown;
  sharedPlaylists: unknown;
  subsonic: { favoriteAutoKeep: boolean };
  playlistWorker: SettingsPlaylistWorker;
  playlistArtwork: SettingsPlaylistArtwork;
  missingTrackSearch: SettingsMissingTrackSearch;
  reviewTimeoutHours: number;
  inbox: SettingsInbox;
  blocklist: StoredBlocklist;
  onboardingComplete: boolean;
}

export interface SettingsUpdate {
  integrations?: StoredIntegrations;
  quality?: string;
  dateTimeFormat?: string | null;
  qualityProfile?: unknown;
  queueCleaner?: Record<string, unknown>;
  security?: StoredSecurity;
  inbox?: StoredInbox;
  rootFolderPath?: string | null;
  downloadFolderPath?: string | null;
  pathMappings?: unknown;
  releaseTypes?: string[];
  flows?: unknown;
  sharedPlaylists?: unknown;
  subsonic?: { favoriteAutoKeep?: boolean };
  playlistWorker?: StoredPlaylistWorker;
  playlistArtwork?: StoredPlaylistArtwork;
  missingTrackSearch?: StoredMissingTrackSearch;
  reviewTimeoutHours?: number | string;
  blocklist?: StoredBlocklist;
  onboardingComplete?: boolean;
}

export interface SettingsOps {
  invalidateSettingsCache: () => void;
  getJSONSetting: <T = Partial<Record<string, unknown>>>(key: string) => T | null;
  setJSONSetting: (key: string, value: unknown) => void;
  getUserDiscoverLayout: (userId: number) => unknown;
  setUserDiscoverLayout: (userId: number, layout: unknown) => void;
  getUserTheme: (userId: number) => unknown;
  setUserTheme: (userId: number, theme: unknown) => void;
  deleteUserTheme: (userId: number) => void;
  setLidarrRootFolderPaths: (paths: unknown) => string[];
  getSettings: () => AppSettings;
  updateSettings: (settings: SettingsUpdate) => void;
}

export type DbOps = SettingsOps &
  CacheOps &
  DiscoveryCacheOps &
  ArtistOverrideOps &
  LidarrArtistIdMapOps &
  AurralHistoryOps &
  InboxOps;

const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);
const deleteSettingStmt = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");

const PLAYLIST_WORKER_RETRY_CYCLE_MINUTES = 360;

function readStoredSettingJson<T = unknown>(
  primaryKey: string,
  legacyKeys: string[] = [],
): T | null {
  const primary = dbHelpers.parseJSON(getSettingStmt.get(primaryKey)?.value);
  if (primary != null) return primary;
  for (const legacyKey of legacyKeys) {
    const legacy = dbHelpers.parseJSON(getSettingStmt.get(legacyKey)?.value);
    if (legacy != null) return legacy;
  }
  return null;
}

function normalizePlaylistArtworkSettings(
  raw: StoredPlaylistArtwork | null | undefined,
): SettingsPlaylistArtwork {
  const artwork: StoredPlaylistArtwork = raw && typeof raw === "object" ? raw : {};
  const style = String(artwork.style || "photo")
    .trim()
    .toLowerCase();
  return {
    style: style === "aurral" ? "aurral" : "photo",
  };
}

function normalizeMissingTrackSearchSettings(
  raw: StoredMissingTrackSearch | null | undefined,
): SettingsMissingTrackSearch {
  const search: StoredMissingTrackSearch = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: search.enabled === true,
    intervalDays: normalizeIntervalDays(search.intervalDays, 1),
  };
}

export const MAX_REVIEW_TIMEOUT_HOURS = 720;

// Hours a song may wait in review before it is denied; 0 waits indefinitely.
export function normalizeReviewTimeoutHours(value: unknown): number {
  const hours = Number(value);
  return Number.isInteger(hours) && hours >= 0 && hours <= MAX_REVIEW_TIMEOUT_HOURS ? hours : 0;
}

function normalizePlaylistWorkerSettings(
  raw: StoredPlaylistWorker | null | undefined,
): SettingsPlaylistWorker {
  const worker: StoredPlaylistWorker = raw && typeof raw === "object" ? raw : {};
  const parsedConcurrency = Number(worker.concurrency);
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : 2;
  const retryCycleMinutes = PLAYLIST_WORKER_RETRY_CYCLE_MINUTES;
  const retryPausedPlaylistIds = Array.isArray(worker.retryPausedPlaylistIds)
    ? [
        ...new Set(
          worker.retryPausedPlaylistIds.map((entry) => String(entry || "").trim()).filter(Boolean),
        ),
      ]
    : [];
  return {
    concurrency,
    retryCycleMinutes,
    retryPausedPlaylistIds,
    existingFileMode: normalizeExistingFileMode(worker.existingFileMode),
  };
}

function getOrCreateEncryptionKey() {
  const row = getSettingStmt.get("_encryptionKey");
  if (row?.value) {
    return Buffer.from(row.value, "base64");
  }
  const key = crypto.randomBytes(32);
  upsertSettingStmt.run("_encryptionKey", key.toString("base64"));
  return key;
}

let settingsCache: AppSettings | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000;

const normalizeLidarrRootFolderPaths = (paths: unknown): string[] => [
  ...new Set(
    (Array.isArray(paths) ? paths : []).map((value) => String(value || "").trim()).filter(Boolean),
  ),
];

export const dbOps = {
  invalidateSettingsCache() {
    settingsCache = null;
    settingsCacheTime = 0;
  },

  getJSONSetting(key) {
    return dbHelpers.parseJSON(getSettingStmt.get(key)?.value) || null;
  },

  setJSONSetting(key, value) {
    upsertSettingStmt.run(key, dbHelpers.stringifyJSON(value));
  },

  getUserDiscoverLayout(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(String(userId), 10)}:discoverLayout`);
  },

  setUserDiscoverLayout(userId, layout) {
    dbOps.setJSONSetting(`user:${parseInt(String(userId), 10)}:discoverLayout`, layout);
  },

  getUserTheme(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(String(userId), 10)}:theme`);
  },

  setUserTheme(userId, theme) {
    dbOps.setJSONSetting(`user:${parseInt(String(userId), 10)}:theme`, theme);
  },

  deleteUserTheme(userId) {
    deleteSettingStmt.run(`user:${parseInt(String(userId), 10)}:theme`);
  },

  setLidarrRootFolderPaths(paths) {
    const settings = dbOps.getSettings();
    const normalized = normalizeLidarrRootFolderPaths(paths);
    const currentIntegrations = settings.integrations || {};
    const currentLidarr = currentIntegrations.lidarr || {};
    if (JSON.stringify(currentLidarr.rootFolderPaths || []) === JSON.stringify(normalized)) {
      return normalized;
    }
    dbOps.updateSettings({
      integrations: {
        ...currentIntegrations,
        lidarr: {
          ...currentLidarr,
          rootFolderPaths: normalized,
        },
      },
    });
    return normalized;
  },

  getSettings() {
    const now = Date.now();
    const cacheTtl = process.env.AURRAL_BACKGROUND_WORKER_GROUP ? 2000 : SETTINGS_CACHE_TTL;
    if (settingsCache && now - settingsCacheTime < cacheTtl) {
      return settingsCache;
    }

    const integrations = dbHelpers.parseJSON(getSettingStmt.get("integrations")?.value);
    const encKey = getOrCreateEncryptionKey();
    const quality = getSettingStmt.get("quality")?.value;
    const dateTimeFormat = getSettingStmt.get("dateTimeFormat")?.value;
    const queueCleaner = dbHelpers.parseJSON(getSettingStmt.get("queueCleaner")?.value);
    const security: StoredSecurity | null = dbHelpers.parseJSON(
      getSettingStmt.get("security")?.value,
    );
    const rootFolderPath = getSettingStmt.get("rootFolderPath")?.value;
    const downloadFolderPath = getSettingStmt.get("downloadFolderPath")?.value || null;
    syncDownloadFolderPath(downloadFolderPath);
    const pathMappings = normalizePathMappings(
      dbHelpers.parseJSON(getSettingStmt.get("pathMappings")?.value) || [],
    );
    syncPathMappings(pathMappings);
    const releaseTypes: string[] | null = dbHelpers.parseJSON(
      getSettingStmt.get("releaseTypes")?.value,
    );
    const flows = readStoredSettingJson("flows", ["weeklyFlows"]);
    const staticPlaylists = readStoredSettingJson("sharedPlaylists", ["sharedFlowPlaylists"]);
    const subsonic = readStoredSettingJson<{ favoriteAutoKeep?: boolean }>("subsonic") || {};
    const playlistWorker = normalizePlaylistWorkerSettings(
      readStoredSettingJson<StoredPlaylistWorker>("playlistWorker", ["weeklyFlowWorker"]),
    );
    const playlistArtwork = normalizePlaylistArtworkSettings(
      readStoredSettingJson<StoredPlaylistArtwork>("playlistArtwork"),
    );
    const missingTrackSearch = normalizeMissingTrackSearchSettings(
      readStoredSettingJson<StoredMissingTrackSearch>("missingTrackSearch"),
    );
    const reviewTimeoutHours = normalizeReviewTimeoutHours(
      getSettingStmt.get("reviewTimeoutHours")?.value,
    );
    const inbox: StoredInbox = dbHelpers.parseJSON(getSettingStmt.get("inbox")?.value) || {};
    const blocklist: StoredBlocklist | null = dbHelpers.parseJSON(
      getSettingStmt.get("blocklist")?.value,
    );
    const onboardingComplete = getSettingStmt.get("onboardingComplete")?.value === "true";

    const decryptedIntegrations: StoredIntegrations =
      decryptIntegrations(integrations, encKey) || {};
    const storedQualityProfile = dbHelpers.parseJSON(getSettingStmt.get("qualityProfile")?.value);
    const qualityProfile = normalizeQualityProfile(
      storedQualityProfile,
      decryptedIntegrations.slskd,
    );
    if (storedQualityProfile == null) {
      upsertSettingStmt.run("qualityProfile", dbHelpers.stringifyJSON(qualityProfile));
    }
    const result = {
      integrations: decryptedIntegrations,
      quality: quality || "standard",
      dateTimeFormat: normalizeDateTimeFormat(dateTimeFormat),
      qualityProfile,
      queueCleaner: queueCleaner || {},
      security:
        security && typeof security === "object"
          ? security
          : { localNetworkBypass: { enabled: false } },
      rootFolderPath: rootFolderPath || null,
      downloadFolderPath: downloadFolderPath || null,
      pathMappings,
      releaseTypes: releaseTypes || [],
      flows: flows || null,
      sharedPlaylists: staticPlaylists || null,
      subsonic: {
        favoriteAutoKeep: subsonic.favoriteAutoKeep !== false,
      },
      playlistWorker,
      playlistArtwork,
      missingTrackSearch,
      reviewTimeoutHours,
      inbox: {
        enabled: inbox.enabled !== false,
        releases: inbox.releases !== false,
        shows: inbox.shows !== false,
        news: inbox.news !== false,
        recommendedNews: inbox.recommendedNews === true,
        discoveries: inbox.discoveries !== false,
      },
      blocklist: blocklist && typeof blocklist === "object" ? blocklist : { artists: [], tags: [] },
      onboardingComplete: !!onboardingComplete,
    };
    if (result.integrations?.navidrome) {
      delete result.integrations.navidrome.m3uPathMode;
      delete result.integrations.navidrome.pathMappings;
    }
    settingsCache = result;
    settingsCacheTime = Date.now();
    return result;
  },

  updateSettings(settings) {
    settingsCache = null;
    const updateFn = db.transaction(() => {
      if (settings.integrations) {
        const encKey = getOrCreateEncryptionKey();
        const existingIntegrations: StoredIntegrations =
          decryptIntegrations(
            dbHelpers.parseJSON(getSettingStmt.get("integrations")?.value),
            encKey,
          ) || {};
        const nextIntegrations = { ...settings.integrations };
        if (existingIntegrations.soulseek && nextIntegrations.soulseek === undefined) {
          nextIntegrations.soulseek = existingIntegrations.soulseek;
        }
        if (nextIntegrations.navidrome) {
          nextIntegrations.navidrome = {
            ...nextIntegrations.navidrome,
          };
          delete nextIntegrations.navidrome.m3uPathMode;
          delete nextIntegrations.navidrome.pathMappings;
        }
        upsertSettingStmt.run(
          "integrations",
          dbHelpers.stringifyJSON(encryptIntegrations(nextIntegrations, encKey)),
        );
      }
      if (settings.quality) {
        upsertSettingStmt.run("quality", settings.quality);
      }
      if (settings.dateTimeFormat !== undefined) {
        upsertSettingStmt.run("dateTimeFormat", normalizeDateTimeFormat(settings.dateTimeFormat));
      }
      if (settings.qualityProfile !== undefined) {
        upsertSettingStmt.run(
          "qualityProfile",
          dbHelpers.stringifyJSON(
            normalizeQualityProfile(settings.qualityProfile, settings.integrations?.slskd),
          ),
        );
      }
      if (settings.queueCleaner) {
        upsertSettingStmt.run("queueCleaner", dbHelpers.stringifyJSON(settings.queueCleaner));
      }
      if (settings.security !== undefined) {
        upsertSettingStmt.run("security", dbHelpers.stringifyJSON(settings.security));
      }
      if (settings.inbox !== undefined) {
        upsertSettingStmt.run(
          "inbox",
          dbHelpers.stringifyJSON({
            enabled: settings.inbox.enabled !== false,
            releases: settings.inbox.releases !== false,
            shows: settings.inbox.shows !== false,
            news: settings.inbox.news !== false,
            recommendedNews: settings.inbox.recommendedNews === true,
            discoveries: settings.inbox.discoveries !== false,
          }),
        );
      }
      if (settings.rootFolderPath !== undefined && settings.rootFolderPath !== null) {
        upsertSettingStmt.run("rootFolderPath", settings.rootFolderPath);
      }
      if (settings.downloadFolderPath !== undefined) {
        const normalized = String(settings.downloadFolderPath || "").trim();
        if (!normalized) {
          deleteSettingStmt.run("downloadFolderPath");
          syncDownloadFolderPath(null);
        } else {
          const validation = validateDownloadFolderPath(normalized, undefined, {
            create: true,
          });
          if (!validation.valid) {
            throw new Error(validation.error);
          }
          upsertSettingStmt.run("downloadFolderPath", validation.path);
          syncDownloadFolderPath(validation.path);
        }
      }
      if (settings.pathMappings !== undefined) {
        const normalizedMappings = normalizePathMappings(settings.pathMappings);
        upsertSettingStmt.run("pathMappings", dbHelpers.stringifyJSON(normalizedMappings));
        syncPathMappings(normalizedMappings);
      }
      if (settings.releaseTypes) {
        upsertSettingStmt.run("releaseTypes", dbHelpers.stringifyJSON(settings.releaseTypes));
      }
      if (settings.flows !== undefined) {
        upsertSettingStmt.run("flows", dbHelpers.stringifyJSON(settings.flows));
      }
      if (settings.sharedPlaylists !== undefined) {
        upsertSettingStmt.run("sharedPlaylists", dbHelpers.stringifyJSON(settings.sharedPlaylists));
      }
      if (settings.subsonic !== undefined) {
        upsertSettingStmt.run(
          "subsonic",
          dbHelpers.stringifyJSON({
            favoriteAutoKeep: settings.subsonic.favoriteAutoKeep !== false,
          }),
        );
      }
      if (settings.playlistWorker !== undefined) {
        upsertSettingStmt.run(
          "playlistWorker",
          dbHelpers.stringifyJSON(normalizePlaylistWorkerSettings(settings.playlistWorker)),
        );
      }
      if (settings.playlistArtwork !== undefined) {
        upsertSettingStmt.run(
          "playlistArtwork",
          dbHelpers.stringifyJSON(normalizePlaylistArtworkSettings(settings.playlistArtwork)),
        );
      }
      if (settings.missingTrackSearch !== undefined) {
        upsertSettingStmt.run(
          "missingTrackSearch",
          dbHelpers.stringifyJSON(normalizeMissingTrackSearchSettings(settings.missingTrackSearch)),
        );
      }
      if (settings.reviewTimeoutHours !== undefined) {
        upsertSettingStmt.run(
          "reviewTimeoutHours",
          String(normalizeReviewTimeoutHours(settings.reviewTimeoutHours)),
        );
      }
      if (settings.blocklist !== undefined) {
        upsertSettingStmt.run("blocklist", dbHelpers.stringifyJSON(settings.blocklist));
      }
      if (settings.onboardingComplete !== undefined) {
        upsertSettingStmt.run("onboardingComplete", settings.onboardingComplete ? "true" : "false");
      }
    });
    updateFn();
  },
} as DbOps;

export function getSettingsEncryptionKey() {
  return getOrCreateEncryptionKey();
}
