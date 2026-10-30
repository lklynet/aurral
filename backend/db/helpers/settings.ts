import crypto from "crypto";
import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptIntegrations, encryptIntegrations } from "../../config/encryption.ts";
import { normalizePathMappings, syncPathMappings } from "../../services/pathMappings.ts";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../../services/downloadFolderConfig.ts";
import { normalizeExistingFileMode } from "../../services/downloadJobs/fileReuseMode.ts";
import { normalizeDateTimeFormat } from "../../config/constants.ts";
import type { defaultData } from "../../config/constants.ts";
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
import {
  readIntegrationSettings,
  warnUnreadableIntegrationSettings,
  type StoredIntegrations,
} from "./integrationSettings.ts";
import { lenient, listOf } from "./storedSchemas.ts";

export type { StoredIntegrations } from "./integrationSettings.ts";

export type SettingsPlaylistWorker = ReturnType<typeof normalizePlaylistWorkerSettings>;

type SettingsMissingTrackSearch = ReturnType<typeof normalizeMissingTrackSearchSettings>;

type SettingsInbox = typeof defaultData.settings.inbox;

const flag = lenient(v.boolean());

const securitySchema = v.looseObject({
  localNetworkBypass: lenient(v.looseObject({ enabled: flag })),
  ssoOnly: flag,
});

type StoredSecurity = v.InferOutput<typeof securitySchema>;

export interface StoredPlaylistWorker {
  concurrency?: unknown;
  retryPausedPlaylistIds?: unknown;
  existingFileMode?: unknown;
}

interface StoredMissingTrackSearch {
  enabled?: unknown;
  intervalDays?: unknown;
}

const inboxSchema = v.looseObject({
  enabled: flag,
  releases: flag,
  shows: flag,
  news: flag,
  recommendedNews: flag,
  discoveries: flag,
});

type StoredInbox = v.InferOutput<typeof inboxSchema>;

export type QualityProfile = ReturnType<typeof normalizeQualityProfile>;

export interface AppSettings {
  integrations: StoredIntegrations;
  quality: string;
  dateTimeFormat: string;
  qualityProfile: QualityProfile;
  queueCleaner: Record<string, unknown>;
  security: StoredSecurity;
  rootFolderPath: string | null;
  downloadFolderPath: string | null;
  pathMappings: ReturnType<typeof normalizePathMappings>;
  releaseTypes: string[];
  subsonic: typeof defaultData.settings.subsonic;
  playlistWorker: SettingsPlaylistWorker;
  missingTrackSearch: SettingsMissingTrackSearch;
  reviewTimeoutHours: number;
  inbox: SettingsInbox;
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
  missingTrackSearch?: StoredMissingTrackSearch;
  reviewTimeoutHours?: number | string;
  onboardingComplete?: boolean;
}

export interface SettingsOps {
  invalidateSettingsCache: () => void;
  getJSONSetting: <Schema extends v.GenericSchema>(
    key: string,
    schema: Schema,
  ) => v.InferOutput<Schema> | null;
  setJSONSetting: (key: string, value: unknown) => void;
  getPlaylistSetting: (key: keyof typeof PLAYLIST_SETTING_LEGACY_KEYS) => unknown;
  getUserDiscoverLayout: (userId: number) => unknown;
  setUserDiscoverLayout: (userId: number, layout: unknown) => void;
  getUserTheme: (userId: number) => unknown;
  setUserTheme: (userId: number, theme: unknown) => void;
  deleteUserSettings: (userId: number) => void;
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
const deleteSettingsByPrefixStmt = db.prepare<[string]>(
  "DELETE FROM settings WHERE key LIKE ? || '%'",
);

const PLAYLIST_WORKER_RETRY_CYCLE_MINUTES = 360;

const PLAYLIST_SETTING_LEGACY_KEYS = {
  flows: ["weeklyFlows"],
  sharedPlaylists: ["sharedFlowPlaylists"],
};

function readStoredSettingJson<Schema extends v.GenericSchema>(
  schema: Schema,
  primaryKey: string,
  legacyKeys: string[] = [],
) {
  for (const key of [primaryKey, ...legacyKeys]) {
    const value = dbHelpers.readJSON(schema, getSettingStmt.get(key)?.value, key);
    if (value != null) return value;
  }
  return null;
}

function normalizeMissingTrackSearchSettings(raw: StoredMissingTrackSearch | null | undefined) {
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

function normalizePlaylistWorkerSettings(raw: StoredPlaylistWorker | null | undefined) {
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

  getJSONSetting(key, schema) {
    return dbHelpers.readJSON(schema, getSettingStmt.get(key)?.value, key);
  },

  setJSONSetting(key, value) {
    upsertSettingStmt.run(key, dbHelpers.stringifyJSON(value));
  },

  getPlaylistSetting(key) {
    return readStoredSettingJson(v.unknown(), key, PLAYLIST_SETTING_LEGACY_KEYS[key]);
  },

  getUserDiscoverLayout(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(String(userId), 10)}:discoverLayout`, v.unknown());
  },

  setUserDiscoverLayout(userId, layout) {
    dbOps.setJSONSetting(`user:${parseInt(String(userId), 10)}:discoverLayout`, layout);
  },

  getUserTheme(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(String(userId), 10)}:theme`, v.unknown());
  },

