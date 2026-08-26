import { db, dbHelpers } from "../../config/db-sqlite.js";
import {
  DEFAULT_LISTEN_HISTORY_PROVIDER,
  getListenHistoryProfile,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUsername,
  normalizeListenHistoryUrl,
} from "../../services/listeningHistory.js";

const getUserByUsernameStmt = db.prepare(
  "SELECT * FROM users WHERE username = ?"
);
const getAllUsersStmt = db.prepare(
  "SELECT id, username, display_username, name, email, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id FROM users ORDER BY name, email"
);
const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const getUserAuthByIdStmt = db.prepare(
  "SELECT id, username, display_username, name, email, role, permissions FROM users WHERE id = ?"
);
const getCredentialPasswordStmt = db.prepare(
  "SELECT password FROM accounts WHERE user_id = ? AND provider_id = 'credential' LIMIT 1"
);
const updateCredentialPasswordStmt = db.prepare(
  "UPDATE accounts SET password = ?, updated_at = ? WHERE user_id = ? AND provider_id = 'credential'"
);
const countUsersStmt = db.prepare("SELECT COUNT(*) AS count FROM users");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, display_username, name, email, email_verified, created_at, updated_at, password_hash, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)"
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, display_username = ?, name = ?, email = ?, password_hash = ?, role = ?, permissions = ?, lastfm_username = ?, listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?, lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?, updated_at = ? WHERE id = ?"
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
  deleteTrack: false,
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
      name: row.name || row.display_username || row.username,
      email: row.email,
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
  getUserById(id) {
    const row = getUserByIdStmt.get(parseInt(id, 10));
    if (!row) return null;
    const history = getListenHistoryProfile(row);
    return {
      id: row.id,
      username: row.username,
      name: row.name || row.display_username || row.username,
      email: row.email,
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
  getUserAuthById(id) {
    const row = getUserAuthByIdStmt.get(parseInt(id, 10));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      name: row.name || row.display_username || row.username,
      email: row.email,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
    };
  },
  getCredentialPasswordHash(id) {
    return getCredentialPasswordStmt.get(parseInt(id, 10))?.password || null;
  },
  updateCredentialPasswordHash(id, passwordHash) {
    updateCredentialPasswordStmt.run(
      passwordHash,
      new Date().toISOString(),
      parseInt(id, 10),
    );
  },
  countUsers() {
    return countUsersStmt.get().count;
  },
  getAllUsers() {
    const rows = getAllUsersStmt.all();
    return rows.map((r) => ({
      ...getListenHistoryProfile(r),
      id: r.id,
      username: r.username,
      name: r.name || r.display_username || r.username,
      email: r.email,
      role: r.role || "user",
      permissions: dbHelpers.parseJSON(r.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      lidarrRootFolderPath: r.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        r.lidarr_quality_profile_id != null
          ? Number(r.lidarr_quality_profile_id)
          : null,
    }));
  },
  createUser(username, passwordHash, role = "user", permissions = null, identity = {}) {
    const un = String(username).trim();
    if (!un) return null;
    const perms = permissions
      ? { ...DEFAULT_PERMISSIONS, ...permissions }
      : { ...DEFAULT_PERMISSIONS };
    try {
      const now = new Date().toISOString();
      const name = String(identity.name || un).trim();
      const email = String(
        identity.email ||
          (un.includes("@") ? un : `legacy-${Buffer.from(un).toString("hex")}@aurral.invalid`),
      )
        .trim()
        .toLowerCase();
      const result = insertUserStmt.run(
        un.toLowerCase(),
        un,
        name,
        email,
        now,
        now,
        passwordHash,
        role,
        dbHelpers.stringifyJSON(perms),
        null,
        null,
      );
      return {
        id: result.lastInsertRowid,
        username: un,
        name,
        email,
        role,
        permissions: perms,
        listenHistoryProvider: DEFAULT_LISTEN_HISTORY_PROVIDER,
        listenHistoryUsername: null,
        listenHistoryUrl: null,
        lastfmUsername: null,
        lidarrRootFolderPath: null,
        lidarrQualityProfileId: null,
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
    const name = data.name !== undefined ? String(data.name).trim() : existing.name;
    const email = data.email !== undefined
      ? String(data.email).trim().toLowerCase()
      : existing.email;
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
      ["koito", "local"].includes(listenHistoryProvider) ? null : listenHistoryUsername;
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
    try {
      updateUserStmt.run(
        username.toLowerCase(),
        username,
        name,
        email,
        passwordHash,
        role,
        dbHelpers.stringifyJSON(permissions),
        lastfmUsername,
        listenHistoryProvider,
        resolvedUsername,
        resolvedUrl,
        lidarrRootFolderPath,
        lidarrQualityProfileId,
        new Date().toISOString(),
        parseInt(id, 10)
      );
      return {
        id: parseInt(id, 10),
        username,
        name,
        email,
        role,
        permissions,
        listenHistoryProvider,
        listenHistoryUsername: resolvedUsername,
        listenHistoryUrl: resolvedUrl,
        lastfmUsername,
        lidarrRootFolderPath,
        lidarrQualityProfileId,
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
};
