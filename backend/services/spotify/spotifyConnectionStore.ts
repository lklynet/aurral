import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.ts";
import type { SettingsRow } from "../../db/rows.ts";

const SETTINGS_KEY = "spotifyConnections";
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

interface StoredSpotifyConnection {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  displayName?: unknown;
  connectedAt?: unknown;
}

type StoredSpotifyConnections = Record<string, StoredSpotifyConnection>;

interface SpotifyConnectionInput {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  displayName?: string | null;
}

const readStore = (): StoredSpotifyConnections => {
  const parsed = dbHelpers.parseJSON(getSettingStmt.get(SETTINGS_KEY)?.value);
  return parsed && typeof parsed === "object" ? parsed : {};
};

const writeStore = (store: StoredSpotifyConnections) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const userKey = (userId: number | undefined) => String(Math.trunc(Number(userId)));

const encryptToken = (value: string) => {
  const key = getSettingsEncryptionKey();
  return encryptWithKey(String(value || ""), key)!;
};

const decryptToken = (value: unknown) => {
  const key = getSettingsEncryptionKey();
  return decryptWithKey(typeof value === "string" ? value : null, key);
};

const normalizeConnection = (raw: StoredSpotifyConnection | null) => {
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

export type SpotifyConnection = NonNullable<ReturnType<typeof normalizeConnection>>;

export const spotifyConnectionStore = {
  getConnection(userId: number | undefined) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)] || null);
  },

  getPublicStatus(userId: number) {
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

  saveConnection(
    userId: number | undefined,
    { accessToken, refreshToken, expiresAt, displayName = null }: SpotifyConnectionInput = {},
  ) {
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

  updateTokens(
    userId: number | undefined,
    { accessToken, refreshToken, expiresAt }: SpotifyConnectionInput = {},
  ) {
    const current = this.getConnection(userId);
    if (!current) return null;
    return this.saveConnection(userId, {
      accessToken: accessToken || current.accessToken,
      refreshToken: refreshToken || current.refreshToken,
      expiresAt: expiresAt ?? current.expiresAt,
      displayName: current.displayName,
    });
  },

  clearConnection(userId: number) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]) return false;
    delete store[key];
    writeStore(store);
    return true;
  },

  clearConnectionIfMatches(
    userId: number | undefined,
    expected: Partial<Pick<SpotifyConnection, "accessToken" | "refreshToken">> = {},
  ) {
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
