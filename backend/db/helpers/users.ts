import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { getSettingsEncryptionKey } from "./settings.ts";
import {
  DEFAULT_LISTEN_HISTORY_PROVIDER,
  getListenHistoryProfile,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUsername,
  normalizeListenHistoryUrl,
} from "../../services/listeningHistory.ts";
import type { UsersRow } from "../rows.ts";

export type UserPermissions = Record<string, unknown>;

interface UserUpdate {
  username?: string;
  passwordHash?: string;
  subsonicPassword?: string | null;
  role?: string;
  permissions?: UserPermissions;
  lastfmUsername?: string | null;
  listenHistoryProvider?: string | null;
  listenHistoryUsername?: string | null;
  listenHistoryUrl?: string | null;
  lidarrRootFolderPath?: string | null;
  lidarrQualityProfileId?: number | string | null;
  status?: string;
  roleSource?: string;
  hasLocalPassword?: boolean;
  needsIdentityMigration?: boolean;
  allowIdentityAdoption?: boolean;
}

type UsersListRow = Pick<
  UsersRow,
  | "id"
  | "username"
  | "role"
  | "permissions"
  | "lastfm_username"
  | "listen_history_provider"
  | "listen_history_username"
  | "listen_history_url"
  | "lidarr_root_folder_path"
  | "lidarr_quality_profile_id"
  | "status"
  | "is_protected"
  | "role_source"
  | "has_local_password"
  | "needs_identity_migration"
  | "allow_identity_adoption"
>;

const getUserByUsernameStmt = db.prepare<[string], UsersRow>(
  "SELECT * FROM users WHERE username = ?",
);
const getAllUsersStmt = db.prepare<[], UsersListRow>(
  "SELECT id, username, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id, status, is_protected, role_source, has_local_password, needs_identity_migration, allow_identity_adoption FROM users ORDER BY username",
);
const getUserByIdStmt = db.prepare<[number], UsersRow>("SELECT * FROM users WHERE id = ?");
const getUserAuthByIdStmt = db.prepare<
  [number],
  Pick<
    UsersRow,
    "id" | "username" | "role" | "permissions" | "status" | "is_protected" | "role_source"
  >
>(
  "SELECT id, username, role, permissions, status, is_protected, role_source FROM users WHERE id = ?",
);
const countUsersStmt = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM users");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, subsonic_password, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id, has_local_password, is_protected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, password_hash = ?, subsonic_password = ?, role = ?, permissions = ?, lastfm_username = ?, listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?, lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?, status = ?, role_source = ?, has_local_password = ?, needs_identity_migration = ?, allow_identity_adoption = ? WHERE id = ?",
);
const getSubsonicPasswordByIdStmt = db.prepare<[number], Pick<UsersRow, "subsonic_password">>(
  "SELECT subsonic_password FROM users WHERE id = ?",
);
const updateSubsonicPasswordStmt = db.prepare(
  "UPDATE users SET subsonic_password = ? WHERE id = ?",
);
const setProtectedStmt = db.prepare("UPDATE users SET is_protected = ? WHERE id = ?");
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

const DEFAULT_PERMISSIONS = {
  accessFlow: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
  deleteTrack: false,
};

export type Permission = keyof typeof DEFAULT_PERMISSIONS | "accessSettings";

function encryptSubsonicPassword(password: string | null | undefined) {
  const value = password == null ? "" : String(password);
  return value ? encryptWithKey(value, getSettingsEncryptionKey()) : null;
}

function decryptSubsonicPassword(value: string | null | undefined) {
  if (!value) return null;
  const decrypted = decryptWithKey(value, getSettingsEncryptionKey());
  return decrypted && decrypted !== value ? decrypted : null;
}

function parseStoredPermissions(raw: string | null | undefined): UserPermissions {
  const stored = dbHelpers.parseJSON(raw);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...DEFAULT_PERMISSIONS };
  }
  return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, value === true]));
}

