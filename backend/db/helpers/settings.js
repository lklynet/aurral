import crypto from "crypto";
import { db, dbHelpers } from "../../config/db-sqlite.js";
import { decryptIntegrations, encryptIntegrations } from "../../config/encryption.js";
import {
  normalizePathMappings,
  syncPathMappings,
} from "../../services/pathMappings.js";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../../services/downloadFolderConfig.js";
import { normalizeExistingFileMode } from "../../services/weeklyFlow/weeklyFlowFileReuse.js";
import { normalizeDateTimeFormat } from "../../config/constants.js";
import { normalizeQualityProfile } from "../../services/qualityProfileModel.js";

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
);
const deleteSettingStmt = db.prepare("DELETE FROM settings WHERE key = ?");

const PLAYLIST_WORKER_RETRY_CYCLE_MINUTES = 360;

function readStoredSettingJson(primaryKey, legacyKeys = []) {
  const primary = dbHelpers.parseJSON(getSettingStmt.get(primaryKey)?.value);
  if (primary != null) return primary;
  for (const legacyKey of legacyKeys) {
    const legacy = dbHelpers.parseJSON(getSettingStmt.get(legacyKey)?.value);
    if (legacy != null) return legacy;
  }
  return null;
}

function normalizePlaylistArtworkSettings(raw) {
  const artwork = raw && typeof raw === "object" ? raw : {};
  const style = String(artwork.style || "photo").trim().toLowerCase();
  return {
    style: style === "aurral" ? "aurral" : "photo",
  };
}

