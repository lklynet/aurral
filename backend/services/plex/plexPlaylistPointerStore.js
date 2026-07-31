import { db, dbHelpers } from "../../config/db-sqlite.js";

const SETTINGS_KEY = "plexPlaylistPointers";
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

const normalizePointer = (raw) => {
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

export const plexPlaylistPointerStore = {
  getPointer(entityId, targetKey) {
    const store = readStore();
    return normalizePointer(store[entityId]?.[targetKey] || null);
  },

  setPointer(entityId, targetKey, { location, ratingKey, title, description = null }) {
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

  deletePointer(entityId, targetKey) {
    const store = readStore();
    if (!store[entityId]?.[targetKey]) return false;
    delete store[entityId][targetKey];
    if (!Object.keys(store[entityId]).length) delete store[entityId];
    writeStore(store);
    return true;
  },

  getPointersForTarget(targetKey) {
    const store = readStore();
    const results = [];
    for (const [entityId, targets] of Object.entries(store)) {
      const pointer = normalizePointer(targets?.[targetKey]);
      if (pointer) results.push({ entityId, ...pointer });
    }
    return results;
  },

  getPointersForEntity(entityId) {
    const store = readStore();
    return Object.entries(store[entityId] || {}).map(([targetKey, raw]) => {
      const pointer = normalizePointer(raw);
      return pointer ? { targetKey, ...pointer } : null;
    }).filter(Boolean);
  },
};
