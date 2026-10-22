import { db } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { getHonkerDb, getPlaylistOperationQueue } from "../honkerDb.ts";
import type { StaticPlaylistRemovalOutcome, StaticPlaylistSelection } from "./trackRemoval.ts";

const PREFIX = "playlistBulkOperation:";
const RETENTION_MS = 7 * 86400000;
const getStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const saveStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const deleteStmt = db.prepare("DELETE FROM settings WHERE key = ?");
const listStmt = db.prepare<[], Pick<SettingsRow, "value"> & { key: string }>(
  "SELECT key, value FROM settings WHERE key LIKE 'playlistBulkOperation:%'",
);

export interface BulkOperationTarget {
  playlistId: string;
  name?: string;
  create?: boolean;
}

export interface BulkOperationOutcome extends Omit<StaticPlaylistRemovalOutcome, "status"> {
  status: StaticPlaylistRemovalOutcome["status"] | "moved";
  targetPlaylistId?: string;
}

interface BulkOperationBase {
  operationId: number;
  ownerUserId: number;
  sourcePlaylistId: string;
  selections: StaticPlaylistSelection[];
  state: "queued" | "running" | "completed" | "failed";
  outcomes: BulkOperationOutcome[];
  synchronization: Record<string, boolean>;
  createdAt: number;
  updatedAt: number;
  message?: string;
  scanScheduled?: boolean;
}

export type BulkOperationRecord = BulkOperationBase &
  ({ action: "move"; target: BulkOperationTarget } | { action: "remove"; target: null });

export type BulkOperationInput = Pick<
  BulkOperationBase,
  "ownerUserId" | "sourcePlaylistId" | "selections"
> & {
  action: BulkOperationRecord["action"];
  target: BulkOperationRecord["target"] | null;
};

export function getBulkOperation(operationId: unknown) {
  const row = getStmt.get(`${PREFIX}${operationId}`);
  if (!row) return null;
  const record: BulkOperationRecord = JSON.parse(row.value);
  if (
    !["completed", "failed"].includes(record.state) &&
    !getHonkerDb().query(
      "SELECT state FROM _honker_live WHERE id = ? AND queue = 'weekly-flow-operation'",
      [record.operationId],
    ).length
  ) {
    record.state = "failed";
    record.message =
      "The operation stopped before completion. Review the playlist before retrying.";
    record.updatedAt = Date.now();
    saveBulkOperation(record);
  }
  return record;
}

export function saveBulkOperation(record: BulkOperationRecord) {
  saveStmt.run(`${PREFIX}${record.operationId}`, JSON.stringify(record));
  return record;
}

export function enqueueBulkOperation(record: BulkOperationInput) {
  const queue = getPlaylistOperationQueue();
  const tx = getHonkerDb().transaction();
  try {
    const operationId = queue.enqueueTx(tx, {
      kind: "shared-playlist-bulk",
      label: `shared-playlist:${record.action}`,
    });
    const now = Date.now();
    const result = {
      ...record,
      operationId,
      state: "queued",
      outcomes: [],
      synchronization: {},
      createdAt: now,
      updatedAt: now,
    };
    tx.execute("INSERT INTO settings (key, value) VALUES (?, ?)", [
      `${PREFIX}${operationId}`,
      JSON.stringify(result),
    ]);
    tx.commit();
    return { queued: true, operationId };
  } catch (error) {
    tx.rollback();
    throw error;
  }
}

export function cleanupBulkOperations() {
  const owners = new Map<number, { key: string; updatedAt: number }[]>();
  const now = Date.now();
  for (const row of listStmt.all()) {
    const record = getBulkOperation(row.key.slice(PREFIX.length));
    if (!record || !["completed", "failed"].includes(record.state)) continue;
    if (now - Number(record.updatedAt || record.createdAt) > RETENTION_MS) {
      deleteStmt.run(row.key);
      continue;
    }
    const records = owners.get(record.ownerUserId) || [];
    records.push({ key: row.key, updatedAt: Number(record.updatedAt || record.createdAt) });
    owners.set(record.ownerUserId, records);
  }
  for (const records of owners.values()) {
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records.slice(100)) deleteStmt.run(record.key);
  }
}