  setUserTheme(userId, theme) {
    dbOps.setJSONSetting(`user:${parseInt(String(userId), 10)}:theme`, theme);
  },

  deleteUserSettings(userId) {
    deleteSettingsByPrefixStmt.run(`user:${parseInt(String(userId), 10)}:`);
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

    const encKey = getOrCreateEncryptionKey();
    const { integrations: decryptedIntegrations, unreadable } = readIntegrationSettings(
      decryptIntegrations(dbHelpers.parseJSON(getSettingStmt.get("integrations")?.value), encKey),
    );
    warnUnreadableIntegrationSettings(unreadable);
    const quality = getSettingStmt.get("quality")?.value;
    const dateTimeFormat = getSettingStmt.get("dateTimeFormat")?.value;
    const queueCleaner = dbHelpers.readJSON(
      v.record(v.string(), v.unknown()),
      getSettingStmt.get("queueCleaner")?.value,
      "queueCleaner",
    );
    const security = dbHelpers.readJSON(
      securitySchema,
      getSettingStmt.get("security")?.value,
      "security",
    );
    const rootFolderPath = getSettingStmt.get("rootFolderPath")?.value;
    const downloadFolderPath = getSettingStmt.get("downloadFolderPath")?.value || null;
    syncDownloadFolderPath(downloadFolderPath);
    const pathMappings = normalizePathMappings(
      dbHelpers.parseJSON(getSettingStmt.get("pathMappings")?.value) || [],
    );
    syncPathMappings(pathMappings);
    const releaseTypes = dbHelpers.readJSON(
      listOf(v.string()),
      getSettingStmt.get("releaseTypes")?.value,
      "releaseTypes",
    );
    const subsonic =
      readStoredSettingJson(v.looseObject({ favoriteAutoKeep: flag }), "subsonic") || {};
    const playlistWorker = normalizePlaylistWorkerSettings(
      readStoredSettingJson(v.looseObject({}), "playlistWorker", ["weeklyFlowWorker"]),
    );
    const missingTrackSearch = normalizeMissingTrackSearchSettings(
      readStoredSettingJson(v.looseObject({}), "missingTrackSearch"),
    );
    const reviewTimeoutHours = normalizeReviewTimeoutHours(
      getSettingStmt.get("reviewTimeoutHours")?.value,
    );
    const inbox =
      dbHelpers.readJSON(inboxSchema, getSettingStmt.get("inbox")?.value, "inbox") || {};
    const onboardingComplete = getSettingStmt.get("onboardingComplete")?.value === "true";

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
      security: security ?? { localNetworkBypass: { enabled: false } },
      rootFolderPath: rootFolderPath || null,
      downloadFolderPath: downloadFolderPath || null,
      pathMappings,
      releaseTypes: releaseTypes || [],
      subsonic: {
        favoriteAutoKeep: subsonic.favoriteAutoKeep !== false,
      },
      playlistWorker,
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
        const existingSoulseek = dbHelpers.readJSON(
          v.looseObject({ soulseek: v.optional(v.unknown()) }),
          getSettingStmt.get("integrations")?.value,
          "integrations",
        )?.soulseek;
        const nextIntegrations = { ...settings.integrations };
        if (existingSoulseek && nextIntegrations.soulseek === undefined) {
          nextIntegrations.soulseek = existingSoulseek;
        }
        if (nextIntegrations.navidrome) {
          nextIntegrations.navidrome = {
            ...nextIntegrations.navidrome,
          };
          delete nextIntegrations.navidrome.m3uPathMode;
          delete nextIntegrations.navidrome.pathMappings;
        }
        const { integrations: savedIntegrations, unreadable } =
          readIntegrationSettings(nextIntegrations);
        warnUnreadableIntegrationSettings(unreadable);
        upsertSettingStmt.run(
          "integrations",
          dbHelpers.stringifyJSON(encryptIntegrations(savedIntegrations, encKey)),
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
