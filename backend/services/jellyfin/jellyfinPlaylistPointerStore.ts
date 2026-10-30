import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";

const pointerStoreSchema = v.record(v.string(), v.unknown());
const targetsSchema = v.record(v.string(), v.unknown());
const storedPointerSchema = v.looseObject({});

type PointerStore = v.InferOutput<typeof pointerStoreSchema>;

const targetsOf = (value: unknown): v.InferOutput<typeof targetsSchema> =>
  v.is(targetsSchema, value) ? value : {};

const SETTINGS_KEY = "jellyfinPlaylistPointers";
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

const readStore = () =>
  dbHelpers.readJSON(pointerStoreSchema, getSettingStmt.get(SETTINGS_KEY)?.value, SETTINGS_KEY) ??
  {};

const writeStore = (store: PointerStore) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

/**
 * Copy valid persisted ownership IDs without removing repeated occurrences.
 * Legacy or malformed history becomes empty so it cannot authorize deletions.
 *
 * @param {unknown} ids - Stored ownership history to validate.
 * @returns {string[]} A fresh copy of valid IDs, or an empty array if any value is invalid.
 */
const normalizeManagedIds = (ids: unknown): string[] =>
  Array.isArray(ids) &&
  ids.every((id) => typeof id === "string" && id.length > 0 && id === id.trim())
    ? [...ids]
    : [];

const normalizePointer = (raw: unknown) => {
  if (!v.is(storedPointerSchema, raw)) return null;
  const playlistId = raw.playlistId != null ? String(raw.playlistId) : null;
  if (!playlistId) return null;
  return {
    playlistId,
    title: String(raw.title || ""),
    serverUrl: String(raw.serverUrl || ""),
    jellyfinUserId: raw.jellyfinUserId != null ? String(raw.jellyfinUserId) : null,
    managedItemIds: normalizeManagedIds(raw.managedItemIds),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

export const jellyfinPlaylistPointerStore = {
  getEntityIds() {
    return Object.keys(readStore());
  },

  getPointersForEntity(entityId: string) {
    return Object.entries(targetsOf(readStore()[entityId]))
      .map(([targetKey, raw]) => {
        const pointer = normalizePointer(raw);
        return pointer ? { targetKey, ...pointer } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  },

  getPointer(entityId: string, targetKey: string) {
    return normalizePointer(targetsOf(readStore()[entityId])[targetKey]);
  },

  setPointer(
    entityId: string,
    targetKey: string,
    {
      playlistId,
      title,
      serverUrl,
      jellyfinUserId = null,
      managedItemIds = [],
    }: {
      playlistId: string;
      title: string;
      serverUrl: string | null;
      jellyfinUserId?: string | null;
      managedItemIds?: string[];
    },
  ) {
    const store = readStore();
    const targets = targetsOf(store[entityId]);
    store[entityId] = targets;
    targets[targetKey] = {
      playlistId: String(playlistId),
      title: String(title || ""),
      serverUrl: String(serverUrl || ""),
      updatedAt: Date.now(),
      jellyfinUserId: jellyfinUserId != null ? String(jellyfinUserId) : null,
      managedItemIds: normalizeManagedIds(managedItemIds),
    };
    writeStore(store);
  },

  deletePointer(entityId: string, targetKey: string) {
    const store = readStore();
    const targets = targetsOf(store[entityId]);
    if (!targets[targetKey]) return false;
    delete targets[targetKey];
    if (!Object.keys(targets).length) delete store[entityId];
    writeStore(store);
    return true;
  },
};
