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
  "SELECT id, username, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id, status, is_protected, role_source, has_local_password, needs_identity_migration, allow_identity_adoption FROM users ORDER BY username"
);
const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const getUserAuthByIdStmt = db.prepare(
  "SELECT id, username, role, permissions, status, is_protected, role_source FROM users WHERE id = ?"
);
const countUsersStmt = db.prepare("SELECT COUNT(*) AS count FROM users");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id, has_local_password, is_protected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, password_hash = ?, role = ?, permissions = ?, lastfm_username = ?, listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?, lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?, status = ?, role_source = ?, has_local_password = ?, needs_identity_migration = ?, allow_identity_adoption = ? WHERE id = ?"
);
const setProtectedStmt = db.prepare("UPDATE users SET is_protected = ? WHERE id = ?");
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
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
      needsIdentityMigration: !!row.needs_identity_migration,
      allowIdentityAdoption: !!row.allow_identity_adoption,
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
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
      needsIdentityMigration: !!row.needs_identity_migration,
      allowIdentityAdoption: !!row.allow_identity_adoption,
      ...history,
    };
  },
  getUserAuthById(id) {
    const row = getUserAuthByIdStmt.get(parseInt(id, 10));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
    };
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
      role: r.role || "user",
      permissions: dbHelpers.parseJSON(r.permissions) || {
        ...DEFAULT_PERMISSIONS,
      },
      lidarrRootFolderPath: r.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        r.lidarr_quality_profile_id != null
          ? Number(r.lidarr_quality_profile_id)
          : null,
      status: r.status || "active",
      isProtected: !!r.is_protected,
      roleSource: r.role_source || "local",
      hasLocalPassword: !!r.has_local_password,
      needsIdentityMigration: !!r.needs_identity_migration,
      allowIdentityAdoption: !!r.allow_identity_adoption,
    }));
  },
  createUser(
    username,
    passwordHash,
    role = "user",
    permissions = null,
    hasLocalPassword = true,
    isProtected = false,
  ) {
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
        hasLocalPassword ? 1 : 0,
        isProtected ? 1 : 0,
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
        status: "active",
        isProtected: !!isProtected,
        roleSource: "local",
        hasLocalPassword: !!hasLocalPassword,
        needsIdentityMigration: false,
        allowIdentityAdoption: false,
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
    const status = data.status !== undefined ? data.status : existing.status;
    const roleSource = data.roleSource !== undefined ? data.roleSource : existing.roleSource;
    const hasLocalPassword =
      data.hasLocalPassword !== undefined ? !!data.hasLocalPassword : existing.hasLocalPassword;
    const needsIdentityMigration =
      data.needsIdentityMigration !== undefined
        ? !!data.needsIdentityMigration
        : existing.needsIdentityMigration;
    const allowIdentityAdoption =
      data.allowIdentityAdoption !== undefined
        ? !!data.allowIdentityAdoption
        : existing.allowIdentityAdoption;
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
        status,
        roleSource,
        hasLocalPassword ? 1 : 0,
        needsIdentityMigration ? 1 : 0,
        allowIdentityAdoption ? 1 : 0,
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
        status,
        isProtected: existing.isProtected,
        roleSource,
        hasLocalPassword,
        needsIdentityMigration,
        allowIdentityAdoption,
      };
    } catch (e) {
      return null;
    }
  },
  setProtected(id, isProtected) {
    try {
      setProtectedStmt.run(isProtected ? 1 : 0, parseInt(id, 10));
      return true;
    } catch (e) {
      return false;
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
