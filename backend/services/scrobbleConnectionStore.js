import crypto from "node:crypto";
import { db, dbHelpers } from "../config/db-sqlite.js";
import { decryptWithKey, encryptWithKey } from "../config/encryption.js";

const SETTINGS_KEY = "scrobbleConnections";
const PROVIDERS = new Set(["lastfm", "listenbrainz", "koito"]);
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);
const getEncryptionKey = () => {
  const stored = getSettingStmt.get("_encryptionKey")?.value;
  if (stored) return Buffer.from(stored, "base64");
  const key = crypto.randomBytes(32);
  upsertSettingStmt.run("_encryptionKey", key.toString("base64"));
  return key;
};

const readStore = () => {
  const parsed = dbHelpers.parseJSON(getSettingStmt.get(SETTINGS_KEY)?.value);
  return parsed && typeof parsed === "object" ? parsed : {};
};

const writeStore = (store) => upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
const userKey = (userId) => String(Math.trunc(Number(userId)));
const encryptToken = (token) => encryptWithKey(String(token || ""), getEncryptionKey());
const decryptToken = (token) => decryptWithKey(token, getEncryptionKey());

export const getScrobbleEncryptionKey = getEncryptionKey;

const normalize = (provider, raw) => {
  if (!PROVIDERS.has(provider) || !raw || typeof raw !== "object") return null;
  const token = decryptToken(raw.token);
  if (!token) return null;
  return {
    provider,
    token,
    displayName: String(raw.displayName || "").trim() || null,
    baseUrl: String(raw.baseUrl || "").trim() || null,
    connectedAt: Number(raw.connectedAt) || null,
  };
};

export const scrobbleConnectionStore = {
  getConnection(userId, provider) {
    const connection = normalize(provider, readStore()[userKey(userId)]?.[provider]);
    return connection;
  },

  getConnections(userId) {
    const raw = readStore()[userKey(userId)] || {};
    return Object.fromEntries([...PROVIDERS].map((provider) => {
      const connection = normalize(provider, raw[provider]);
      return connection ? [provider, connection] : null;
    }).filter(Boolean));
  },

  getPublicStatus(userId) {
    return Object.fromEntries([...PROVIDERS].map((provider) => {
      const connection = this.getConnection(userId, provider);
      return [provider, connection
        ? { connected: true, displayName: connection.displayName, connectedAt: connection.connectedAt }
        : { connected: false, displayName: null, connectedAt: null }];
    }));
  },

  saveConnection(userId, provider, { token, displayName = null, baseUrl = null } = {}) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported scrobble provider");
    const safeToken = String(token || "").trim();
    if (!safeToken) throw new Error("Scrobble token is required");
    const store = readStore();
    const key = userKey(userId);
    store[key] = store[key] || {};
    store[key][provider] = {
      token: encryptToken(safeToken),
      displayName: String(displayName || "").trim() || null,
      baseUrl: String(baseUrl || "").trim() || null,
      connectedAt: Date.now(),
    };
    writeStore(store);
    return this.getConnection(userId, provider);
  },

  deleteConnection(userId, provider) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]?.[provider]) return false;
    delete store[key][provider];
    if (Object.keys(store[key]).length === 0) delete store[key];
    writeStore(store);
    return true;
  },
};