export const userOps = {
  getDefaultPermissions() {
    return { ...DEFAULT_PERMISSIONS };
  },
  getUserByUsername(username: string) {
    const row = getUserByUsernameStmt.get(String(username).trim().toLowerCase());
    if (!row) return null;
    const history = getListenHistoryProfile(row);
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: parseStoredPermissions(row.permissions),
      lidarrRootFolderPath: row.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        row.lidarr_quality_profile_id != null ? Number(row.lidarr_quality_profile_id) : null,
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
      needsIdentityMigration: !!row.needs_identity_migration,
      allowIdentityAdoption: !!row.allow_identity_adoption,
      ...history,
    };
  },
  getUserById(id: number | string | null | undefined) {
    const row = getUserByIdStmt.get(parseInt(String(id), 10));
    if (!row) return null;
    const history = getListenHistoryProfile(row);
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: parseStoredPermissions(row.permissions),
      lidarrRootFolderPath: row.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        row.lidarr_quality_profile_id != null ? Number(row.lidarr_quality_profile_id) : null,
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
      needsIdentityMigration: !!row.needs_identity_migration,
      allowIdentityAdoption: !!row.allow_identity_adoption,
      ...history,
    };
  },
  getUserAuthById(id: number | string) {
    const row = getUserAuthByIdStmt.get(parseInt(String(id), 10));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role || "user",
      permissions: parseStoredPermissions(row.permissions),
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
    };
  },
  getSubsonicPasswordById(id: number | string) {
    const row = getSubsonicPasswordByIdStmt.get(parseInt(String(id), 10));
    return decryptSubsonicPassword(row?.subsonic_password);
  },
  syncSubsonicPassword(id: number | string, password: string | null | undefined) {
    const userId = parseInt(String(id), 10);
    const row = getSubsonicPasswordByIdStmt.get(userId);
    if (!row) return false;
    const current = decryptSubsonicPassword(row.subsonic_password);
    const next = password == null ? "" : String(password);
    if (current === (next || null)) return false;
    updateSubsonicPasswordStmt.run(encryptSubsonicPassword(next), userId);
    return true;
  },
  countUsers() {
    return countUsersStmt.get()!.count;
  },
  getAllUsers() {
    const rows = getAllUsersStmt.all();
    return rows.map((r) => ({
      ...getListenHistoryProfile(r),
      id: r.id,
      username: r.username,
      role: r.role || "user",
      permissions: parseStoredPermissions(r.permissions),
      lidarrRootFolderPath: r.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        r.lidarr_quality_profile_id != null ? Number(r.lidarr_quality_profile_id) : null,
      status: r.status || "active",
      isProtected: !!r.is_protected,
      roleSource: r.role_source || "local",
      hasLocalPassword: !!r.has_local_password,
      needsIdentityMigration: !!r.needs_identity_migration,
      allowIdentityAdoption: !!r.allow_identity_adoption,
    }));
  },
  createUser(
    username: string,
    passwordHash: string,
    role = "user",
    permissions: UserPermissions | null = null,
    hasLocalPassword = true,
    isProtected = false,
    subsonicPassword: string | null = null,
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
        encryptSubsonicPassword(subsonicPassword),
        role,
        dbHelpers.stringifyJSON(perms),
        null,
        null,
        hasLocalPassword ? 1 : 0,
        isProtected ? 1 : 0,
      );
      return {
        id: result.lastInsertRowid as number,
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
  updateUser(id: number | string, data: UserUpdate) {
    const existing = userOps.getUserById(id);
    const existingRow = getUserByIdStmt.get(parseInt(String(id), 10));
    if (!existing || !existingRow) return null;
    const username = data.username !== undefined ? String(data.username).trim() : existing.username;
    const passwordHash =
      data.passwordHash !== undefined ? data.passwordHash : existing.passwordHash;
    const passwordHashChanged =
      data.passwordHash !== undefined && data.passwordHash !== existing.passwordHash;
    const subsonicPassword =
      data.subsonicPassword !== undefined
        ? encryptSubsonicPassword(data.subsonicPassword)
        : passwordHashChanged
          ? null
          : existingRow.subsonic_password || null;
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
      data.listenHistoryUrl !== undefined ? data.listenHistoryUrl : existing.listenHistoryUrl,
    );
    const resolvedUsername = ["koito", "local"].includes(listenHistoryProvider)
      ? null
      : listenHistoryUsername;
    const resolvedUrl = listenHistoryProvider === "koito" ? listenHistoryUrl : null;
    const lastfmUsername = listenHistoryProvider === "lastfm" ? resolvedUsername : null;
    const lidarrRootFolderPath =
      data.lidarrRootFolderPath !== undefined
        ? data.lidarrRootFolderPath
          ? String(data.lidarrRootFolderPath).trim()
          : null
        : existing.lidarrRootFolderPath;
    const parsedLidarrQualityProfileId =
      data.lidarrQualityProfileId !== undefined && data.lidarrQualityProfileId !== null
        ? Number(data.lidarrQualityProfileId)
        : data.lidarrQualityProfileId === null
          ? null
          : existing.lidarrQualityProfileId;
    const lidarrQualityProfileId =
      parsedLidarrQualityProfileId != null && Number.isFinite(parsedLidarrQualityProfileId)
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
        subsonicPassword,
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
        parseInt(String(id), 10),
      );
      return {
        id: parseInt(String(id), 10),
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
  setProtected(id: number | string, isProtected: boolean) {
    try {
      setProtectedStmt.run(isProtected ? 1 : 0, parseInt(String(id), 10));
      return true;
    } catch (e) {
      return false;
    }
  },
  deleteUser(id: number | string) {
    try {
      deleteUserStmt.run(parseInt(String(id), 10));
      return true;
    } catch (e) {
      return false;
    }
  },
};

export type UserRecord = NonNullable<ReturnType<typeof userOps.getUserById>>;
