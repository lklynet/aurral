import { db, dbHelpers } from "../../config/db-sqlite.js";

const SETTINGS_KEY = "jellyfinPlaylistPointers";
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
  const playlistId = raw.playlistId != null ? String(raw.playlistId) : null;
  if (!playlistId) return null;
  return {
    playlistId,
    title: String(raw.title || ""),
    serverUrl: String(raw.serverUrl || ""),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

export const jellyfinPlaylistPointerStore = {
  getPointer(entityId, targetKey) {
    return normalizePointer(readStore()[entityId]?.[targetKey] || null);
  },

  setPointer(entityId, targetKey, { playlistId, title, serverUrl }) {
    const store = readStore();
    if (!store[entityId]) store[entityId] = {};
    store[entityId][targetKey] = {
      playlistId: String(playlistId),
      title: String(title || ""),
      serverUrl: String(serverUrl || ""),
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
};
