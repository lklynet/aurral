import { db } from "../../config/db-sqlite.ts";
import type { JobSchedulesRow } from "../../db/rows.ts";
import type { EnqueueOptions } from "./queue.ts";
import { enqueueSystemTask, playlistMbidEnrichmentQueue, systemTaskQueueFor } from "./queues.ts";
import type { SystemTaskKind } from "./queues.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MISSED_RUN_GRACE_MS = 5 * MINUTE;

type FireOptions = Pick<EnqueueOptions<object>, "dedupeKey" | "priority" | "maxAttempts" | "runAt">;

interface Schedule {
  name: string;
  queue: string;
  kind: string;
  payload: Record<string, string>;
  intervalMs: number;
  priority: number;
  maxAttempts: number;
  fire: (options: FireOptions) => number;
}

function systemSchedule(
  kind: SystemTaskKind,
  intervalMs: number,
  { priority = 0 }: { priority?: number } = {},
): Schedule {
  const queue = systemTaskQueueFor(kind);
  return {
    name: kind,
    queue: queue.name,
    kind,
    payload: { kind },
    intervalMs,
    priority,
    maxAttempts: queue.maxAttempts,
    fire: (options) => enqueueSystemTask({ kind }, options),
  };
}

export const SCHEDULES: Schedule[] = [
  systemSchedule("flow-refresh", HOUR),
  systemSchedule("session-cleanup", HOUR),
  systemSchedule("flow-reuse-repair", 30 * MINUTE),
  systemSchedule("review-timeout", 15 * MINUTE),
  systemSchedule("quality-upgrade-check", HOUR, { priority: -10 }),
  systemSchedule("discovery-refresh-check", 15 * MINUTE),
  systemSchedule("inbox-refresh", 24 * HOUR),
  systemSchedule("news-refresh", 15 * MINUTE),
  systemSchedule("update-check", HOUR),
  systemSchedule("plugin-update-check", 24 * HOUR),
  systemSchedule("plugin-schedules", 15 * MINUTE),
  systemSchedule("trending-charts-refresh", 6 * HOUR),
  systemSchedule("import-list-sync", 30 * MINUTE),
  systemSchedule("history-server-sync", HOUR),
  systemSchedule("share-playlist-refresh", 24 * HOUR),
  systemSchedule("release-metadata-refresh", 24 * HOUR, { priority: -5 }),
  systemSchedule("aurral-monitoring-reconcile", 24 * HOUR),
  systemSchedule("aurral-missing-track-search", HOUR),
  {
    name: "playlist-mbid-enrichment-sweep",
    queue: playlistMbidEnrichmentQueue.name,
    kind: "playlist-mbid-enrichment-sweep",
    payload: { kind: "playlist-mbid-enrichment-sweep", reason: "schedule" },
    intervalMs: 6 * HOUR,
    priority: 0,
    maxAttempts: 4,
    fire: (options) =>
      playlistMbidEnrichmentQueue.enqueue(
        { kind: "playlist-mbid-enrichment-sweep", reason: "schedule" },
        options,
      ),
  },
];

const scheduleByName = new Map(SCHEDULES.map((schedule) => [schedule.name, schedule]));

const statements = {
  list: db.prepare<[], JobSchedulesRow>("SELECT * FROM job_schedules ORDER BY next_run_at, name"),
  remove: db.prepare<[string]>("DELETE FROM job_schedules WHERE name = ?"),
  upsert: db.prepare<
    Omit<JobSchedulesRow, "payload"> & { payload: string; now: number; graceMs: number }
  >(`
    INSERT INTO job_schedules
      (name, queue, kind, payload, interval_ms, next_run_at, priority, max_attempts)
    VALUES (@name, @queue, @kind, @payload, @interval_ms, @next_run_at, @priority, @max_attempts)
    ON CONFLICT (name) DO UPDATE SET
      queue = excluded.queue,
      kind = excluded.kind,
      payload = excluded.payload,
      priority = excluded.priority,
      max_attempts = excluded.max_attempts,
      next_run_at = CASE
        WHEN job_schedules.interval_ms != excluded.interval_ms
          OR job_schedules.next_run_at < @now - @graceMs
        THEN excluded.next_run_at ELSE job_schedules.next_run_at END,
      interval_ms = excluded.interval_ms
  `),
  due: db.prepare<[number], JobSchedulesRow>(
    "SELECT * FROM job_schedules WHERE next_run_at <= ? ORDER BY next_run_at, name",
  ),
  advance: db.prepare<[number, string, number]>(
    "UPDATE job_schedules SET next_run_at = ? WHERE name = ? AND next_run_at = ?",
  ),
};

export function listSchedules() {
  return statements.list.all();
}

export const syncSchedules = db.transaction((now: number = Date.now()) => {
  for (const row of statements.list.all()) {
    if (!scheduleByName.has(row.name)) statements.remove.run(row.name);
  }
  for (const schedule of SCHEDULES) {
    statements.upsert.run({
      name: schedule.name,
      queue: schedule.queue,
      kind: schedule.kind,
      payload: JSON.stringify(schedule.payload),
      interval_ms: schedule.intervalMs,
      next_run_at: now + schedule.intervalMs,
      priority: schedule.priority,
      max_attempts: schedule.maxAttempts,
      now,
      graceMs: MISSED_RUN_GRACE_MS,
    });
  }
});

const fireTx = db.transaction((row: JobSchedulesRow, schedule: Schedule, now: number) => {
  const next = row.next_run_at + row.interval_ms;
  const nextRunAt = next > now ? next : now + row.interval_ms;
  if (statements.advance.run(nextRunAt, row.name, row.next_run_at).changes === 0) return false;
  schedule.fire({
    runAt: now,
    dedupeKey: schedule.kind,
    priority: schedule.priority,
    maxAttempts: schedule.maxAttempts,
  });
  return true;
});

export function runDueSchedules(now = Date.now()) {
  const fired: string[] = [];
  for (const row of statements.due.all(now)) {
    const schedule = scheduleByName.get(row.name);
    if (schedule && fireTx(row, schedule, now)) fired.push(row.name);
  }
  return fired;
}
