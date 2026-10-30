import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { LibraryFileOperationItemsRow, LibraryFileOperationsRow } from "../../db/rows.ts";

export const ACTIVE_OPERATION_STATUSES = ["planning", "running"];
const FINISHED_STATUSES = new Set(["complete", "failed", "cancelled"]);
const UNREADABLE_OPERATION =
  "Aurral can't read what this operation saved, so it stopped without changing more files. Start it again.";
export const UNREADABLE_ITEM =
  "Aurral can't read what it planned for this file, so it left the file as it is. Run it again.";

const operationKindSchema = v.picklist(["ingest", "cleanup"]);

const ingestOptionsSchema = v.looseObject({
  sourcePath: v.string(),
  mode: v.picklist(["move", "copy", "hardlink"]),
  monitor: v.picklist(["none", "tracks", "albums"]),
  fillTags: v.optional(v.boolean(), false),
});

const summarySchema = v.looseObject({
  listed: v.optional(v.boolean()),
  finished: v.optional(v.boolean()),
  monitor: v.optional(v.string()),
  doubles: v.optional(v.string()),
  removingSources: v.optional(v.nullable(v.number())),
  cursor: v.optional(v.looseObject({ next: v.number(), albumIds: v.array(v.number()) })),
  unchanged: v.optional(v.number()),
});

const itemDetailsSchema = v.looseObject({
  title: v.optional(v.string(), ""),
  action: v.optional(v.string()),
  actions: v.optional(v.array(v.string())),
  tags: v.optional(
    v.record(v.string(), v.union([v.string(), v.number(), v.array(v.string()), v.null()])),
  ),
  tagFields: v.optional(v.array(v.string())),
  albumId: v.optional(v.nullable(v.number()), null),
  sidecars: v.optional(v.array(v.string())),
  art: v.optional(v.array(v.string())),
  removable: v.optional(v.boolean()),
  takesName: v.optional(v.boolean()),
  hardlinked: v.optional(v.boolean()),
  results: v.optional(v.record(v.string(), v.string())),
  tagged: v.optional(v.looseObject({ size: v.number(), mtimeMs: v.number() })),
  size: v.optional(v.nullable(v.number())),
  mtimeMs: v.optional(v.nullable(v.number())),
});

export type LibraryFileOperation = NonNullable<ReturnType<typeof toOperation>>;
export type IngestOperation = Extract<LibraryFileOperation, { kind: "ingest" }>;
export type CleanupOperation = Extract<LibraryFileOperation, { kind: "cleanup" }>;

const operationFields = (row: LibraryFileOperationsRow) => ({
  id: row.id,
  status: row.status,
  error: row.error || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at || null,
});

const toOperation = (row: LibraryFileOperationsRow | undefined) => {
  if (!row) return undefined;
  const source = `library file operation ${row.id}`;
  const summary = dbHelpers.readJSON(summarySchema, row.summary_json || "{}", source);
  if (!summary) return undefined;
  const operation = { ...operationFields(row), summary };
  if (row.kind === "cleanup") return { ...operation, kind: "cleanup" as const, options: {} };
  if (row.kind !== "ingest") return undefined;
  const options = dbHelpers.readJSON(ingestOptionsSchema, row.options_json, source);
  return options ? { ...operation, kind: "ingest" as const, options } : undefined;
};

const toStatus = (row: LibraryFileOperationsRow | undefined) => {
  const operation = toOperation(row);
  if (operation || !row || !v.is(operationKindSchema, row.kind)) return operation;
  return {
    ...operationFields(row),
    summary: v.parse(summarySchema, {}),
    kind: row.kind,
    options: null,
  };
};

export type LibraryFileStatus = NonNullable<ReturnType<typeof toStatus>>;

export const readItemDetails = (text: string | null) =>
  dbHelpers.readJSON(itemDetailsSchema, text ?? "{}", "library file operation item");

