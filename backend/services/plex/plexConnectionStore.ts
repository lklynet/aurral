import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.ts";
import type { SettingsRow } from "../../db/rows.ts";

const SETTINGS_KEY = "plexConnections";
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

type PlexLinkType = "managed" | "self";

const storeSchema = v.record(v.string(), v.unknown());
const storedConnectionSchema = v.looseObject({
  plexAccountId: v.nullish(v.union([v.string(), v.number()])),
});
const lastErrorSchema = v.looseObject({ message: v.unknown(), at: v.optional(v.unknown()) });

type PlexLinkInput = {
  linkType?: PlexLinkType;
  token?: string | null;
  clientId?: string | null;
  plexAccountId?: string | number | null;
  plexUuid?: unknown;
  plexUsername?: unknown;
  linkedByAdminId?: number | null;
};

const readStore = () =>
  dbHelpers.readJSON(storeSchema, getSettingStmt.get(SETTINGS_KEY)?.value, SETTINGS_KEY) ?? {};

const writeStore = (store: v.InferOutput<typeof storeSchema>) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const userKey = (userId: number) => String(Math.trunc(Number(userId)));

const encryptToken = (value: string | null | undefined) => {
  const key = getSettingsEncryptionKey();
  return encryptWithKey(String(value || ""), key);
};

const decryptToken = (value: unknown) => {
  const key = getSettingsEncryptionKey();
  return decryptWithKey(typeof value === "string" ? value : null, key);
};

const normalizeConnection = (raw: unknown) => {
  if (!v.is(storedConnectionSchema, raw)) return null;
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
      v.is(lastErrorSchema, raw.lastError) && raw.lastError.message
        ? {
            message: String(raw.lastError.message),
            at: Number(raw.lastError.at) || Date.now(),
          }
        : null,
  };
};

export const plexConnectionStore = {
  getConnection(userId: number) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)]);
  },

  getPublicStatus(userId: number) {
    const connection = this.getConnection(userId);
    if (!connection) {
      return {
        connected: false,
        linkType: null,
        plexUsername: null,
        connectedAt: null,
        lastError: null,
      };
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
    userId: number,
    {
      linkType,
      token,
      clientId,
      plexAccountId = null,
      plexUuid = null,
      plexUsername = null,
      linkedByAdminId = null,
    }: PlexLinkInput = {},
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
    return this.getConnection(userId)!;
  },

  updateToken(userId: number, { token, clientId }: Pick<PlexLinkInput, "token" | "clientId"> = {}) {
    const current = readStore();
    const key = userKey(userId);
    const existing = current[key];
    if (!v.is(storedConnectionSchema, existing)) return null;
    existing.token = encryptToken(token || decryptToken(existing.token));
    if (clientId) existing.clientId = clientId;
    existing.lastError = null;
    writeStore(current);
    return this.getConnection(userId);
  },

  setLastError(userId: number, message: string | null | undefined) {
    const store = readStore();
    const key = userKey(userId);
    const existing = store[key];
    if (!v.is(storedConnectionSchema, existing)) return null;
    existing.lastError = { message: String(message || "Unknown error"), at: Date.now() };
    writeStore(store);
    return this.getConnection(userId);
  },

  clearConnection(userId: number) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]) return false;
    delete store[key];
    writeStore(store);
    return true;
  },

  getAllLinkedPlexAccountIds() {
    const store = readStore();
    const ids = new Set<string>();
    for (const entry of Object.values(store)) {
      if (v.is(storedConnectionSchema, entry) && entry.plexAccountId != null)
        ids.add(String(entry.plexAccountId));
    }
    return ids;
  },
};
