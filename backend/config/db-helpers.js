import crypto from "crypto";
import { db, dbHelpers } from "./db-sqlite.js";
import { decryptIntegrations, encryptIntegrations } from "./encryption.js";

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
);

const getDiscoveryCacheStmt = db.prepare(
  "SELECT value, last_updated FROM discovery_cache WHERE key = ?"
);
const getDiscoveryCacheLastUpdatedStmt = db.prepare(
  "SELECT last_updated FROM discovery_cache ORDER BY last_updated DESC LIMIT 1"
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

const getUserByUsernameStmt = db.prepare(
  "SELECT * FROM users WHERE username = ?"
);
const getAllUsersStmt = db.prepare(
  "SELECT id, username, role, permissions FROM users ORDER BY username"
);
const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)"
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, password_hash = ?, role = ?, permissions = ? WHERE id = ?"
);
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

const DEFAULT_PERMISSIONS = {
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
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
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
    };
  },
  getUserById(id) {
    const row = getUserByIdStmt.get(parseInt(id, 10));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
    };
  },
  getAllUsers() {
    const rows = getAllUsersStmt.all();
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role || "user",
      permissions: dbHelpers.parseJSON(r.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
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
        dbHelpers.stringifyJSON(perms)
      );
      return {
        id: result.lastInsertRowid,
        username: un,
        role,
        permissions: perms,
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
    try {
      updateUserStmt.run(
        username.toLowerCase(),
        passwordHash,
        role,
        dbHelpers.stringifyJSON(permissions),
        parseInt(id, 10)
      );
      return { id: parseInt(id, 10), username, role, permissions };
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
    const rootFolderPath = getSettingStmt.get("rootFolderPath")?.value;
    const releaseTypes = dbHelpers.parseJSON(
      getSettingStmt.get("releaseTypes")?.value
    );
    const weeklyFlowPlaylists = dbHelpers.parseJSON(
      getSettingStmt.get("weeklyFlowPlaylists")?.value
    );
    const weeklyFlows = dbHelpers.parseJSON(
      getSettingStmt.get("weeklyFlows")?.value
    );
    const sharedFlowPlaylists = dbHelpers.parseJSON(
      getSettingStmt.get("sharedFlowPlaylists")?.value
    );
    const weeklyFlowWorker = dbHelpers.parseJSON(
      getSettingStmt.get("weeklyFlowWorker")?.value
    );
    const onboardingComplete =
      getSettingStmt.get("onboardingComplete")?.value === "true";
    const parsedConcurrency = Number(weeklyFlowWorker?.concurrency);
    const concurrency =
      Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
        ? Math.min(3, Math.floor(parsedConcurrency))
        : 3;
    const preferredFormat =
      String(weeklyFlowWorker?.preferredFormat || "").toLowerCase() === "mp3"
        ? "mp3"
        : "flac";
    const preferredFormatStrict = weeklyFlowWorker?.preferredFormatStrict === true;
    const parsedRetryCycleMinutes = Number(weeklyFlowWorker?.retryCycleMinutes);
    const retryCycleMinutes =
      Number.isFinite(parsedRetryCycleMinutes) &&
      [15, 30, 60, 360, 720, 1440].includes(
        Math.floor(parsedRetryCycleMinutes),
      )
        ? Math.floor(parsedRetryCycleMinutes)
        : 15;
    const retryPausedPlaylistIds = Array.isArray(
      weeklyFlowWorker?.retryPausedPlaylistIds,
    )
      ? [...new Set(
          weeklyFlowWorker.retryPausedPlaylistIds
            .map((entry) => String(entry || "").trim())
            .filter(Boolean),
        )]
      : [];

    const defaultFlowPlaylists = {
      discover: { enabled: false, nextRunAt: null },
      mix: { enabled: false, nextRunAt: null },
      trending: { enabled: false, nextRunAt: null },
    };
    const merged = weeklyFlowPlaylists
      ? { ...defaultFlowPlaylists, ...weeklyFlowPlaylists }
      : defaultFlowPlaylists;
    if (merged.recommended) {
      merged.discover = {
        ...defaultFlowPlaylists.discover,
        ...merged.discover,
        ...merged.recommended,
      };
    }
    delete merged.recommended;

    const result = {
      integrations: decryptIntegrations(integrations, encKey) || {},
      quality: quality || "standard",
      queueCleaner: queueCleaner || {},
      rootFolderPath: rootFolderPath || null,
      releaseTypes: releaseTypes || [],
      weeklyFlowPlaylists: merged,
      weeklyFlows: weeklyFlows || null,
      sharedFlowPlaylists: sharedFlowPlaylists || null,
      weeklyFlowWorker: {
        concurrency,
        preferredFormat,
        preferredFormatStrict,
        retryCycleMinutes,
        retryPausedPlaylistIds,
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
        upsertSettingStmt.run(
          "integrations",
          dbHelpers.stringifyJSON(
            encryptIntegrations(settings.integrations, encKey)
          )
        );
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
      if (
        settings.rootFolderPath !== undefined &&
        settings.rootFolderPath !== null
      ) {
        upsertSettingStmt.run("rootFolderPath", settings.rootFolderPath);
      }
      if (settings.releaseTypes) {
        upsertSettingStmt.run(
          "releaseTypes",
          dbHelpers.stringifyJSON(settings.releaseTypes)
        );
      }
      if (settings.weeklyFlowPlaylists !== undefined) {
        upsertSettingStmt.run(
          "weeklyFlowPlaylists",
          dbHelpers.stringifyJSON(settings.weeklyFlowPlaylists)
        );
      }
      if (settings.weeklyFlows !== undefined) {
        upsertSettingStmt.run(
          "weeklyFlows",
          dbHelpers.stringifyJSON(settings.weeklyFlows)
        );
      }
      if (settings.sharedFlowPlaylists !== undefined) {
        upsertSettingStmt.run(
          "sharedFlowPlaylists",
          dbHelpers.stringifyJSON(settings.sharedFlowPlaylists)
        );
      }
      if (settings.weeklyFlowWorker !== undefined) {
        upsertSettingStmt.run(
          "weeklyFlowWorker",
          dbHelpers.stringifyJSON(settings.weeklyFlowWorker)
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

  getDiscoveryCache() {
    const recommendations = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get("recommendations")?.value
    );
    const globalTop = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get("globalTop")?.value
    );
    const basedOn = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get("basedOn")?.value
    );
    const topTags = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get("topTags")?.value
    );
    const topGenres = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get("topGenres")?.value
    );
    const lastUpdated = getDiscoveryCacheLastUpdatedStmt.get()?.last_updated;

    return {
      recommendations: recommendations || [],
      globalTop: globalTop || [],
      basedOn: basedOn || [],
      topTags: topTags || [],
      topGenres: topGenres || [],
      lastUpdated,
    };
  },

  updateDiscoveryCache(discovery) {
    const now = new Date().toISOString();
    const updateFn = db.transaction(() => {
      if (discovery.recommendations) {
        upsertDiscoveryCacheStmt.run(
          "recommendations",
          dbHelpers.stringifyJSON(discovery.recommendations),
          now
        );
      }
      if (discovery.globalTop) {
        upsertDiscoveryCacheStmt.run(
          "globalTop",
          dbHelpers.stringifyJSON(discovery.globalTop),
          now
        );
      }
      if (discovery.basedOn) {
        upsertDiscoveryCacheStmt.run(
          "basedOn",
          dbHelpers.stringifyJSON(discovery.basedOn),
          now
        );
      }
      if (discovery.topTags) {
        upsertDiscoveryCacheStmt.run(
          "topTags",
          dbHelpers.stringifyJSON(discovery.topTags),
          now
        );
      }
      if (discovery.topGenres) {
        upsertDiscoveryCacheStmt.run(
          "topGenres",
          dbHelpers.stringifyJSON(discovery.topGenres),
          now
        );
      }
    });
    updateFn();
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
};