const toItem = (row: LibraryFileOperationItemsRow) => {
  const details = readItemDetails(row.details_json);
  return {
    position: row.position,
    sourcePath: row.source_path,
    targetPath: row.target_path || null,
    status: row.status,
    reason: row.reason || null,
    details: details ?? v.parse(itemDetailsSchema, {}),
    readable: details !== null,
  };
};

const operationRow = (id: string | number) =>
  db
    .prepare<[number], LibraryFileOperationsRow>(
      "SELECT * FROM library_file_operations WHERE id = ?",
    )
    .get(Number(id));

const activeOperationRow = () =>
  db
    .prepare<string[], LibraryFileOperationsRow>(
      `SELECT * FROM library_file_operations
     WHERE status IN (${ACTIVE_OPERATION_STATUSES.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 1`,
    )
    .get(...ACTIVE_OPERATION_STATUSES);

export function getLibraryFileOperation(id: string | number) {
  return toOperation(operationRow(id));
}

export function getLibraryFileOperationStatus(id: string | number) {
  return toStatus(operationRow(id));
}

export function getActiveLibraryFileOperation() {
  return toStatus(activeOperationRow());
}

export function getLatestLibraryFileOperation() {
  return toStatus(
    activeOperationRow() ||
      db
        .prepare<[], LibraryFileOperationsRow>(
          "SELECT * FROM library_file_operations ORDER BY id DESC LIMIT 1",
        )
        .get(),
  );
}

export class OperationConflictError extends Error {
  declare code: string;
  declare operation: LibraryFileStatus;

  constructor(operation: LibraryFileStatus) {
    super("Another library file operation is in progress. Finish or cancel it first.");
    this.code = "LIBRARY_FILE_OPERATION_ACTIVE";
    this.operation = operation;
  }
}

export function createLibraryFileOperation({ kind, options }: { kind: string; options?: unknown }) {
  return db
    .transaction(() => {
      const active = getActiveLibraryFileOperation();
      if (active) throw new OperationConflictError(active);
      const now = Date.now();
      const result = db
        .prepare(
          `INSERT INTO library_file_operations (kind, status, options_json, summary_json, created_at, updated_at)
       VALUES (?, 'planning', ?, '{}', ?, ?)`,
        )
        .run(kind, JSON.stringify(options || {}), now, now);
      return getLibraryFileOperation(result.lastInsertRowid as number);
    })
    .immediate();
}

