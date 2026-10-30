import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { lenient, listOf } from "./storedSchemas.ts";
import type { AurralHistoryRow } from "../rows.ts";

const text = lenient(v.string());
const nullableText = lenient(v.nullable(v.string()));
const count = lenient(v.number());
const nullableCount = lenient(v.nullable(v.number()));

const trackUpgradeSchema = v.looseObject({ fromQuality: v.nullable(v.string()) });

export type TrackUpgrade = v.InferOutput<typeof trackUpgradeSchema>;

const historyMetadataSchema = v.looseObject({
  userId: count,
  username: text,
  jobId: text,
  trackName: nullableText,
  artistName: nullableText,
  albumName: nullableText,
  albumId: lenient(v.nullable(v.union([v.string(), v.number()]))),
  albumMbid: nullableText,
  artistMbid: nullableText,
  canonicalAlbumId: nullableText,
  managedBy: nullableText,
  requestGroupId: nullableText,
  playlistId: nullableText,
  playlistType: nullableText,
  playlistName: nullableText,
  ownerUserId: nullableCount,
  operationId: count,
  trackCount: count,
  downloadSource: nullableText,
  downloadClient: nullableText,
  sourceFilename: nullableText,
  releaseTitle: nullableText,
  sourceType: text,
  albumGrabId: text,
  requestedAt: nullableText,
  completedAt: nullableText,
  actualDownloadSource: nullableText,
  downloadMethod: nullableText,
  previousErrors: lenient(listOf(v.string())),
  trackNumber: nullableCount,
  discNumber: nullableCount,
  queuedTrackCount: count,
  searchedAt: count,
  recommendationCount: count,
  genreCount: count,
  flowId: text,
  tracksQueued: count,
  tracksReused: count,
  reserveTracks: count,
  upgrade: lenient(trackUpgradeSchema),
});

export type AurralHistoryMetadata = v.InferOutput<typeof historyMetadataSchema>;

export interface AurralHistoryEntry {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  status: string;
  statusLabel: string | null;
  href: string | null;
  metadata: AurralHistoryMetadata | null;
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
  deleteAurralHistoryById: (id: string | null) => boolean;
  getAurralHistoryById: (id: string) => (AurralHistoryEntry & { id: string }) | null;
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
const getAurralHistoryStmt = db.prepare<
  [number, number],
  Omit<AurralHistoryRow, "id"> & { id: string }
>(`
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE created_at >= ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const getAurralHistoryByIdStmt = db.prepare<
  [string],
  Omit<AurralHistoryRow, "id"> & { id: string }
>(`
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
      metadata: dbHelpers.readJSON(historyMetadataSchema, row.metadata, "history"),
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
      metadata: dbHelpers.readJSON(historyMetadataSchema, row.metadata, "history"),
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
