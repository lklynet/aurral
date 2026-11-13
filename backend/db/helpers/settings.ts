import crypto from "crypto";
import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptIntegrations, encryptIntegrations } from "../../config/encryption.ts";
import { normalizePathMappings, syncPathMappings } from "../../services/pathMappings.ts";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../../services/downloadFolderConfig.ts";
import { normalizeDateTimeFormat } from "../../config/constants.ts";
import type { defaultData } from "../../config/constants.ts";
import { normalizeQualityProfile } from "../../services/qualityProfileModel.ts";
import type { SettingsRow } from "../rows.ts";
import type { CacheOps } from "./cache.ts";
import type { DiscoveryCacheOps } from "./discovery.ts";
import type { ArtistOverrideOps } from "./overrides.ts";
import type { AurralHistoryOps } from "./history.ts";
import type { InboxOps } from "./inbox.ts";
import {
  readIntegrationSettings,
  warnUnreadableIntegrationSettings,
  type StoredIntegrations,
} from "./integrationSettings.ts";
import { lenient } from "./storedSchemas.ts";

export type { StoredIntegrations } from "./integrationSettings.ts";

export type SettingsPlaylistWorker = ReturnType<typeof normalizePlaylistWorkerSettings>;

type SettingsInbox = typeof defaultData.settings.inbox;

const flag = lenient(v.boolean());

const securitySchema = v.looseObject({
  localNetworkBypass: lenient(v.looseObject({ enabled: flag })),
  defaultPermissions: lenient(v.record(v.string(), v.boolean())),
});

type StoredSecurity = v.InferOutput<typeof securitySchema>;

export interface StoredPlaylistWorker {
  concurrency?: unknown;
  retryPausedPlaylistIds?: unknown;
}

const inboxSchema = v.looseObject({
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
  dateTimeFormat: string;
  qualityProfile: QualityProfile;
  security: StoredSecurity;
  downloadFolderPath: string | null;
  pathMappings: ReturnType<typeof normalizePathMappings>;
  playlistWorker: SettingsPlaylistWorker;
  inbox: SettingsInbox;
  onboardingComplete: boolean;
}

export interface SettingsUpdate {
  integrations?: StoredIntegrations;
  dateTimeFormat?: string | null;
  qualityProfile?: unknown;
  security?: StoredSecurity;
  inbox?: StoredInbox;
  downloadFolderPath?: string | null;
  pathMappings?: unknown;
  flows?: unknown;
  staticPlaylists?: unknown;
  playlistWorker?: StoredPlaylistWorker;
  onboardingComplete?: boolean;
}

export interface SettingsOps {
  invalidateSettingsCache: () => void;
  getJSONSetting: <Schema extends v.GenericSchema>(
    key: string,
    schema: Schema,
  ) => v.InferOutput<Schema> | null;
  setJSONSetting: (key: string, value: unknown) => void;
  getUserDiscoverLayout: (userId: number) => unknown;
  setUserDiscoverLayout: (userId: number, layout: unknown) => void;
  getUserTheme: (userId: number) => unknown;
  getUserPlaylistOrder: (userId: number) => string[];
  setUserPlaylistOrder: (userId: number, ids: string[]) => void;
  setUserTheme: (userId: number, theme: unknown) => void;
  deleteUserSettings: (userId: number) => void;
  getSettings: () => AppSettings;
  updateSettings: (settings: SettingsUpdate) => void;
}

export type DbOps = SettingsOps &
  CacheOps &
  DiscoveryCacheOps &
  ArtistOverrideOps &
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

const readStoredSettingJson = <Schema extends v.GenericSchema>(schema: Schema, key: string) =>
  dbHelpers.readJSON(schema, getSettingStmt.get(key)?.value, key);

function normalizePlaylistWorkerSettings(raw: StoredPlaylistWorker | null | undefined) {
  const worker: StoredPlaylistWorker = raw && typeof raw === "object" ? raw : {};
  const parsedConcurrency = Number(worker.concurrency);
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : 2;
  const retryPausedPlaylistIds = Array.isArray(worker.retryPausedPlaylistIds)
    ? [
        ...new Set(
          worker.retryPausedPlaylistIds.map((entry) => String(entry || "").trim()).filter(Boolean),
        ),
      ]
    : [];
  return {
    concurrency,
    retryPausedPlaylistIds,
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

  getUserPlaylistOrder(userId) {
    return (
      dbOps.getJSONSetting(
        `user:${parseInt(String(userId), 10)}:playlistOrder`,
        v.array(v.string()),
      ) ?? []
    );
  },

  setUserPlaylistOrder(userId, ids) {
    dbOps.setJSONSetting(`user:${parseInt(String(userId), 10)}:playlistOrder`, ids);
  },

  deleteUserSettings(userId) {
    deleteSettingsByPrefixStmt.run(`user:${parseInt(String(userId), 10)}:`);
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
    const dateTimeFormat = getSettingStmt.get("dateTimeFormat")?.value;
    const security = dbHelpers.readJSON(
      securitySchema,
      getSettingStmt.get("security")?.value,
      "security",
    );
    const downloadFolderPath = getSettingStmt.get("downloadFolderPath")?.value || null;
    syncDownloadFolderPath(downloadFolderPath);
    const pathMappings = normalizePathMappings(
      dbHelpers.parseJSON(getSettingStmt.get("pathMappings")?.value) || [],
    );
    syncPathMappings(pathMappings);
    const playlistWorker = normalizePlaylistWorkerSettings(
      readStoredSettingJson(v.looseObject({}), "playlistWorker"),
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
      dateTimeFormat: normalizeDateTimeFormat(dateTimeFormat),
      qualityProfile,
      security: security ?? { localNetworkBypass: { enabled: false } },
      downloadFolderPath: downloadFolderPath || null,
      pathMappings,
      playlistWorker,
      inbox: {
        releases: inbox.releases !== false,
        shows: inbox.shows !== false,
        news: inbox.news !== false,
        recommendedNews: inbox.recommendedNews === true,
        discoveries: inbox.discoveries !== false,
      },
      onboardingComplete: !!onboardingComplete,
    };
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
        const { integrations: savedIntegrations, unreadable } =
          readIntegrationSettings(nextIntegrations);
        warnUnreadableIntegrationSettings(unreadable);
        upsertSettingStmt.run(
          "integrations",
          dbHelpers.stringifyJSON(encryptIntegrations(savedIntegrations, encKey)),
        );
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
      if (settings.security !== undefined) {
        upsertSettingStmt.run("security", dbHelpers.stringifyJSON(settings.security));
      }
      if (settings.inbox !== undefined) {
        upsertSettingStmt.run(
          "inbox",
          dbHelpers.stringifyJSON({
            releases: settings.inbox.releases !== false,
            shows: settings.inbox.shows !== false,
            news: settings.inbox.news !== false,
            recommendedNews: settings.inbox.recommendedNews === true,
            discoveries: settings.inbox.discoveries !== false,
          }),
        );
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
      if (settings.flows !== undefined) {
        upsertSettingStmt.run("flows", dbHelpers.stringifyJSON(settings.flows));
      }
      if (settings.staticPlaylists !== undefined) {
        upsertSettingStmt.run("staticPlaylists", dbHelpers.stringifyJSON(settings.staticPlaylists));
      }
      if (settings.playlistWorker !== undefined) {
        upsertSettingStmt.run(
          "playlistWorker",
          dbHelpers.stringifyJSON(normalizePlaylistWorkerSettings(settings.playlistWorker)),
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
