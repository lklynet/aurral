import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import type { LibraryManagementRow } from "../db/rows.ts";

// Aurral manages every artist and album that has an entry.
type ManagementEntry = {
  monitorMode: string | null;
  monitorRules: Record<string, unknown> | null;
  updatedAt: number | null;
};
type EntityKind = "artist" | "album";
type ManagementCache = Record<EntityKind, Map<number, ManagementEntry>>;

const isEntityKind = (kind: string): kind is EntityKind => kind === "artist" || kind === "album";

// Monitoring rules belong to one mode. A write that changes the mode without
// giving rules clears them, so stale rules never come back.
const upsertStmt = db.prepare<Record<string, unknown>>(`
  INSERT INTO library_management
    (entity_kind, entity_id, monitor_mode, monitor_rules, created_at, updated_at)
  VALUES (@kind, @id, @mode, @rules, @now, @now)
  ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
    monitor_mode = excluded.monitor_mode,
    monitor_rules = CASE
      WHEN @rulesGiven = 1 THEN excluded.monitor_rules
      WHEN library_management.monitor_mode IS excluded.monitor_mode
        THEN library_management.monitor_rules
      ELSE NULL
    END,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare<[string, number]>(
  "DELETE FROM library_management WHERE entity_kind = ? AND entity_id = ?",
);

const selectAllStmt = db.prepare<
  [],
  Pick<
    LibraryManagementRow,
    "entity_kind" | "entity_id" | "monitor_mode" | "monitor_rules" | "updated_at"
  >
>("SELECT entity_kind, entity_id, monitor_mode, monitor_rules, updated_at FROM library_management");

const dataVersionStmt = db.prepare<[], { data_version: number }>("PRAGMA data_version");
let cache: ManagementCache | null = null;
let cacheDataVersion: number | null | undefined = null;
let changeListeners: (() => void)[] = [];

function parseRules(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = v.safeParse(v.record(v.string(), v.unknown()), JSON.parse(value));
    return parsed.success ? parsed.output : null;
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

function getCache(): ManagementCache {
  if (cache) refreshExternalChanges();
  if (!cache) {
    cacheDataVersion = dataVersionStmt.get()?.data_version;
    cache = { artist: new Map(), album: new Map() };
    for (const row of selectAllStmt.all()) {
      const map = isEntityKind(row.entity_kind) ? cache[row.entity_kind] : undefined;
      if (map) {
        map.set(row.entity_id, {
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

export function onLibraryManagementChange(listener: () => void) {
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

export function getLibraryManagementEntry(entityKind: string, entityId: unknown) {
  if (!isEntityKind(entityKind)) return null;
  const id = Number(entityId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return getCache()[entityKind].get(id) || null;
}

export function getManagementMap(entityKind: string) {
  if (!isEntityKind(entityKind)) return new Map<number, ManagementEntry>();
  return getCache()[entityKind];
}

export function setLibraryManagement({
  entityKind,
  entityId,
  monitorMode = null,
  monitorRules,
}: {
  entityKind?: string;
  entityId?: unknown;
  monitorMode?: string | null;
  monitorRules?: unknown;
} = {}) {
  const kind = String(entityKind || "").trim();
  const id = Number(entityId);
  if (!isEntityKind(kind)) {
    throw new Error(`Invalid library management entity kind: ${entityKind}`);
  }
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid library management entity id: ${entityId}`);
  }
  const normalizedMonitorMode = monitorMode == null ? null : String(monitorMode).trim() || null;
  const rulesGiven = monitorRules !== undefined;
  upsertStmt.run({
    kind,
    id,
    mode: normalizedMonitorMode,
    rules: rulesGiven && monitorRules ? JSON.stringify(monitorRules) : null,
    rulesGiven: rulesGiven ? 1 : 0,
    now: Date.now(),
  });
  invalidateLibraryManagementCache();
  notifyChanged();
  return getLibraryManagementEntry(kind, id);
}

export function clearLibraryManagement(entityKind: string, entityId: unknown) {
  const kind = String(entityKind || "").trim();
  const id = Number(entityId);
  if (!isEntityKind(kind)) return false;
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const result = clearStmt.run(kind, id);
  if (result.changes > 0) {
    invalidateLibraryManagementCache();
    notifyChanged();
  }
  return result.changes > 0;
}
