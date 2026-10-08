import { db, dbHelpers } from "../../config/db-sqlite.js";

export const ACTIVE_OPERATION_STATUSES = ["planning", "ready", "running"];
const FINISHED_STATUSES = new Set(["complete", "failed", "cancelled"]);

const toOperation = (row) => row && {
  id: row.id,
  kind: row.kind,
  status: row.status,
  options: dbHelpers.parseJSON(row.options_json) || {},
  summary: dbHelpers.parseJSON(row.summary_json) || {},
  error: row.error || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at || null,
};

const toItem = (row) => row && {
  position: row.position,
  sourcePath: row.source_path,
  targetPath: row.target_path || null,
  status: row.status,
  reason: row.reason || null,
  details: dbHelpers.parseJSON(row.details_json) || {},
};

export function getLibraryFileOperation(id) {
  return toOperation(db.prepare("SELECT * FROM library_file_operations WHERE id = ?").get(Number(id)));
}

export function getActiveLibraryFileOperation() {
  return toOperation(db.prepare(
    `SELECT * FROM library_file_operations
     WHERE status IN (${ACTIVE_OPERATION_STATUSES.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 1`,
  ).get(...ACTIVE_OPERATION_STATUSES));
}

export function getLatestLibraryFileOperation() {
  return getActiveLibraryFileOperation()
    || toOperation(db.prepare("SELECT * FROM library_file_operations ORDER BY id DESC LIMIT 1").get());
}

export class OperationConflictError extends Error {
  constructor(operation) {
    super("Another library file operation is in progress. Finish or cancel it first.");
    this.code = "LIBRARY_FILE_OPERATION_ACTIVE";
    this.operation = operation;
  }
}

export function createLibraryFileOperation({ kind, options }) {
  return db.transaction(() => {
    const active = getActiveLibraryFileOperation();
    if (active) throw new OperationConflictError(active);
    const now = Date.now();
    const result = db.prepare(
      `INSERT INTO library_file_operations (kind, status, options_json, summary_json, created_at, updated_at)
       VALUES (?, 'planning', ?, '{}', ?, ?)`,
    ).run(kind, JSON.stringify(options || {}), now, now);
    return getLibraryFileOperation(result.lastInsertRowid);
  }).immediate();
}

export function updateLibraryFileOperation(id, { status, summary, error } = {}) {
  const current = getLibraryFileOperation(id);
  if (!current) return null;
  const now = Date.now();
  const nextStatus = status || current.status;
  db.prepare(
    `UPDATE library_file_operations
     SET status = ?, summary_json = ?, error = ?, updated_at = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    nextStatus,
    JSON.stringify(summary ? { ...current.summary, ...summary } : current.summary),
    error === undefined ? current.error : error,
    now,
    FINISHED_STATUSES.has(nextStatus) ? current.finishedAt || now : null,
    current.id,
  );
  return getLibraryFileOperation(id);
}

// Moves an operation on only from the status it is expected to be in.
export function transitionLibraryFileOperation(id, from, to) {
  const now = Date.now();
  const changed = db.prepare(
    `UPDATE library_file_operations
     SET status = ?, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
  ).run(to, now, FINISHED_STATUSES.has(to) ? now : null, Number(id), ...from).changes;
  return changed > 0;
}

export function addLibraryFileOperationItems(id, items) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO library_file_operation_items
      (operation_id, position, source_path, target_path, status, reason, details_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const next = db.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM library_file_operation_items WHERE operation_id = ?",
  );
  db.transaction(() => {
    let position = next.get(Number(id)).position;
    for (const item of items) {
      insert.run(
        Number(id),
        item.position ?? position++,
        item.sourcePath,
        item.targetPath || null,
        item.status,
        item.reason || null,
        item.details ? JSON.stringify(item.details) : null,
        Date.now(),
      );
    }
  })();
}

export function updateLibraryFileOperationItem(id, position, { status, targetPath, reason, details }) {
  const current = db.prepare(
    "SELECT * FROM library_file_operation_items WHERE operation_id = ? AND position = ?",
  ).get(Number(id), Number(position));
  if (!current) return;
  db.prepare(
    `UPDATE library_file_operation_items
     SET status = ?, target_path = ?, reason = ?, details_json = ?, updated_at = ?
     WHERE operation_id = ? AND position = ?`,
  ).run(
    status || current.status,
    targetPath === undefined ? current.target_path : targetPath,
    reason === undefined ? current.reason : reason,
    details === undefined ? current.details_json : JSON.stringify(details),
    Date.now(),
    Number(id),
    Number(position),
  );
}

export function listLibraryFileOperationItems(id, { statuses = null, offset = 0, limit = 100 } = {}) {
  const filter = Array.isArray(statuses) && statuses.length
    ? `AND status IN (${statuses.map(() => "?").join(",")})`
    : "";
  return db.prepare(
    `SELECT * FROM library_file_operation_items
     WHERE operation_id = ? ${filter}
     ORDER BY position LIMIT ? OFFSET ?`,
  ).all(Number(id), ...(filter ? statuses : []), Number(limit), Number(offset)).map(toItem);
}

export function countLibraryFileOperationItems(id) {
  const counts = {};
  for (const row of db.prepare(
    "SELECT status, COUNT(*) AS count FROM library_file_operation_items WHERE operation_id = ? GROUP BY status",
  ).all(Number(id))) counts[row.status] = row.count;
  return counts;
}

export function deleteLibraryFileOperationItems(id, statuses) {
  db.prepare(
    `DELETE FROM library_file_operation_items
     WHERE operation_id = ? AND status IN (${statuses.map(() => "?").join(",")})`,
  ).run(Number(id), ...statuses);
}

export function listUnfinishedLibraryFileOperations() {
  return db.prepare(
    "SELECT * FROM library_file_operations WHERE status IN ('planning', 'running') ORDER BY id",
  ).all().map(toOperation);
}
