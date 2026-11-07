import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { playlistOperationQueue } from "../jobs/queues.ts";

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

const selectionSchema = v.looseObject({
  jobId: v.string(),
  membershipId: v.nullable(v.string()),
});

const outcomeSchema = v.looseObject({
  jobId: v.string(),
  status: v.picklist(["removed", "failed", "alreadyAbsent", "moved"]),
  message: v.optional(v.string()),
  targetPlaylistId: v.optional(v.string()),
});

const recordEntries = {
  operationId: v.number(),
  ownerUserId: v.number(),
  sourcePlaylistId: v.string(),
  selections: v.array(selectionSchema),
  state: v.picklist(["queued", "running", "completed", "failed"]),
  outcomes: v.array(outcomeSchema),
  synchronization: v.record(v.string(), v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number(),
  message: v.optional(v.string()),
  scanScheduled: v.optional(v.boolean()),
};

const bulkOperationSchema = v.variant("action", [
  v.looseObject({
    ...recordEntries,
    action: v.literal("move"),
    target: v.looseObject({
      playlistId: v.string(),
      name: v.optional(v.string()),
      create: v.optional(v.boolean()),
    }),
  }),
  v.looseObject({ ...recordEntries, action: v.literal("remove"), target: v.null() }),
]);

export type StaticPlaylistSelection = v.InferOutput<typeof selectionSchema>;
export type BulkOperationOutcome = v.InferOutput<typeof outcomeSchema>;
export type BulkOperationRecord = v.InferOutput<typeof bulkOperationSchema>;

export type BulkOperationInput = Pick<
  BulkOperationRecord,
  "ownerUserId" | "sourcePlaylistId" | "selections"
> & {
  action: BulkOperationRecord["action"];
  target: BulkOperationRecord["target"] | null;
};

export function getBulkOperation(operationId: unknown) {
  const row = getStmt.get(`${PREFIX}${operationId}`);
  if (!row) return null;
  const record = dbHelpers.readJSON(bulkOperationSchema, row.value, `${PREFIX}${operationId}`);
  if (!record) return null;
  const jobState = playlistOperationQueue.getJob(record.operationId)?.state;
  if (
    !["completed", "failed"].includes(record.state) &&
    jobState !== "pending" &&
    jobState !== "running"
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

const insertStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");

export const enqueueBulkOperation = db.transaction((record: BulkOperationInput) => {
  const operationId = playlistOperationQueue.enqueue({
    kind: "static-playlist-bulk",
    label: `static-playlist:${record.action}`,
  });
  const now = Date.now();
  insertStmt.run(
    `${PREFIX}${operationId}`,
    JSON.stringify({
      ...record,
      operationId,
      state: "queued",
      outcomes: [],
      synchronization: {},
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { queued: true, operationId };
});

export function cleanupBulkOperations() {
  const owners = new Map<number, { key: string; updatedAt: number }[]>();
  const now = Date.now();
  for (const row of listStmt.all()) {
    const record = getBulkOperation(row.key.slice(PREFIX.length));
    if (!record) {
      deleteStmt.run(row.key);
      continue;
    }
    if (!["completed", "failed"].includes(record.state)) continue;
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
