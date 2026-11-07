import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { logger } from "../services/logger.ts";

export const JOB_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe_key TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
    run_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    worker_id TEXT,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (queue, priority DESC, run_at, id)
    WHERE state = 'pending';
  CREATE INDEX IF NOT EXISTS jobs_leases ON jobs (lease_until) WHERE state = 'running';
  CREATE INDEX IF NOT EXISTS jobs_finished ON jobs (finished_at)
    WHERE state IN ('done', 'failed', 'cancelled');
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs (queue, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running');

  CREATE TABLE IF NOT EXISTS job_locks (
    name TEXT PRIMARY KEY NOT NULL,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_schedules (
    name TEXT PRIMARY KEY NOT NULL,
    queue TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    interval_ms INTEGER NOT NULL,
    next_run_at INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL
  );
`;

const MIGRATION_KEY = "migration:job-queue-v1";
const SNAPSHOT_NAME = "aurral.pre-job-queue.db";
const HISTORY_WINDOW_S = 60 * 60;

const RENAMED_TABLES = [
  ["playlist_download_jobs", "download_jobs"],
  ["playlist_download_jobs_revision", "download_jobs_revision"],
  ["weekly_flow_download_cancellations", "download_cancellations"],
  ["weekly_flow_download_job_cancellations", "download_job_cancellations"],
  ["weekly_flow_download_provider_work", "download_provider_work"],
] as const;

const RENAMED_COLUMNS = [
  ["download_jobs", "playlist_id", "owner_id"],
  ["download_jobs", "playlist_type", "owner_type"],
  ["download_cancellations", "playlist_id", "owner_id"],
  ["download_provider_work", "playlist_id", "owner_id"],
] as const;

const RETIRED_OBJECTS = [
  "DROP INDEX IF EXISTS idx_playlist_download_jobs_status",
  "DROP INDEX IF EXISTS idx_playlist_download_jobs_playlist_id",
  "DROP INDEX IF EXISTS idx_playlist_download_jobs_request_group",
  "DROP INDEX IF EXISTS idx_weekly_flow_download_job_cancellations_time",
  "DROP INDEX IF EXISTS idx_weekly_flow_download_provider_work_job",
  "DROP INDEX IF EXISTS idx_weekly_flow_download_provider_work_playlist",
  "DROP TRIGGER IF EXISTS playlist_download_jobs_revision_insert",
  "DROP TRIGGER IF EXISTS playlist_download_jobs_revision_update",
  "DROP TRIGGER IF EXISTS playlist_download_jobs_revision_delete",
  "DROP TRIGGER IF EXISTS playlist_download_attempt_delete",
  "DROP TRIGGER IF EXISTS playlist_download_attempt_complete",
  "DROP TABLE IF EXISTS honker_task_runs",
];

const RENAMED_SETTINGS = [["sharedPlaylists", "staticPlaylists"]] as const;
const RETIRED_SETTINGS = ["weeklyFlowIncompleteRetryJobs", "deprecatedUsage"];

const RENAMED_QUEUES: Record<string, string> = {
  "weekly-flow-operation": "playlist-operation",
  "slskd-pipeline": "download-pipeline",
  "_outbox:notifications": "notifications",
  "_outbox:play-events": "play-events",
};

const RENAMED_KINDS: Record<string, string> = {
  "weekly-flow-refresh": "flow-refresh",
  "weekly-flow-reuse-repair": "flow-reuse-repair",
  "weekly-flow-startup-check": "flow-startup-check",
  "weekly-flow-startup-reuse-repair": "flow-startup-reuse-repair",
};

const MOVED_SYSTEM_KINDS: Record<string, string> = {
  "release-metadata-refresh": "release-metadata-refresh",
  "playback-library-scan": "playback",
  "playback-playlist-sync": "playback",
};

const INTERVAL_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

interface LegacyLiveRow {
  id: number;
  queue: string;
  payload: string;
  priority: number;
  run_at: number;
  attempts: number;
  max_attempts: number;
  created_at: number;
}

interface LegacyDeadRow extends LegacyLiveRow {
  last_error: string | null;
  died_at: number;
}

interface LegacyScheduleRow {
  name: string;
  queue: string;
  cron_expr: string;
  payload: string;
  priority: number;
  next_fire_at: number;
  max_attempts: number;
}

const renameKind = (kind: string) =>
  RENAMED_KINDS[kind] ?? (kind.startsWith("shared-playlist-") ? `static-${kind.slice(7)}` : kind);

const renameLabel = (label: string) =>
  label.startsWith("shared-playlist") ? `static-${label.slice(7)}` : label;

function mapLegacyJob(queue: string, payloadText: string) {
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {}
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? { ...payload }
      : null;
  const legacyKind: unknown = record ? Reflect.get(record, "kind") : null;
  const kind = typeof legacyKind === "string" ? renameKind(legacyKind) : null;
  const label: unknown = record ? Reflect.get(record, "label") : null;
  if (record && kind) Reflect.set(record, "kind", kind);
  if (record && typeof label === "string") Reflect.set(record, "label", renameLabel(label));
  const renamedQueue =
    queue === "system-task" && typeof legacyKind === "string" && MOVED_SYSTEM_KINDS[legacyKind]
      ? MOVED_SYSTEM_KINDS[legacyKind]
      : (RENAMED_QUEUES[queue] ?? queue);
  return {
    queue: renamedQueue,
    kind: kind ?? renamedQueue,
    payload: JSON.stringify(record ?? payload),
  };
}

function parseInterval(expr: string) {
  const match = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(expr.trim());
  const unit = match?.[2]?.toLowerCase();
  return match && unit ? Number(match[1]) * (INTERVAL_UNITS_MS[unit] ?? 0) : 0;
}

const tableExists = (db: Database.Database, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const columnExists = (db: Database.Database, table: string, column: string) =>
  db
    .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .some((row) => row.name === column);

function hasLegacyState(db: Database.Database) {
  return (
    RENAMED_TABLES.some(([from]) => tableExists(db, from)) ||
    tableExists(db, "_honker_live") ||
    tableExists(db, "honker_task_runs")
  );
}

function copyHonkerJobs(db: Database.Database, nowS: number) {
  if (!tableExists(db, "_honker_live")) return { live: 0, failed: 0 };
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, queue, kind, payload, priority, state, run_at, attempts, max_attempts,
       created_at, finished_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const live = db
    .prepare<[], LegacyLiveRow>(
      `SELECT id, queue, payload, priority, run_at, attempts, max_attempts, created_at
       FROM _honker_live WHERE state IN ('pending', 'processing') ORDER BY id`,
    )
    .all();
  for (const row of live) {
    const job = mapLegacyJob(row.queue, row.payload);
    insert.run(
      row.id,
      job.queue,
      job.kind,
      job.payload,
      row.priority,
      "pending",
      row.run_at * 1000,
      Math.min(row.attempts, Math.max(0, row.max_attempts - 1)),
      row.max_attempts,
      row.created_at * 1000,
      null,
      null,
    );
  }
  const dead = tableExists(db, "_honker_dead")
    ? db
        .prepare<[number], LegacyDeadRow>(
          `SELECT id, queue, payload, priority, run_at, attempts, max_attempts, created_at,
                  last_error, died_at
           FROM _honker_dead WHERE died_at >= ? ORDER BY id`,
        )
        .all(nowS - HISTORY_WINDOW_S)
    : [];
  for (const row of dead) {
    const job = mapLegacyJob(row.queue, row.payload);
    insert.run(
      row.id,
      job.queue,
      job.kind,
      job.payload,
      row.priority,
      "failed",
      row.run_at * 1000,
      row.attempts,
      row.max_attempts,
      row.created_at * 1000,
      row.died_at * 1000,
      row.last_error,
    );
  }
  const highestId = db
    .prepare<[], { id: number | null }>(
      `SELECT MAX(id) AS id FROM (
         SELECT MAX(id) AS id FROM _honker_live
         UNION ALL SELECT MAX(id) FROM jobs
         ${tableExists(db, "_honker_dead") ? "UNION ALL SELECT MAX(id) FROM _honker_dead" : ""}
         UNION ALL SELECT MAX(seq) FROM sqlite_sequence WHERE name LIKE '\\_honker\\_%' ESCAPE '\\'
       )`,
    )
    .get()?.id;
  if (highestId) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'jobs'").run();
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', ?)").run(highestId);
  }
  return { live: live.length, failed: dead.length };
}

function copyHonkerSchedules(db: Database.Database) {
  if (!tableExists(db, "_honker_scheduler_tasks")) return 0;
  const rows = db
    .prepare<[], LegacyScheduleRow>(
      `SELECT name, queue, cron_expr, payload, priority, next_fire_at, max_attempts
       FROM _honker_scheduler_tasks WHERE name IS NOT NULL`,
    )
    .all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO job_schedules
      (name, queue, kind, payload, interval_ms, next_run_at, priority, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let copied = 0;
  for (const row of rows) {
    const intervalMs = parseInterval(row.cron_expr);
    if (!intervalMs) continue;
    const job = mapLegacyJob(row.queue, row.payload);
    copied += insert.run(
      renameKind(row.name),
      job.queue,
      job.kind,
      job.payload,
      intervalMs,
      row.next_fire_at * 1000,
      row.priority,
      row.max_attempts,
    ).changes;
  }
  return copied;
}

export function migrateToJobQueue(db: Database.Database, dataDir: string) {
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const done = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(MIGRATION_KEY);
  if (done) return;
  if (!hasLegacyState(db)) {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(MIGRATION_KEY, "1");
    return;
  }

  const snapshot = path.join(dataDir, SNAPSHOT_NAME);
  if (!fs.existsSync(snapshot)) db.prepare("VACUUM INTO ?").run(snapshot);

  const summary = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(MIGRATION_KEY)) return null;
    const tables = RENAMED_TABLES.filter(([from, to]) => {
      if (!tableExists(db, from) || tableExists(db, to)) return false;
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
      return true;
    }).map(([from]) => from);
    const columns = RENAMED_COLUMNS.filter(([table, from, to]) => {
      if (!tableExists(db, table) || !columnExists(db, table, from)) return false;
      if (columnExists(db, table, to)) return false;
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
      return true;
    }).map(([table, from]) => `${table}.${from}`);
    for (const statement of RETIRED_OBJECTS) db.exec(statement);

    const settings = RENAMED_SETTINGS.filter(
      ([from, to]) =>
        db
          .prepare(
            `UPDATE settings SET key = ? WHERE key = ?
             AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)`,
          )
          .run(to, from, to).changes > 0,
    ).map(([from]) => from);
    db.prepare(
      `UPDATE settings SET key = 'playlistOperationTokens' || substr(key, 26)
       WHERE key = 'weeklyFlowOperationTokens' OR key LIKE 'weeklyFlowOperationTokens:%'`,
    ).run();
    db.prepare(
      `UPDATE settings SET value = replace(value, '"notifyWeeklyFlowDone"', '"notifyFlowDone"')
       WHERE key = 'integrations'`,
    ).run();
    for (const key of RETIRED_SETTINGS) db.prepare("DELETE FROM settings WHERE key = ?").run(key);

    db.exec(JOB_TABLES_SQL);
    const jobs = copyHonkerJobs(db, Math.floor(Date.now() / 1000));
    const schedules = copyHonkerSchedules(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(MIGRATION_KEY, "1");
    return { tables, columns, settings, jobs, schedules };
  })();

  if (summary) {
    logger.info("system", "Moved background jobs off Honker", {
      snapshot,
      renamedTables: summary.tables,
      renamedColumns: summary.columns,
      renamedSettings: summary.settings,
      pendingJobs: summary.jobs.live,
      failedJobs: summary.jobs.failed,
      schedules: summary.schedules,
    });
  }
}
