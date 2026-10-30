import * as v from "valibot";
import crypto from "node:crypto";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import type { SettingsRow } from "../db/rows.ts";
import { decryptWithKey, encryptWithKey } from "../config/encryption.ts";

const SETTINGS_KEY = "scrobbleConnections";
type ScrobbleProvider = "lastfm" | "listenbrainz" | "koito";
const storeSchema = v.record(v.string(), v.unknown());
const providersSchema = v.record(v.string(), v.unknown());
const storedConnectionSchema = v.looseObject({ token: v.string() });

const providersOf = (value: unknown): v.InferOutput<typeof providersSchema> =>
  v.is(providersSchema, value) ? value : {};

type PublicConnectionStatus = {
  connected: boolean;
  displayName: string | null;
  connectedAt: number | null;
  configured?: boolean;
};

const PROVIDERS = new Set<ScrobbleProvider>(["lastfm", "listenbrainz", "koito"]);
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const insertSettingStmt = db.prepare<[string, string]>(
  "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);
const ensureEncryptionKey = db.transaction(() => {
  const stored = getSettingStmt.get("_encryptionKey")?.value;
  if (!stored) {
    insertSettingStmt.run("_encryptionKey", crypto.randomBytes(32).toString("base64"));
  }
  const persisted = getSettingStmt.get("_encryptionKey")?.value;
  if (!persisted) throw new Error("Scrobble encryption key could not be initialized");
  return Buffer.from(persisted, "base64");
});
const getEncryptionKey = () => {
  const key = ensureEncryptionKey();
  if (key.length !== 32) throw new Error("Scrobble encryption key is invalid");
  return key;
};

const readStore = () =>
  dbHelpers.readJSON(storeSchema, getSettingStmt.get(SETTINGS_KEY)?.value, SETTINGS_KEY) ?? {};

const writeStore = (store: v.InferOutput<typeof storeSchema>) =>
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
const userKey = (userId: number | undefined) => String(Math.trunc(Number(userId)));
const encryptToken = (token: string) => encryptWithKey(String(token || ""), getEncryptionKey());
const decryptToken = (token: string) => decryptWithKey(token, getEncryptionKey());

export const getScrobbleEncryptionKey = getEncryptionKey;

const normalize = (provider: ScrobbleProvider, raw: unknown) => {
  if (!PROVIDERS.has(provider) || !v.is(storedConnectionSchema, raw)) return null;
  const token = decryptToken(raw.token);
  if (!token) return null;
  return {
    provider,
    token,
    connectionRevision: String(raw.connectionRevision || raw.connectedAt || "").trim() || null,
    displayName: String(raw.displayName || "").trim() || null,
    baseUrl: String(raw.baseUrl || "").trim() || null,
    connectedAt: Number(raw.connectedAt) || null,
  };
};

export const scrobbleConnectionStore = {
  getConnection(userId: number | undefined, provider: ScrobbleProvider) {
    const connection = normalize(provider, providersOf(readStore()[userKey(userId)])[provider]);
    return connection;
  },

  getConnections(userId: number) {
    const raw = providersOf(readStore()[userKey(userId)]);
    return Object.fromEntries(
      [...PROVIDERS]
        .map((provider): [ScrobbleProvider, NonNullable<ReturnType<typeof normalize>>] | null => {
          const connection = normalize(provider, raw[provider]);
          return connection ? [provider, connection] : null;
        })
        .filter(Boolean) as [ScrobbleProvider, NonNullable<ReturnType<typeof normalize>>][],
    );
  },

  getPublicStatus(userId: number) {
    const connections = this.getConnections(userId);
    return Object.fromEntries(
      [...PROVIDERS].map((provider): [ScrobbleProvider, PublicConnectionStatus] => {
        const connection = connections[provider];
        return [
          provider,
          connection
            ? {
                connected: true,
                displayName: connection.displayName,
                connectedAt: connection.connectedAt,
              }
            : { connected: false, displayName: null, connectedAt: null },
        ];
      }),
    );
  },

  saveConnection(
    userId: number,
    provider: ScrobbleProvider,
    {
      token,
      displayName = null,
      baseUrl = null,
    }: { token?: string; displayName?: string | null; baseUrl?: string | null } = {},
  ) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported scrobble provider");
    const safeToken = String(token || "").trim();
    if (!safeToken) throw new Error("Scrobble token is required");
    const store = readStore();
    const key = userKey(userId);
    const providers = providersOf(store[key]);
    store[key] = providers;
    providers[provider] = {
      token: encryptToken(safeToken)!,
      connectionRevision: crypto.randomUUID(),
      displayName: String(displayName || "").trim() || null,
      baseUrl: String(baseUrl || "").trim() || null,
      connectedAt: Date.now(),
    };
    writeStore(store);
    return this.getConnection(userId, provider);
  },

  deleteConnection(userId: number, provider: ScrobbleProvider) {
    const store = readStore();
    const key = userKey(userId);
    const providers = providersOf(store[key]);
    if (!providers[provider]) return false;
    delete providers[provider];
    if (Object.keys(providers).length === 0) delete store[key];
    writeStore(store);
    return true;
  },
};
