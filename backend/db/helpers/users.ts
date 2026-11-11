import crypto from "crypto";
import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { dbOps, getSettingsEncryptionKey } from "./settings.ts";
import type { UsersRow } from "../rows.ts";

export type UserPermissions = Record<string, unknown>;

interface UserUpdate {
  username?: string;
  passwordHash?: string;
  subsonicPassword?: string | null;
  role?: string;
  permissions?: UserPermissions;
  status?: string;
  roleSource?: string;
  hasLocalPassword?: boolean;
}

type UsersListRow = Pick<
  UsersRow,
  | "id"
  | "username"
  | "role"
  | "permissions"
  | "status"
  | "is_protected"
  | "role_source"
  | "has_local_password"
>;

type UserAuthRow = Pick<
  UsersRow,
  "id" | "username" | "role" | "permissions" | "status" | "is_protected" | "role_source"
>;

const getUserByUsernameStmt = db.prepare<[string], UsersRow>(
  "SELECT * FROM users WHERE username = ?",
);
const getAllUsersStmt = db.prepare<[], UsersListRow>(
  "SELECT id, username, role, permissions, status, is_protected, role_source, has_local_password FROM users ORDER BY username",
);
const getUserByIdStmt = db.prepare<[number], UsersRow>("SELECT * FROM users WHERE id = ?");
const getUserAuthByIdStmt = db.prepare<[number], UserAuthRow>(
  "SELECT id, username, role, permissions, status, is_protected, role_source FROM users WHERE id = ?",
);
const countUsersStmt = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM users");
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, subsonic_password, role, permissions, has_local_password, is_protected) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, password_hash = ?, subsonic_password = ?, role = ?, permissions = ?, status = ?, role_source = ?, has_local_password = ? WHERE id = ?",
);
const getSubsonicPasswordByIdStmt = db.prepare<[number], Pick<UsersRow, "subsonic_password">>(
  "SELECT subsonic_password FROM users WHERE id = ?",
);
const updateSubsonicPasswordStmt = db.prepare(
  "UPDATE users SET subsonic_password = ? WHERE id = ?",
);
const getApiKeyByIdStmt = db.prepare<[number], Pick<UsersRow, "api_key">>(
  "SELECT api_key FROM users WHERE id = ?",
);
const updateApiKeyStmt = db.prepare<[string, string, number]>(
  "UPDATE users SET api_key = ?, api_key_hash = ? WHERE id = ?",
);
const getUserAuthByApiKeyHashStmt = db.prepare<[string], UserAuthRow>(
  "SELECT id, username, role, permissions, status, is_protected, role_source FROM users WHERE api_key_hash = ?",
);
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

const DEFAULT_PERMISSIONS = {
  accessPlaylists: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
  deleteTrack: false,
};

export type Permission = keyof typeof DEFAULT_PERMISSIONS | "accessSettings";

function newUserPermissions() {
  const configured = dbOps.getSettings().security.defaultPermissions ?? {};
  return Object.fromEntries(
    Object.entries(DEFAULT_PERMISSIONS).map(([key, value]) => [key, configured[key] ?? value]),
  );
}

function encryptSubsonicPassword(password: string | null | undefined) {
  const value = password == null ? "" : String(password);
  return value ? encryptWithKey(value, getSettingsEncryptionKey()) : null;
}

function decryptSubsonicPassword(value: string | null | undefined) {
  if (!value) return null;
  const decrypted = decryptWithKey(value, getSettingsEncryptionKey());
  return decrypted && decrypted !== value ? decrypted : null;
}

const hashApiKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

function parseStoredPermissions(raw: string | null | undefined): UserPermissions {
  const stored = dbHelpers.readJSON(v.record(v.string(), v.unknown()), raw, "users.permissions");
  if (!stored) return { ...DEFAULT_PERMISSIONS };
  return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, value === true]));
}

function toUserAuth(row: UserAuthRow | undefined) {
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
}

export const userOps = {
  getDefaultPermissions() {
    return { ...DEFAULT_PERMISSIONS };
  },
  getUserByUsername(username: string) {
    const row = getUserByUsernameStmt.get(String(username).trim().toLowerCase());
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: parseStoredPermissions(row.permissions),
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
    };
  },
  getUserById(id: number | string | null | undefined) {
    const row = getUserByIdStmt.get(parseInt(String(id), 10));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role || "user",
      permissions: parseStoredPermissions(row.permissions),
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
      hasLocalPassword: !!row.has_local_password,
    };
  },
  getUserAuthById(id: number | string) {
    return toUserAuth(getUserAuthByIdStmt.get(parseInt(String(id), 10)));
  },
  getUserAuthByApiKey(key: string) {
    return toUserAuth(getUserAuthByApiKeyHashStmt.get(hashApiKey(key)));
  },
  getApiKeyById(id: number) {
    const stored = getApiKeyByIdStmt.get(id)?.api_key;
    if (!stored) return null;
    const decrypted = decryptWithKey(stored, getSettingsEncryptionKey());
    return decrypted && decrypted !== stored ? decrypted : null;
  },
  setApiKey(id: number, key: string) {
    const encrypted = encryptWithKey(key, getSettingsEncryptionKey());
    if (!encrypted) return false;
    return updateApiKeyStmt.run(encrypted, hashApiKey(key), id).changes > 0;
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
      id: r.id,
      username: r.username,
      role: r.role || "user",
      permissions: parseStoredPermissions(r.permissions),
      status: r.status || "active",
      isProtected: !!r.is_protected,
      roleSource: r.role_source || "local",
      hasLocalPassword: !!r.has_local_password,
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
    const perms = { ...newUserPermissions(), ...permissions };
    try {
      const result = insertUserStmt.run(
        un.toLowerCase(),
        passwordHash,
        encryptSubsonicPassword(subsonicPassword),
        role,
        dbHelpers.stringifyJSON(perms),
        hasLocalPassword ? 1 : 0,
        isProtected ? 1 : 0,
      );
      return {
        id: result.lastInsertRowid as number,
        username: un,
        role,
        permissions: perms,
        status: "active",
        isProtected: !!isProtected,
        roleSource: "local",
        hasLocalPassword: !!hasLocalPassword,
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
    const status = data.status !== undefined ? data.status : existing.status;
    const roleSource = data.roleSource !== undefined ? data.roleSource : existing.roleSource;
    const hasLocalPassword =
      data.hasLocalPassword !== undefined ? !!data.hasLocalPassword : existing.hasLocalPassword;
    try {
      updateUserStmt.run(
        username.toLowerCase(),
        passwordHash,
        subsonicPassword,
        role,
        dbHelpers.stringifyJSON(permissions),
        status,
        roleSource,
        hasLocalPassword ? 1 : 0,
        parseInt(String(id), 10),
      );
      return {
        id: parseInt(String(id), 10),
        username,
        role,
        permissions,
        status,
        isProtected: existing.isProtected,
        roleSource,
        hasLocalPassword,
      };
    } catch (e) {
      return null;
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