export function updateLibraryFileOperation(
  id: string | number,
  {
    status,
    summary,
    error,
  }: { status?: string; summary?: Record<string, unknown>; error?: string | null } = {},
) {
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
export function transitionLibraryFileOperation(id: string | number, from: string[], to: string) {
  const now = Date.now();
  const changed = db
    .prepare(
      `UPDATE library_file_operations
     SET status = ?, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
    )
    .run(to, now, FINISHED_STATUSES.has(to) ? now : null, Number(id), ...from).changes;
  return changed > 0;
}

type LibraryFileOperationItemInput = {
  position?: number;
  sourcePath: string;
  targetPath?: string | null;
  status: string;
  reason?: string | null;
  details?: unknown;
};

export function addLibraryFileOperationItems(
  id: string | number,
  items: LibraryFileOperationItemInput[],
) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO library_file_operation_items
      (operation_id, position, source_path, target_path, status, reason, details_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const next = db.prepare<[number], { position: number }>(
    "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM library_file_operation_items WHERE operation_id = ?",
  );
  db.transaction(() => {
    let position = next.get(Number(id))!.position;
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

export function updateLibraryFileOperationItem(
  id: string | number,
  position: number,
  {
    status,
    targetPath,
    reason,
    details,
  }: {
    status?: string;
    targetPath?: string | null;
    reason?: string | null;
    details?: unknown;
  },
) {
  const current = db
    .prepare<[number, number], LibraryFileOperationItemsRow>(
      "SELECT * FROM library_file_operation_items WHERE operation_id = ? AND position = ?",
    )
    .get(Number(id), Number(position));
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

export function listLibraryFileOperationItems(
  id: string | number,
  {
    statuses = null,
    offset = 0,
    limit = 100,
  }: { statuses?: string[] | null; offset?: number; limit?: number } = {},
) {
  const filter =
    Array.isArray(statuses) && statuses.length
      ? `AND status IN (${statuses.map(() => "?").join(",")})`
      : "";
  return db
    .prepare<(string | number)[], LibraryFileOperationItemsRow>(
      `SELECT * FROM library_file_operation_items
     WHERE operation_id = ? ${filter}
     ORDER BY position LIMIT ? OFFSET ?`,
    )
    .all(Number(id), ...(filter ? statuses! : []), Number(limit), Number(offset))
    .map(toItem);
}

export function countLibraryFileOperationItems(id: string | number) {
  const counts: Record<string, number> = {};
  for (const row of db
    .prepare<[number], { status: string; count: number }>(
      "SELECT status, COUNT(*) AS count FROM library_file_operation_items WHERE operation_id = ? GROUP BY status",
    )
    .all(Number(id)))
    counts[row.status] = row.count;
  return counts;
}

export function deleteLibraryFileOperationItems(id: string | number, statuses: string[]) {
  db.prepare(
    `DELETE FROM library_file_operation_items
     WHERE operation_id = ? AND status IN (${statuses.map(() => "?").join(",")})`,
  ).run(Number(id), ...statuses);
}

export function listUnfinishedLibraryFileOperationIds() {
  return db
    .prepare<[], number>(
      "SELECT id FROM library_file_operations WHERE status IN ('planning', 'running') ORDER BY id",
    )
    .pluck()
    .all();
}

export function failUnreadableLibraryFileOperation(id: number) {
  const now = Date.now();
  db.prepare(
    `UPDATE library_file_operations SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('planning', 'running')`,
  ).run(UNREADABLE_OPERATION, now, now, id);
}

// An operation keeps a duplicate file until the user asks to remove it. The
// operation then runs again over just those files, each checked again before
// it is removed. Files a stopped operation never reached stay where they are.
export function reopenToRemoveDuplicates(id: string | number, unfinishedReason: string) {
  return db
    .transaction(() => {
      const operation = getLibraryFileOperation(id);
      const active = getActiveLibraryFileOperation();
      if (active) throw new OperationConflictError(active);
      if (!operation) return false;
      if (operation.status === "cancelled" && !operation.summary.finished) {
        throw Object.assign(new OperationConflictError(operation), {
          message: "It is still stopping. Try again in a moment.",
        });
      }
      const requested = db
        .prepare(
          `UPDATE library_file_operation_items
       SET status = 'pending', details_json = json_set(details_json, '$.action', 'remove-source'), updated_at = ?
       WHERE operation_id = ? AND status = 'duplicate' AND json_extract(details_json, '$.removable') = 1`,
        )
        .run(Date.now(), operation.id).changes;
      if (!requested) return false;
      db.prepare(
        `UPDATE library_file_operation_items SET status = 'skipped', reason = ?, updated_at = ?
       WHERE operation_id = ? AND (status = 'new'
         OR (status = 'pending' AND COALESCE(json_extract(details_json, '$.action'), '') != 'remove-source'))`,
      ).run(unfinishedReason, Date.now(), operation.id);
      updateLibraryFileOperation(operation.id, {
        status: "running",
        summary: { finished: false, removingSources: requested },
      });
      return true;
    })
    .immediate();
}

export function restoreUnremovedDuplicates(id: string | number) {
  db.prepare(
    `UPDATE library_file_operation_items SET status = 'duplicate', updated_at = ?
     WHERE operation_id = ? AND status = 'pending' AND json_extract(details_json, '$.action') = 'remove-source'`,
  ).run(Date.now(), Number(id));
}

export function countRemovableDuplicates(id: string | number) {
  return db
    .prepare<[number], { removable: number; removed: number }>(
      `SELECT
       COALESCE(SUM(json_extract(details_json, '$.removable') = 1), 0) AS removable,
       COALESCE(SUM(json_extract(details_json, '$.sourceRemoved') = 1), 0) AS removed
     FROM library_file_operation_items WHERE operation_id = ? AND status = 'duplicate'`,
    )
    .get(Number(id));
}
