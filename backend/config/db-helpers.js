import crypto from "crypto";
import { db, dbHelpers } from "./db-sqlite.js";
import { decryptIntegrations, encryptIntegrations } from "./encryption.js";
import {
  DEFAULT_LISTEN_HISTORY_PROVIDER,
  getListenHistoryProfile,
  hasListenHistoryProfile,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUsername,
  normalizeListenHistoryUrl,
} from "../services/listeningHistory.js";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../services/downloadFolderConfig.js";
import {
  normalizePathMappings,
  syncPathMappings,
} from "../services/pathMappings.js";
import { normalizeM3uPathMode, syncM3uPathMode } from "../services/playlistM3uPaths.js";

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

function normalizeLegacyWeeklyFlowWorkerSettings(raw) {
  const legacy = readStoredSettingJson("weeklyFlowWorker") || {};
  const current = normalizePlaylistWorkerSettings(raw);
  return {
    ...legacy,
    concurrency: current.concurrency,
    retryCycleMinutes: current.retryCycleMinutes,
    retryPausedPlaylistIds: current.retryPausedPlaylistIds,
    existingFileMode: current.existingFileMode,
  };
}

const getDiscoveryCacheStmt = db.prepare(
  "SELECT value, last_updated FROM discovery_cache WHERE key = ?"
);
const upsertDiscoveryCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?)"
);

const getImageStmt = db.prepare("SELECT * FROM images_cache WHERE mbid = ?");
const upsertImageStmt = db.prepare(
  "INSERT OR REPLACE INTO images_cache (mbid, image_url, cache_age, created_at) VALUES (?, ?, ?, ?)"
);
const getAllImagesStmt = db.prepare("SELECT * FROM images_cache");
const countImagesStmt = db.prepare("SELECT COUNT(*) as count FROM images_cache");
const deleteImageStmt = db.prepare("DELETE FROM images_cache WHERE mbid = ?");
const clearImagesStmt = db.prepare("DELETE FROM images_cache");
const cleanOldImagesStmt = db.prepare(
  "DELETE FROM images_cache WHERE cache_age < ?"
);

// NOT_FOUND entries expire after 7 days so covers added later get picked up
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const getDeezerMbidCacheStmt = db.prepare(
  "SELECT mbid FROM deezer_mbid_cache WHERE cache_key = ?"
);
const setDeezerMbidCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO deezer_mbid_cache (cache_key, mbid) VALUES (?, ?)"
);
const getMusicbrainzArtistMbidCacheStmt = db.prepare(
  "SELECT mbid, updated_at FROM musicbrainz_artist_mbid_cache WHERE artist_name_key = ?"
);
const setMusicbrainzArtistMbidCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO musicbrainz_artist_mbid_cache (artist_name_key, mbid, updated_at) VALUES (?, ?, ?)"
);
const cleanOldMusicbrainzArtistMbidCacheStmt = db.prepare(
  "DELETE FROM musicbrainz_artist_mbid_cache WHERE updated_at < ?"
);

const getArtistOverrideStmt = db.prepare(
  "SELECT * FROM artist_overrides WHERE mbid = ?"
);
const upsertArtistOverrideStmt = db.prepare(
  "INSERT OR REPLACE INTO artist_overrides (mbid, musicbrainz_id, deezer_artist_id, updated_at) VALUES (?, ?, ?, ?)"
);
const deleteArtistOverrideStmt = db.prepare(
  "DELETE FROM artist_overrides WHERE mbid = ?"
);

const insertAurralHistoryStmt = db.prepare(`
  INSERT OR REPLACE INTO aurral_history (
    id, kind, title, subtitle, status, status_label, href, metadata, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getAurralHistoryStmt = db.prepare(`
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE created_at >= ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const getAurralHistoryByIdStmt = db.prepare(`
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE id = ?
`);
const deleteAurralHistoryOlderThanStmt = db.prepare(
  "DELETE FROM aurral_history WHERE created_at < ?",
);
const countAurralHistoryStmt = db.prepare(
  "SELECT COUNT(*) as count FROM aurral_history",
);
const deleteOldestAurralHistoryStmt = db.prepare(`
  DELETE FROM aurral_history
  WHERE id IN (
    SELECT id FROM aurral_history
    ORDER BY created_at ASC
    LIMIT ?
  )
`);

const getUserByUsernameStmt = db.prepare(
  "SELECT * FROM users WHERE username = ?"
);
const getAllUsersStmt = db.prepare(
  "SELECT id, username, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id, discover_layout FROM users ORDER BY username"
);
const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id, discover_layout) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, password_hash = ?, role = ?, permissions = ?, lastfm_username = ?, listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?, lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?, discover_layout = ? WHERE id = ?"
);
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");
const getAllListeningHistoryUsersStmt = db.prepare(
  "SELECT id, username, lastfm_username, listen_history_provider, listen_history_username, listen_history_url FROM users WHERE (listen_history_username IS NOT NULL AND TRIM(listen_history_username) != '') OR (listen_history_url IS NOT NULL AND TRIM(listen_history_url) != '')"
);

