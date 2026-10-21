import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { AurralHistoryRow } from "../rows.ts";

export interface AurralHistoryEntry {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  status: string;
  statusLabel: string | null;
  href: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface AurralHistoryInput {
  id: string;
  kind?: string;
  title: string;
  subtitle?: string | null;
  status?: string;
  statusLabel?: string | null;
  href?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface AurralHistoryOps {
  insertAurralHistory: (entry: AurralHistoryInput) => AurralHistoryInput | null;
  deleteAurralHistoryById: (id: string) => boolean;
  getAurralHistoryById: (id: string) => AurralHistoryEntry | null;
  getAurralHistory: (options?: { since?: number; limit?: number }) => AurralHistoryEntry[];
  pruneAurralHistory: (options?: { maxAgeMs?: number; maxEntries?: number }) => void;
}

const insertAurralHistoryStmt = db.prepare<
  [
    string,
    string,
    string,
    string | null,
    string,
    string | null,
    string | null,
    string | null,
    number,
  ]
>(`
  INSERT OR REPLACE INTO aurral_history (
    id, kind, title, subtitle, status, status_label, href, metadata, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getAurralHistoryStmt = db.prepare<[number, number], AurralHistoryRow>(`
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE created_at >= ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const getAurralHistoryByIdStmt = db.prepare<[string], AurralHistoryRow>(`
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE id = ?
`);
const deleteAurralHistoryByIdStmt = db.prepare<[string]>("DELETE FROM aurral_history WHERE id = ?");
const deleteAurralHistoryOlderThanStmt = db.prepare<[number]>(
  "DELETE FROM aurral_history WHERE created_at < ?",
);
const countAurralHistoryStmt = db.prepare<[], { count: number }>(
  "SELECT COUNT(*) as count FROM aurral_history",
);
const deleteOldestAurralHistoryStmt = db.prepare<[number]>(`
  DELETE FROM aurral_history
  WHERE id IN (
    SELECT id FROM aurral_history
    ORDER BY created_at ASC
    LIMIT ?
  )
`);

export default function register(dbOps: AurralHistoryOps) {
  dbOps.insertAurralHistory = function (entry) {
    if (!entry?.id || !entry?.title) return null;
    insertAurralHistoryStmt.run(
      entry.id,
      entry.kind || "activity",
      entry.title,
      entry.subtitle || null,
      entry.status || "completed",
      entry.statusLabel || null,
      entry.href || null,
      dbHelpers.stringifyJSON(entry.metadata),
      Number(entry.createdAt) || Date.now(),
    );
    return entry;
  };

  dbOps.deleteAurralHistoryById = function (id) {
    if (!id) return false;
    return deleteAurralHistoryByIdStmt.run(String(id)).changes > 0;
  };

  dbOps.getAurralHistoryById = function (id) {
    if (!id) return null;
    const row = getAurralHistoryByIdStmt.get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    };
  };

  dbOps.getAurralHistory = function ({ since = 0, limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const safeSince = Number(since) || 0;
    return getAurralHistoryStmt.all(safeSince, safeLimit).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    }));
  };

  dbOps.pruneAurralHistory = function ({
    maxAgeMs = 30 * 24 * 60 * 60 * 1000,
    maxEntries = 1000,
  } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    deleteAurralHistoryOlderThanStmt.run(cutoff);
    const count = Number(countAurralHistoryStmt.get()?.count || 0);
    const overflow = count - Math.max(1, Number(maxEntries) || 500);
    if (overflow > 0) {
      deleteOldestAurralHistoryStmt.run(overflow);
    }
  };
}
