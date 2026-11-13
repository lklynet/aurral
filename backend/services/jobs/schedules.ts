import { db } from "../../config/db-sqlite.ts";
import type { JobSchedulesRow } from "../../db/rows.ts";
import type { EnqueueOptions } from "./queue.ts";
import { enqueueSystemTask, SYSTEM_TASK_SCHEDULES, systemTaskQueueFor } from "./systemTasks.ts";

const MISSED_RUN_GRACE_MS = 5 * 60_000;

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

function systemSchedule({
  kind,
  everyMs,
  priority = 0,
}: (typeof SYSTEM_TASK_SCHEDULES)[number]): Schedule {
  const queue = systemTaskQueueFor(kind);
  return {
    name: kind,
    queue: queue.name,
    kind,
    payload: { kind },
    intervalMs: everyMs,
    priority,
    maxAttempts: queue.maxAttempts,
    fire: (options) => enqueueSystemTask({ kind }, options),
  };
}

export const SCHEDULES: Schedule[] = SYSTEM_TASK_SCHEDULES.map(systemSchedule);

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