function normalizePlaylistWorkerSettings(raw) {
  const worker = raw && typeof raw === "object" ? raw : {};
  const parsedConcurrency = Number(worker.concurrency);
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : 2;
  const retryCycleMinutes = PLAYLIST_WORKER_RETRY_CYCLE_MINUTES;
  const retryPausedPlaylistIds = Array.isArray(worker.retryPausedPlaylistIds)
    ? [
        ...new Set(
          worker.retryPausedPlaylistIds
            .map((entry) => String(entry || "").trim())
            .filter(Boolean),
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

let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000;

export const dbOps = {
  getJSONSetting(key) {
    return dbHelpers.parseJSON(getSettingStmt.get(key)?.value) || null;
  },

  setJSONSetting(key, value) {
    upsertSettingStmt.run(key, dbHelpers.stringifyJSON(value));
  },

  getUserDiscoverLayout(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(userId, 10)}:discoverLayout`);
  },

  setUserDiscoverLayout(userId, layout) {
    dbOps.setJSONSetting(
      `user:${parseInt(userId, 10)}:discoverLayout`,
      layout,
    );
  },

  getSettings() {
    const now = Date.now();
    if (settingsCache && now - settingsCacheTime < SETTINGS_CACHE_TTL) {
      return settingsCache;
    }

    const integrations = dbHelpers.parseJSON(
      getSettingStmt.get("integrations")?.value
    );
    const encKey = getOrCreateEncryptionKey();
    const quality = getSettingStmt.get("quality")?.value;
    const dateTimeFormat = getSettingStmt.get("dateTimeFormat")?.value;
    const queueCleaner = dbHelpers.parseJSON(
      getSettingStmt.get("queueCleaner")?.value
    );
    const security = dbHelpers.parseJSON(
      getSettingStmt.get("security")?.value
    );
    const rootFolderPath = getSettingStmt.get("rootFolderPath")?.value;
    const downloadFolderPath =
      getSettingStmt.get("downloadFolderPath")?.value || null;
    syncDownloadFolderPath(downloadFolderPath);
    const pathMappings = normalizePathMappings(
      dbHelpers.parseJSON(getSettingStmt.get("pathMappings")?.value) || [],
    );
    syncPathMappings(pathMappings);
    const releaseTypes = dbHelpers.parseJSON(
      getSettingStmt.get("releaseTypes")?.value
    );
    const flows = readStoredSettingJson("flows", ["weeklyFlows"]);
    const sharedPlaylists = readStoredSettingJson("sharedPlaylists", [
      "sharedFlowPlaylists",
    ]);
    const playlistWorker = normalizePlaylistWorkerSettings(
      readStoredSettingJson("playlistWorker", ["weeklyFlowWorker"]),
    );
    const playlistArtwork = normalizePlaylistArtworkSettings(
      readStoredSettingJson("playlistArtwork"),
    );
    const inbox = dbHelpers.parseJSON(getSettingStmt.get("inbox")?.value) || {};
    const blocklist = dbHelpers.parseJSON(
      getSettingStmt.get("blocklist")?.value
    );
    const onboardingComplete =
      getSettingStmt.get("onboardingComplete")?.value === "true";

    const decryptedIntegrations = decryptIntegrations(integrations, encKey) || {};
    const storedQualityProfile = dbHelpers.parseJSON(
      getSettingStmt.get("qualityProfile")?.value,
    );
    const qualityProfile = normalizeQualityProfile(
      storedQualityProfile,
      decryptedIntegrations.slskd,
    );
    if (storedQualityProfile == null) {
      upsertSettingStmt.run(
        "qualityProfile",
        dbHelpers.stringifyJSON(qualityProfile),
      );
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
      sharedPlaylists: sharedPlaylists || null,
      playlistWorker,
      playlistArtwork,
      inbox: {
        enabled: inbox.enabled !== false,
        releases: inbox.releases !== false,
        shows: inbox.shows !== false,
        news: inbox.news !== false,
        recommendedNews: inbox.recommendedNews === true,
        discoveries: inbox.discoveries !== false,
      },
      blocklist:
        blocklist && typeof blocklist === "object"
          ? blocklist
          : { artists: [], tags: [] },
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
        const existingIntegrations =
          decryptIntegrations(
            dbHelpers.parseJSON(getSettingStmt.get("integrations")?.value),
            encKey,
          ) || {};
        const nextIntegrations = { ...settings.integrations };
        if (
          existingIntegrations.soulseek &&
          nextIntegrations.soulseek === undefined
        ) {
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
          dbHelpers.stringifyJSON(
            encryptIntegrations(nextIntegrations, encKey)
          )
        );
      }
      if (settings.quality) {
        upsertSettingStmt.run("quality", settings.quality);
      }
      if (settings.dateTimeFormat !== undefined) {
        upsertSettingStmt.run(
          "dateTimeFormat",
          normalizeDateTimeFormat(settings.dateTimeFormat),
        );
      }
      if (settings.qualityProfile !== undefined) {
        upsertSettingStmt.run(
          "qualityProfile",
          dbHelpers.stringifyJSON(
            normalizeQualityProfile(
              settings.qualityProfile,
              settings.integrations?.slskd,
            ),
          ),
        );
      }
      if (settings.queueCleaner) {
        upsertSettingStmt.run(
          "queueCleaner",
          dbHelpers.stringifyJSON(settings.queueCleaner)
        );
      }
      if (settings.security !== undefined) {
        upsertSettingStmt.run(
          "security",
          dbHelpers.stringifyJSON(settings.security)
        );
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
      if (
        settings.rootFolderPath !== undefined &&
        settings.rootFolderPath !== null
      ) {
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
        upsertSettingStmt.run(
          "pathMappings",
          dbHelpers.stringifyJSON(normalizedMappings),
        );
        syncPathMappings(normalizedMappings);
      }
      if (settings.releaseTypes) {
        upsertSettingStmt.run(
          "releaseTypes",
          dbHelpers.stringifyJSON(settings.releaseTypes)
        );
      }
      if (settings.flows !== undefined) {
        upsertSettingStmt.run("flows", dbHelpers.stringifyJSON(settings.flows));
      }
      if (settings.sharedPlaylists !== undefined) {
        upsertSettingStmt.run(
          "sharedPlaylists",
          dbHelpers.stringifyJSON(settings.sharedPlaylists),
        );
      }
      if (settings.playlistWorker !== undefined) {
        upsertSettingStmt.run(
          "playlistWorker",
          dbHelpers.stringifyJSON(
            normalizePlaylistWorkerSettings(settings.playlistWorker),
          ),
        );
      }
      if (settings.playlistArtwork !== undefined) {
        upsertSettingStmt.run(
          "playlistArtwork",
          dbHelpers.stringifyJSON(
            normalizePlaylistArtworkSettings(settings.playlistArtwork),
          ),
        );
      }
      if (settings.blocklist !== undefined) {
        upsertSettingStmt.run(
          "blocklist",
          dbHelpers.stringifyJSON(settings.blocklist)
        );
      }
      if (settings.onboardingComplete !== undefined) {
        upsertSettingStmt.run(
          "onboardingComplete",
          settings.onboardingComplete ? "true" : "false"
        );
      }
    });
    updateFn();
  },
};

export function getSettingsEncryptionKey() {
  return getOrCreateEncryptionKey();
}
