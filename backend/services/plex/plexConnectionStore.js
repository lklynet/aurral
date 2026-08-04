import { db, dbHelpers } from "../../config/db-sqlite.js";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.js";

const SETTINGS_KEY = "plexConnections";
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

const readStore = () => {
  const parsed = dbHelpers.parseJSON(getSettingStmt.get(SETTINGS_KEY)?.value);
  return parsed && typeof parsed === "object" ? parsed : {};
};

const writeStore = (store) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const userKey = (userId) => String(Math.trunc(Number(userId)));

const encryptToken = (value) => {
  const key = getSettingsEncryptionKey();
  return encryptWithKey(String(value || ""), key);
};

const decryptToken = (value) => {
  const key = getSettingsEncryptionKey();
  return decryptWithKey(value, key);
};

const normalizeConnection = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const token = decryptToken(raw.token);
  const clientId = String(raw.clientId || "").trim();
  if (!token || !clientId) return null;
  const linkType = raw.linkType === "managed" ? "managed" : "self";
  return {
    linkType,
    token,
    clientId,
    plexAccountId: raw.plexAccountId ?? null,
    plexUuid: raw.plexUuid || null,
    plexUsername: raw.plexUsername || null,
    linkedByAdminId:
      raw.linkedByAdminId != null && Number.isFinite(Number(raw.linkedByAdminId))
        ? Number(raw.linkedByAdminId)
        : null,
    connectedAt:
      raw.connectedAt != null && Number.isFinite(Number(raw.connectedAt))
        ? Number(raw.connectedAt)
        : Date.now(),
    lastError:
      raw.lastError && typeof raw.lastError === "object" && raw.lastError.message
        ? {
            message: String(raw.lastError.message),
            at: Number(raw.lastError.at) || Date.now(),
          }
        : null,
  };
};

export const plexConnectionStore = {
  getConnection(userId) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)] || null);
  },

  getPublicStatus(userId) {
    const connection = this.getConnection(userId);
    if (!connection) {
      return { connected: false, linkType: null, plexUsername: null, connectedAt: null, lastError: null };
    }
    return {
      connected: true,
      linkType: connection.linkType,
      plexUsername: connection.plexUsername,
      connectedAt: connection.connectedAt,
      lastError: connection.lastError,
    };
  },

  saveConnection(
    userId,
    {
      linkType,
      token,
      clientId,
      plexAccountId = null,
      plexUuid = null,
      plexUsername = null,
      linkedByAdminId = null,
    } = {},
  ) {
    const safeToken = String(token || "").trim();
    const safeClientId = String(clientId || "").trim();
    if (!safeToken || !safeClientId) {
      throw new Error("Plex token and clientId are required");
    }
    if (linkType !== "managed" && linkType !== "self") {
      throw new Error('linkType must be "managed" or "self"');
    }
    const store = readStore();
    store[userKey(userId)] = {
      linkType,
      token: encryptToken(safeToken),
      clientId: safeClientId,
      plexAccountId,
      plexUuid,
      plexUsername,
      linkedByAdminId:
        linkedByAdminId != null && Number.isFinite(Number(linkedByAdminId))
          ? Number(linkedByAdminId)
          : null,
      connectedAt: Date.now(),
      lastError: null,
    };
    writeStore(store);
    return this.getConnection(userId);
  },

  updateToken(userId, { token, clientId } = {}) {
    const current = readStore();
    const key = userKey(userId);
    const existing = current[key];
    if (!existing) return null;
    existing.token = encryptToken(token || decryptToken(existing.token));
    if (clientId) existing.clientId = clientId;
    existing.lastError = null;
    writeStore(current);
    return this.getConnection(userId);
  },

  setLastError(userId, message) {
    const store = readStore();
    const key = userKey(userId);
    const existing = store[key];
    if (!existing) return null;
    existing.lastError = { message: String(message || "Unknown error"), at: Date.now() };
    writeStore(store);
    return this.getConnection(userId);
  },

  clearConnection(userId) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]) return false;
    delete store[key];
    writeStore(store);
    return true;
  },

  getAllLinkedPlexAccountIds() {
    const store = readStore();
    const ids = new Set();
    for (const entry of Object.values(store)) {
      if (entry?.plexAccountId != null) ids.add(String(entry.plexAccountId));
    }
    return ids;
  },
};
