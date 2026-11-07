import type Database from "better-sqlite3";

export function insertJob(
  db: Database.Database,
  queue: string,
  payload: object,
  { runAt = Date.now(), maxAttempts = 3 }: { runAt?: number; maxAttempts?: number } = {},
) {
  const kind: unknown = Reflect.get(payload, "kind");
  return db
    .prepare<[string, string, string, number, number, number], { id: number }>(
      `INSERT INTO jobs (queue, kind, payload, state, run_at, max_attempts, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?) RETURNING id`,
    )
    .get(
      queue,
      typeof kind === "string" ? kind : queue,
      JSON.stringify(payload),
      runAt,
      maxAttempts,
      Date.now(),
    )!.id;
}
