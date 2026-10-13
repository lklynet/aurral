import { db } from "../config/db-sqlite.js";

const LIBRARY_OWNERS = new Set(["aurral", "lidarr"]);
const ENTITY_KINDS = new Set(["artist", "album"]);

// Monitoring rules belong to one manager and mode. A write that changes either
// without giving rules clears them, so stale rules never come back.
const upsertStmt = db.prepare(`
  INSERT INTO library_management
    (entity_kind, entity_id, managed_by, monitor_mode, monitor_rules, created_at, updated_at)
  VALUES (@kind, @id, @owner, @mode, @rules, @now, @now)
  ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
    managed_by = excluded.managed_by,
    monitor_mode = excluded.monitor_mode,
    monitor_rules = CASE
      WHEN @rulesGiven = 1 THEN excluded.monitor_rules
      WHEN library_management.managed_by = excluded.managed_by
        AND library_management.monitor_mode IS excluded.monitor_mode
        THEN library_management.monitor_rules
      ELSE NULL
    END,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(
  "DELETE FROM library_management WHERE entity_kind = ? AND entity_id = ?",
);

const selectAllStmt = db.prepare(
  "SELECT entity_kind, entity_id, managed_by, monitor_mode, monitor_rules, updated_at FROM library_management",
);

const dataVersionStmt = db.prepare("PRAGMA data_version");
let cache = null;
let cacheDataVersion = null;
let changeListeners = [];

function parseRules(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function refreshExternalChanges() {
  const dataVersion = dataVersionStmt.get()?.data_version;
  if (dataVersion === cacheDataVersion) return;
  cacheDataVersion = dataVersion;
  cache = null;
  notifyChanged();
}

function getCache() {
  if (cache) refreshExternalChanges();
  if (!cache) {
    cacheDataVersion = dataVersionStmt.get()?.data_version;
    cache = { artist: new Map(), album: new Map() };
    for (const row of selectAllStmt.all()) {
      const map = cache[row.entity_kind];
      if (map) {
        map.set(row.entity_id, {
          managedBy: row.managed_by,
          monitorMode: row.monitor_mode || null,
          monitorRules: parseRules(row.monitor_rules),
          updatedAt: row.updated_at || null,
        });
      }
    }
  }
  return cache;
}

export function refreshLibraryManagementCache() {
  getCache();
}

export function onLibraryManagementChange(listener) {
  if (typeof listener === "function") {
    changeListeners.push(listener);
  }
}

function notifyChanged() {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {}
  }
}

export function invalidateLibraryManagementCache() {
  cache = null;
}

export function notifyLibraryManagementChanged() {
  invalidateLibraryManagementCache();
  notifyChanged();
}

export function getLibraryManagementEntry(entityKind, entityId) {
  if (!ENTITY_KINDS.has(entityKind)) return null;
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return getCache()[entityKind].get(id) || null;
}

export function getManagedBy(entityKind, entityId) {
  return getLibraryManagementEntry(entityKind, entityId)?.managedBy ?? null;
}

export function getManagedByMaps() {
  const snapshot = getCache();
  return {
    artist: new Map(snapshot.artist),
    album: new Map(snapshot.album),
  };
}

export function getManagedByMap(entityKind) {
  if (!ENTITY_KINDS.has(entityKind)) return new Map();
  return getCache()[entityKind];
}

export function setLibraryManagement({
  entityKind,
  entityId,
  managedBy,
  monitorMode = null,
  monitorRules,
} = {}) {
  const kind = String(entityKind || "").trim();
  const id = Number(entityId);
  const owner = String(managedBy || "").trim().toLowerCase();
  if (!ENTITY_KINDS.has(kind)) {
    throw new Error(`Invalid library management entity kind: ${entityKind}`);
  }
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid library management entity id: ${entityId}`);
  }
  if (!LIBRARY_OWNERS.has(owner)) {
    throw new Error(`Invalid library manager: ${managedBy}`);
  }
  const normalizedMonitorMode = monitorMode == null
    ? null
    : String(monitorMode).trim() || null;
  const rulesGiven = monitorRules !== undefined;
  upsertStmt.run({
    kind,
    id,
    owner,
    mode: normalizedMonitorMode,
    rules: rulesGiven && monitorRules ? JSON.stringify(monitorRules) : null,
    rulesGiven: rulesGiven ? 1 : 0,
    now: Date.now(),
  });
  invalidateLibraryManagementCache();
  notifyChanged();
  return getLibraryManagementEntry(kind, id);
}

export function clearLibraryManagement(entityKind, entityId) {
  const kind = String(entityKind || "").trim();
  const id = Number(entityId);
  if (!ENTITY_KINDS.has(kind)) return false;
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const result = clearStmt.run(kind, id);
  if (result.changes > 0) {
    invalidateLibraryManagementCache();
    notifyChanged();
  }
  return result.changes > 0;
}
