import * as v from "valibot";
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

const storeSchema = v.record(v.string(), v.unknown());
const storedConnectionSchema = v.looseObject({});

interface SpotifyConnectionInput {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  displayName?: string | null;
  reconnectRequired?: boolean;
}

const readStore = () =>
  dbHelpers.readJSON(storeSchema, getSettingStmt.get(SETTINGS_KEY)?.value, SETTINGS_KEY) ?? {};

const writeStore = (store: v.InferOutput<typeof storeSchema>) => {
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

const normalizeConnection = (raw: unknown) => {
  if (!v.is(storedConnectionSchema, raw)) return null;
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
    reconnectRequired: raw.reconnectRequired === true,
  };
};

export type SpotifyConnection = NonNullable<ReturnType<typeof normalizeConnection>>;

type SpotifyTokens = Partial<Pick<SpotifyConnection, "accessToken" | "refreshToken">>;

const matchesTokens = (
  connection: SpotifyConnection | null,
  expected: SpotifyTokens,
): connection is SpotifyConnection =>
  connection != null &&
  connection.accessToken === expected.accessToken &&
  connection.refreshToken === expected.refreshToken;

export const spotifyConnectionStore = {
  getConnection(userId: number | undefined) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)]);
  },

  getPublicStatus(userId: number) {
    const connection = this.getConnection(userId);
    if (!connection || connection.reconnectRequired) {
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
    {
      accessToken,
      refreshToken,
      expiresAt,
      displayName = null,
      reconnectRequired = false,
    }: SpotifyConnectionInput = {},
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
      reconnectRequired,
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
      reconnectRequired: current.reconnectRequired,
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

  clearConnectionIfMatches(userId: number | undefined, expected: SpotifyTokens) {
    const store = readStore();
    const key = userKey(userId);
    if (!matchesTokens(normalizeConnection(store[key]), expected)) return false;
    delete store[key];
    writeStore(store);
    return true;
  },

  setReconnectRequired(
    userId: number | undefined,
    expected: SpotifyTokens,
    reconnectRequired: boolean,
  ) {
    const store = readStore();
    const key = userKey(userId);
    const stored = store[key];
    const current = normalizeConnection(stored);
    if (
      !v.is(storedConnectionSchema, stored) ||
      !matchesTokens(current, expected) ||
      current.reconnectRequired === reconnectRequired
    ) {
      return false;
    }
    store[key] = { ...stored, reconnectRequired };
    writeStore(store);
    return true;
  },
};
