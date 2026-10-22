import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";

const SETTINGS_KEY = "plexPlaylistPointers";
const getSettingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const upsertSettingStmt = db.prepare<[string, string | null]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

type StoredPointer = {
  location?: unknown;
  ratingKey?: unknown;
  title?: unknown;
  description?: unknown;
  updatedAt?: unknown;
};

type PointerStore = Record<string, Record<string, StoredPointer>>;

const readStore = (): PointerStore => {
  const parsed = dbHelpers.parseJSON(getSettingStmt.get(SETTINGS_KEY)?.value);
  return parsed && typeof parsed === "object" ? parsed : {};
};

const writeStore = (store: PointerStore) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const normalizePointer = (raw: StoredPointer | null | undefined) => {
  if (!raw || typeof raw !== "object") return null;
  const ratingKey = raw.ratingKey != null ? String(raw.ratingKey) : null;
  const location = String(raw.location || "").trim();
  if (!ratingKey || !location) return null;
  return {
    location,
    ratingKey,
    title: String(raw.title || ""),
    description: raw.description != null ? String(raw.description) : null,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

type PlexPointer = NonNullable<ReturnType<typeof normalizePointer>>;

export const plexPlaylistPointerStore = {
  getPointer(entityId: string, targetKey: string) {
    const store = readStore();
    return normalizePointer(store[entityId]?.[targetKey] || null);
  },

  setPointer(
    entityId: string,
    targetKey: string,
    {
      location,
      ratingKey,
      title,
      description = null,
    }: { location: string; ratingKey: string | number; title: string; description?: string | null },
  ) {
    const store = readStore();
    if (!store[entityId]) store[entityId] = {};
    store[entityId][targetKey] = {
      location: String(location || ""),
      ratingKey: String(ratingKey),
      title: String(title || ""),
      description: description != null ? String(description) : null,
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

  getPointersForTarget(targetKey: string) {
    const store = readStore();
    const results = [];
    for (const [entityId, targets] of Object.entries(store)) {
      const pointer = normalizePointer(targets?.[targetKey]);
      if (pointer) results.push({ entityId, ...pointer });
    }
    return results;
  },

  getEntityIds() {
    return Object.keys(readStore());
  },

  getPointersForEntity(entityId: string): (PlexPointer & { targetKey: string })[] {
    const store = readStore();
    return Object.entries(store[entityId] || {})
      .map(([targetKey, raw]) => {
        const pointer = normalizePointer(raw);
        return pointer ? { targetKey, ...pointer } : null;
      })
      .filter((pointer) => pointer !== null);
  },
};
