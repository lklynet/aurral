import { db, dbHelpers } from "../../config/db-sqlite.js";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.js";

const SETTINGS_KEY = "spotifyConnections";
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
  const accessToken = decryptToken(raw.accessToken);
  const refreshToken = decryptToken(raw.refreshToken);
  if (!accessToken || !refreshToken) return null;
  const expiresAt = Number(raw.expiresAt);
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    displayName: String(raw.displayName || "").trim() || null,
    connectedAt:
      raw.connectedAt != null && Number.isFinite(Number(raw.connectedAt))
        ? Number(raw.connectedAt)
        : Date.now(),
  };
};

export const spotifyConnectionStore = {
  getConnection(userId) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)] || null);
  },

  getPublicStatus(userId) {
    const connection = this.getConnection(userId);
    if (!connection) {
      return { connected: false, displayName: null, connectedAt: null };
    }
    return {
      connected: true,
      displayName: connection.displayName,
      connectedAt: connection.connectedAt,
    };
  },

  saveConnection(userId, { accessToken, refreshToken, expiresAt, displayName = null } = {}) {
    const safeAccessToken = String(accessToken || "").trim();
    const safeRefreshToken = String(refreshToken || "").trim();
    if (!safeAccessToken || !safeRefreshToken) {
      throw new Error("Spotify tokens are required");
    }
    const store = readStore();
    const now = Date.now();
    const parsedExpiresAt = Number(expiresAt);
    store[userKey(userId)] = {
      accessToken: encryptToken(safeAccessToken),
      refreshToken: encryptToken(safeRefreshToken),
      expiresAt:
        Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0
          ? parsedExpiresAt
          : now + 3600 * 1000,
      displayName: String(displayName || "").trim() || null,
      connectedAt: now,
    };
    writeStore(store);
    return this.getConnection(userId);
  },

  updateTokens(userId, { accessToken, refreshToken, expiresAt } = {}) {
    const current = this.getConnection(userId);
    if (!current) return null;
    return this.saveConnection(userId, {
      accessToken: accessToken || current.accessToken,
      refreshToken: refreshToken || current.refreshToken,
      expiresAt: expiresAt ?? current.expiresAt,
      displayName: current.displayName,
    });
  },

  clearConnection(userId) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]) return false;
    delete store[key];
    writeStore(store);
    return true;
  },

  clearConnectionIfMatches(userId, expected = {}) {
    const store = readStore();
    const key = userKey(userId);
    const current = normalizeConnection(store[key] || null);
    if (
      !current ||
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    delete store[key];
    writeStore(store);
    return true;
  },
};
