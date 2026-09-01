import { db } from "../config/db-sqlite.js";

const LIBRARY_OWNERS = new Set(["aurral", "lidarr"]);
const ENTITY_KINDS = new Set(["artist", "album"]);

const upsertStmt = db.prepare(`
  INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
    managed_by = excluded.managed_by,
    monitor_mode = excluded.monitor_mode,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(
  "DELETE FROM library_management WHERE entity_kind = ? AND entity_id = ?",
);

const selectAllStmt = db.prepare(
  "SELECT entity_kind, entity_id, managed_by, monitor_mode FROM library_management",
);

let cache = null;

function getCache() {
  if (!cache) {
    cache = { artist: new Map(), album: new Map() };
    for (const row of selectAllStmt.all()) {
      const map = cache[row.entity_kind];
      if (map) {
        map.set(row.entity_id, {
          managedBy: row.managed_by,
          monitorMode: row.monitor_mode || null,
        });
      }
    }
  }
  return cache;
}

export function invalidateLibraryManagementCache() {
  cache = null;
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
  const now = Date.now();
  upsertStmt.run(kind, id, owner, normalizedMonitorMode, now, now);
  invalidateLibraryManagementCache();
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
  }
  return result.changes > 0;
}
