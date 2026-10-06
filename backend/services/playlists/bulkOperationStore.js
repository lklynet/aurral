import { db } from "../../config/db-sqlite.js";
import { getHonkerDb, getPlaylistOperationQueue } from "../honkerDb.js";

const PREFIX = "playlistBulkOperation:";
const RETENTION_MS = 7 * 86400000;
const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const saveStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const deleteStmt = db.prepare("DELETE FROM settings WHERE key = ?");
const listStmt = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'playlistBulkOperation:%'");

export function getBulkOperation(operationId) {
  const row = getStmt.get(`${PREFIX}${operationId}`);
  if (!row) return null;
  const record = JSON.parse(row.value);
  if (!["completed", "failed"].includes(record.state) && !getHonkerDb().query("SELECT state FROM _honker_live WHERE id = ? AND queue = 'playlist-operation'", [record.operationId]).length) {
    record.state = "failed";
    record.message = "The operation stopped before completion. Review the playlist before retrying.";
    record.updatedAt = Date.now();
    saveBulkOperation(record);
  }
  return record;
}

export function saveBulkOperation(record) {
  saveStmt.run(`${PREFIX}${record.operationId}`, JSON.stringify(record));
  return record;
}

export function enqueueBulkOperation(record) {
  const queue = getPlaylistOperationQueue();
  const tx = getHonkerDb().transaction();
  try {
    const operationId = queue.enqueueTx(tx, { kind: "static-playlist-bulk", label: `static-playlist:${record.action}` });
    const now = Date.now();
    const result = { ...record, operationId, state: "queued", outcomes: [], synchronization: {}, createdAt: now, updatedAt: now };
    tx.execute("INSERT INTO settings (key, value) VALUES (?, ?)", [`${PREFIX}${operationId}`, JSON.stringify(result)]);
    tx.commit();
    return { queued: true, operationId };
  } catch (error) {
    tx.rollback();
    throw error;
  }
}

export function cleanupBulkOperations() {
  const owners = new Map();
  const now = Date.now();
  for (const row of listStmt.all()) {
    const record = getBulkOperation(row.key.slice(PREFIX.length));
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