const DEFAULT_PERMISSIONS = {
  accessFlow: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
};

const normalizeExistingFileMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "download") return "download";
  if (
    normalized === "reuse" ||
    normalized === "hardlink" ||
    normalized === "copy"
  ) {
    return "reuse";
  }
  return "reuse";
};

export const userOps = {
  getDefaultPermissions() {
    return { ...DEFAULT_PERMISSIONS };
  },
  getUserByUsername(username) {
    const row = getUserByUsernameStmt.get(
      String(username).trim().toLowerCase()
    );
    if (!row) return null;
    const history = getListenHistoryProfile(row);
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      lidarrRootFolderPath: row.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        row.lidarr_quality_profile_id != null
          ? Number(row.lidarr_quality_profile_id)
          : null,
      discoverLayout: dbHelpers.parseJSON(row.discover_layout) || null,
      ...history,
    };
  },
  getUserById(id) {
    const row = getUserByIdStmt.get(parseInt(id, 10));
    if (!row) return null;
    const history = getListenHistoryProfile(row);
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      lidarrRootFolderPath: row.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        row.lidarr_quality_profile_id != null
          ? Number(row.lidarr_quality_profile_id)
          : null,
      ...history,
    };
  },
  getAllUsers() {
    const rows = getAllUsersStmt.all();
    return rows.map((r) => ({
      ...getListenHistoryProfile(r),
      id: r.id,
      username: r.username,
      role: r.role || "user",
      permissions: dbHelpers.parseJSON(r.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      lidarrRootFolderPath: r.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        r.lidarr_quality_profile_id != null
          ? Number(r.lidarr_quality_profile_id)
          : null,
      discoverLayout: dbHelpers.parseJSON(r.discover_layout) || null,
    }));
  },
  createUser(username, passwordHash, role = "user", permissions = null) {
    const un = String(username).trim();
    if (!un) return null;
    const perms = permissions
      ? { ...DEFAULT_PERMISSIONS, ...permissions }
      : { ...DEFAULT_PERMISSIONS };
    try {
      const result = insertUserStmt.run(
        un.toLowerCase(),
        passwordHash,
        role,
        dbHelpers.stringifyJSON(perms),
        null,
        null,
        null,
      );
      return {
        id: result.lastInsertRowid,
        username: un,
        role,
        permissions: perms,
        listenHistoryProvider: DEFAULT_LISTEN_HISTORY_PROVIDER,
        listenHistoryUsername: null,
        listenHistoryUrl: null,
        lastfmUsername: null,
        lidarrRootFolderPath: null,
        lidarrQualityProfileId: null,
        discoverLayout: null,
      };
    } catch (e) {
      return null;
    }
  },
  updateUser(id, data) {
    const existing = userOps.getUserById(id);
    if (!existing) return null;
    const username =
      data.username !== undefined
        ? String(data.username).trim()
        : existing.username;
    const passwordHash =
      data.passwordHash !== undefined
        ? data.passwordHash
        : existing.passwordHash;
    const role = data.role !== undefined ? data.role : existing.role;
    const permissions =
      data.permissions !== undefined
        ? { ...DEFAULT_PERMISSIONS, ...data.permissions }
        : existing.permissions;
    const listenHistoryProvider = normalizeListenHistoryProvider(
      data.listenHistoryProvider !== undefined
        ? data.listenHistoryProvider
        : data.lastfmUsername !== undefined
          ? "lastfm"
          : existing.listenHistoryProvider,
    );
    const listenHistoryUsername = normalizeListenHistoryUsername(
      data.listenHistoryUsername !== undefined
        ? data.listenHistoryUsername
        : data.lastfmUsername !== undefined
          ? data.lastfmUsername
          : existing.listenHistoryUsername,
    );
    const listenHistoryUrl = normalizeListenHistoryUrl(
      data.listenHistoryUrl !== undefined
        ? data.listenHistoryUrl
        : existing.listenHistoryUrl,
    );
    const resolvedUsername =
      listenHistoryProvider === "koito" ? null : listenHistoryUsername;
    const resolvedUrl =
      listenHistoryProvider === "koito" ? listenHistoryUrl : null;
    const lastfmUsername =
      listenHistoryProvider === "lastfm" ? resolvedUsername : null;
    const lidarrRootFolderPath =
      data.lidarrRootFolderPath !== undefined
        ? data.lidarrRootFolderPath
          ? String(data.lidarrRootFolderPath).trim()
          : null
        : existing.lidarrRootFolderPath;
    const parsedLidarrQualityProfileId =
      data.lidarrQualityProfileId !== undefined &&
      data.lidarrQualityProfileId !== null
        ? Number(data.lidarrQualityProfileId)
        : data.lidarrQualityProfileId === null
          ? null
          : existing.lidarrQualityProfileId;
    const lidarrQualityProfileId =
      parsedLidarrQualityProfileId != null &&
      Number.isFinite(parsedLidarrQualityProfileId)
        ? Math.trunc(parsedLidarrQualityProfileId)
        : parsedLidarrQualityProfileId === null
          ? null
          : existing.lidarrQualityProfileId;
    const discoverLayout =
      data.discoverLayout !== undefined ? data.discoverLayout : existing.discoverLayout;
    try {
      updateUserStmt.run(
        username.toLowerCase(),
        passwordHash,
        role,
        dbHelpers.stringifyJSON(permissions),
        lastfmUsername,
        listenHistoryProvider,
        resolvedUsername,
        resolvedUrl,
        lidarrRootFolderPath,
        lidarrQualityProfileId,
        dbHelpers.stringifyJSON(discoverLayout),
        parseInt(id, 10)
      );
      return {
        id: parseInt(id, 10),
        username,
        role,
        permissions,
        listenHistoryProvider,
        listenHistoryUsername: resolvedUsername,
        listenHistoryUrl: resolvedUrl,
        lastfmUsername,
        lidarrRootFolderPath,
        lidarrQualityProfileId,
        discoverLayout,
      };
    } catch (e) {
      return null;
    }
  },
  deleteUser(id) {
    try {
      deleteUserStmt.run(parseInt(id, 10));
      return true;
    } catch (e) {
      return false;
    }
  },
  getAllListeningHistoryUsers() {
    return getAllListeningHistoryUsersStmt.all().map((r) => ({
      id: r.id,
      username: r.username,
      ...getListenHistoryProfile(r),
    }));
  },
  getAllLastfmUsers() {
    return userOps
      .getAllListeningHistoryUsers()
      .filter((user) => hasListenHistoryProfile(user) && user.lastfmUsername);
  },
};

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
const SETTINGS_CACHE_TTL = 5000;

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
    const blocklist = dbHelpers.parseJSON(
      getSettingStmt.get("blocklist")?.value
    );
    const onboardingComplete =
      getSettingStmt.get("onboardingComplete")?.value === "true";

    const result = {
      integrations: decryptIntegrations(integrations, encKey) || {},
      quality: quality || "standard",
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
      blocklist:
        blocklist && typeof blocklist === "object"
          ? blocklist
          : { artists: [], tags: [] },
      onboardingComplete: !!onboardingComplete,
    };
    if (result.integrations?.navidrome) {
      result.integrations.navidrome.m3uPathMode = normalizeM3uPathMode(
        result.integrations.navidrome.m3uPathMode,
      );
    }
    syncM3uPathMode(result.integrations?.navidrome?.m3uPathMode);
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
        upsertSettingStmt.run(
          "integrations",
          dbHelpers.stringifyJSON(
            encryptIntegrations(nextIntegrations, encKey)
          )
        );
        syncM3uPathMode(nextIntegrations?.navidrome?.m3uPathMode);
      }
      if (settings.quality) {
        upsertSettingStmt.run("quality", settings.quality);
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
        const serializedFlows = dbHelpers.stringifyJSON(settings.flows);
        upsertSettingStmt.run(
          "flows",
          serializedFlows,
        );
        upsertSettingStmt.run(
          "weeklyFlows",
          serializedFlows,
        );
      }
      if (settings.sharedPlaylists !== undefined) {
        const serializedSharedPlaylists = dbHelpers.stringifyJSON(
          settings.sharedPlaylists,
        );
        upsertSettingStmt.run(
          "sharedPlaylists",
          serializedSharedPlaylists,
        );
        upsertSettingStmt.run(
          "sharedFlowPlaylists",
          serializedSharedPlaylists,
        );
      }
      if (settings.playlistWorker !== undefined) {
        const normalizedPlaylistWorker = normalizePlaylistWorkerSettings(
          settings.playlistWorker,
        );
        upsertSettingStmt.run(
          "playlistWorker",
          dbHelpers.stringifyJSON(normalizedPlaylistWorker),
        );
        upsertSettingStmt.run(
          "weeklyFlowWorker",
          dbHelpers.stringifyJSON(
            normalizeLegacyWeeklyFlowWorkerSettings(normalizedPlaylistWorker),
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

  getDiscoveryCache(cacheNamespace = null) {
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    const recommendations = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}recommendations`)?.value
    );
    const globalTop = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}globalTop`)?.value
    );
    const basedOn = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}basedOn`)?.value
    );
    const topTags = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}topTags`)?.value
    );
    const topGenres = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}topGenres`)?.value
    );
    const fallbackGenres = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}fallbackGenres`)?.value
    );
    const fallbackGenrePools = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}fallbackGenrePools`)?.value
    );
    const discoverPlaylists = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}discoverPlaylists`)?.value
    );
    const provider =
      getDiscoveryCacheStmt.get(`${prefix}provider`)?.value || null;
    const recommendationsRow = getDiscoveryCacheStmt.get(`${prefix}recommendations`);
    const globalTopRow = getDiscoveryCacheStmt.get(`${prefix}globalTop`);
    const lastUpdated = cacheNamespace
      ? getDiscoveryCacheStmt.get(`${prefix}lastUpdated`)?.value ||
        recommendationsRow?.last_updated ||
        null
      : recommendationsRow?.last_updated ||
        globalTopRow?.last_updated ||
        null;

    return {
      recommendations: recommendations || [],
      globalTop: globalTop || [],
      basedOn: basedOn || [],
      topTags: topTags || [],
      topGenres: topGenres || [],
      fallbackGenres: fallbackGenres || [],
      fallbackGenrePools:
        fallbackGenrePools && typeof fallbackGenrePools === "object"
          ? fallbackGenrePools
          : {},
      discoverPlaylists: discoverPlaylists || [],
      provider,
      lastUpdated,
    };
  },

  updateDiscoveryCache(discovery, cacheNamespace = null) {
    const now = new Date().toISOString();
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    const updateFn = db.transaction(() => {
      if (discovery.recommendations) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}recommendations`,
          dbHelpers.stringifyJSON(discovery.recommendations),
          now
        );
      }
      if (discovery.globalTop) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}globalTop`,
          dbHelpers.stringifyJSON(discovery.globalTop),
          now
        );
      }
      if (discovery.basedOn) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}basedOn`,
          dbHelpers.stringifyJSON(discovery.basedOn),
          now
        );
      }
      if (discovery.topTags) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topTags`,
          dbHelpers.stringifyJSON(discovery.topTags),
          now
        );
      }
      if (discovery.topGenres) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topGenres`,
          dbHelpers.stringifyJSON(discovery.topGenres),
          now
        );
      }
      if (discovery.fallbackGenres) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}fallbackGenres`,
          dbHelpers.stringifyJSON(discovery.fallbackGenres),
          now
        );
      }
      if (discovery.fallbackGenrePools) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}fallbackGenrePools`,
          dbHelpers.stringifyJSON(discovery.fallbackGenrePools),
          now
        );
      }
      if (discovery.discoverPlaylists) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}discoverPlaylists`,
          dbHelpers.stringifyJSON(discovery.discoverPlaylists),
          now
        );
      }
      if (discovery.provider) {
        upsertDiscoveryCacheStmt.run(`${prefix}provider`, discovery.provider, now);
      }
      if (cacheNamespace) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}lastUpdated`,
          now,
          now
        );
      }
    });
    updateFn();
  },

  deleteDiscoveryCacheByPrefix(prefix) {
    return db.prepare("DELETE FROM discovery_cache WHERE key LIKE ?").run(
      `${prefix}%`
    );
  },

  getImage(mbid) {
    const row = getImageStmt.get(mbid);
    if (!row) return null;
    if (
      row.image_url === "NOT_FOUND" &&
      Date.now() - row.cache_age > NOT_FOUND_TTL_MS
    ) {
      deleteImageStmt.run(mbid);
      return null;
    }
    return {
      mbid: row.mbid,
      imageUrl: row.image_url,
      cacheAge: row.cache_age,
    };
  },

  getImages(mbids) {
    if (!mbids || !mbids.length) return {};
    const placeholders = mbids.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT mbid, image_url, cache_age FROM images_cache WHERE mbid IN (${placeholders})`
    );
    const rows = stmt.all(...mbids);
    const now = Date.now();
    const result = {};
    for (const row of rows) {
      if (
        row.image_url === "NOT_FOUND" &&
        now - row.cache_age > NOT_FOUND_TTL_MS
      ) {
        deleteImageStmt.run(row.mbid);
        continue;
      }
      result[row.mbid] = { imageUrl: row.image_url, cacheAge: row.cache_age };
    }
    return result;
  },

  setImage(mbid, imageUrl) {
    upsertImageStmt.run(mbid, imageUrl, Date.now(), new Date().toISOString());
  },

  getAllImages() {
    const rows = getAllImagesStmt.all();
    const images = {};
    for (const row of rows) {
      images[row.mbid] = row.image_url;
    }
    return images;
  },

  countImages() {
    const row = countImagesStmt.get();
    return Number(row?.count || 0);
  },

  deleteImage(mbid) {
    return deleteImageStmt.run(mbid);
  },

  clearImages() {
    return clearImagesStmt.run();
  },

  cleanOldImageCache(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return cleanOldImagesStmt.run(cutoff);
  },

  getDeezerMbidCache(cacheKey) {
    const row = getDeezerMbidCacheStmt.get(cacheKey);
    return row?.mbid ?? null;
  },

  setDeezerMbidCache(cacheKey, mbid) {
    setDeezerMbidCacheStmt.run(cacheKey, mbid);
  },

  getMusicbrainzArtistMbidCache(artistNameKey) {
    if (!artistNameKey) return null;
    const row = getMusicbrainzArtistMbidCacheStmt.get(artistNameKey);
    if (!row) return null;
    return {
      mbid: row.mbid || null,
      updatedAt: Number(row.updated_at || 0),
    };
  },

  setMusicbrainzArtistMbidCache(artistNameKey, mbid) {
    if (!artistNameKey) return null;
    const updatedAt = Date.now();
    setMusicbrainzArtistMbidCacheStmt.run(artistNameKey, mbid || null, updatedAt);
    return {
      artistNameKey,
      mbid: mbid || null,
      updatedAt,
    };
  },

  cleanOldMusicbrainzArtistMbidCache(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return cleanOldMusicbrainzArtistMbidCacheStmt.run(cutoff);
  },

  getArtistOverride(mbid) {
    if (!mbid) return null;
    const row = getArtistOverrideStmt.get(mbid);
    if (!row) return null;
    return {
      mbid: row.mbid,
      musicbrainzId: row.musicbrainz_id || null,
      deezerArtistId: row.deezer_artist_id || null,
      updatedAt: row.updated_at || null,
    };
  },

  setArtistOverride(mbid, { musicbrainzId = null, deezerArtistId = null } = {}) {
    if (!mbid) return null;
    const now = Date.now();
    upsertArtistOverrideStmt.run(
      mbid,
      musicbrainzId || null,
      deezerArtistId || null,
      now
    );
    return {
      mbid,
      musicbrainzId: musicbrainzId || null,
      deezerArtistId: deezerArtistId || null,
      updatedAt: now,
    };
  },

  deleteArtistOverride(mbid) {
    if (!mbid) return null;
    return deleteArtistOverrideStmt.run(mbid);
  },

  insertAurralHistory(entry) {
    if (!entry?.id || !entry?.title) return null;
    insertAurralHistoryStmt.run(
      entry.id,
      entry.kind || "activity",
      entry.title,
      entry.subtitle || null,
      entry.status || "completed",
      entry.statusLabel || null,
      entry.href || null,
      dbHelpers.stringifyJSON(entry.metadata),
      Number(entry.createdAt) || Date.now(),
    );
    return entry;
  },

  getAurralHistoryById(id) {
    if (!id) return null;
    const row = getAurralHistoryByIdStmt.get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    };
  },

  getAurralHistory({ since = 0, limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const safeSince = Number(since) || 0;
    return getAurralHistoryStmt.all(safeSince, safeLimit).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    }));
  },

  pruneAurralHistory({ maxAgeMs = 30 * 24 * 60 * 60 * 1000, maxEntries = 1000 } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    deleteAurralHistoryOlderThanStmt.run(cutoff);
    const count = Number(countAurralHistoryStmt.get()?.count || 0);
    const overflow = count - Math.max(1, Number(maxEntries) || 500);
    if (overflow > 0) {
      deleteOldestAurralHistoryStmt.run(overflow);
    }
  },
};
