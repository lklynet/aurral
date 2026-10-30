import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";

const SETTINGS_KEY = "navidromePlaylistPointers";
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

const pointerStoreSchema = v.record(v.string(), v.record(v.string(), v.unknown()));
const storedPointerSchema = v.looseObject({});

type PointerStore = v.InferOutput<typeof pointerStoreSchema>;

const readStore = () =>
  dbHelpers.readJSON(pointerStoreSchema, getSettingStmt.get(SETTINGS_KEY)?.value, SETTINGS_KEY) ??
  {};

const writeStore = (store: PointerStore) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const normalizePointer = (raw: unknown) => {
  if (!v.is(storedPointerSchema, raw)) return null;
  const playlistId = raw.playlistId != null ? String(raw.playlistId) : null;
  const title = String(raw.title || "");
  if (!playlistId && !title) return null;
  return {
    playlistId,
    title,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

type NavidromePointer = NonNullable<ReturnType<typeof normalizePointer>>;

export const navidromePlaylistPointerStore = {
  getEntityIds() {
    return Object.keys(readStore());
  },

  getPointersForEntity(entityId: string): (NavidromePointer & { targetKey: string })[] {
    return Object.entries(readStore()[entityId] || {})
      .map(([targetKey, raw]) => {
        const pointer = normalizePointer(raw);
        return pointer ? { targetKey, ...pointer } : null;
      })
      .filter((pointer) => pointer !== null);
  },

  getPointer(entityId: string, targetKey: string) {
    return normalizePointer(readStore()[entityId]?.[targetKey] || null);
  },

  setPointer(
    entityId: string,
    targetKey: string,
    { playlistId, title }: { playlistId: string | null; title: string },
  ) {
    const store = readStore();
    if (!store[entityId]) store[entityId] = {};
    store[entityId][targetKey] = {
      playlistId: playlistId != null ? String(playlistId) : null,
      title: String(title || ""),
      updatedAt: Date.now(),
    };
    writeStore(store);
  },

  deletePointer(entityId: string, targetKey: string) {
    const store = readStore();
    if (!store[entityId]?.[targetKey]) return false;
    delete store[entityId][targetKey];
    if (!Object.keys(store[entityId]).length) delete store[entityId];
    writeStore(store);
    return true;
  },

  hasPlaylistId(playlistId: unknown) {
    const expected = String(playlistId);
    return Object.values(readStore()).some((targets) =>
      Object.values(targets || {}).some((raw) => normalizePointer(raw)?.playlistId === expected),
    );
  },
};
