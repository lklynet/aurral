import { db } from "../config/db-sqlite.ts";
import type { MetadataCallsRow, MetadataProviderBudgetRow } from "../db/rows.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS metadata_provider_budget (
    base_url TEXT PRIMARY KEY,
    next_request_at INTEGER NOT NULL DEFAULT 0,
    forbidden_until INTEGER NOT NULL DEFAULT 0,
    rate_limited_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS metadata_calls (
    hour INTEGER NOT NULL,
    server TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    work TEXT NOT NULL,
    status TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (hour, server, endpoint, work, status)
  ) WITHOUT ROWID;
`);

const readBudget = db.prepare<[string], MetadataProviderBudgetRow>(
  "SELECT * FROM metadata_provider_budget WHERE base_url = ?",
);
const CLOCK_SLACK_MS = 2;

const reserve = db.prepare<
  [string, number, number],
  Pick<MetadataProviderBudgetRow, "next_request_at">
>(`
  INSERT INTO metadata_provider_budget(base_url, next_request_at) VALUES (?, ?)
  ON CONFLICT(base_url) DO UPDATE SET next_request_at = excluded.next_request_at
  WHERE metadata_provider_budget.next_request_at <= ?
  RETURNING next_request_at
`);

export function reserveMetadataProviderRequest(baseUrl: string, intervalMs: number) {
  const now = Date.now();
  if (reserve.get(baseUrl, now + intervalMs, now + CLOCK_SLACK_MS)) return 0;
  const bookedUntil = Number(readBudget.get(baseUrl)?.next_request_at || 0);
  return Math.max(1, bookedUntil - Date.now());
}

const HOUR_MS = 60 * 60 * 1000;
const CALL_RETENTION_MS = 30 * 24 * HOUR_MS;
let nextCallCleanupAt = 0;

const countCall = db.prepare<[number, string, string, string, string]>(`
  INSERT INTO metadata_calls(hour, server, endpoint, work, status, count)
  VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(hour, server, endpoint, work, status) DO UPDATE SET count = count + 1
`);
const cleanOldCalls = db.prepare<[number]>("DELETE FROM metadata_calls WHERE hour < ?");
const sumCalls = db.prepare<
  [number],
  Pick<MetadataCallsRow, "server" | "endpoint" | "work" | "status" | "count">
>(`
  SELECT server, endpoint, work, status, SUM(count) AS count FROM metadata_calls
  WHERE hour >= ? GROUP BY server, endpoint, work, status ORDER BY count DESC
`);
const sumCallsByHour = db.prepare<[number], Pick<MetadataCallsRow, "hour" | "count">>(`
  SELECT hour, SUM(count) AS count FROM metadata_calls WHERE hour >= ? GROUP BY hour ORDER BY hour
`);

export function recordMetadataCall(
  call: Pick<MetadataCallsRow, "server" | "endpoint" | "work" | "status">,
  now = Date.now(),
) {
  if (now >= nextCallCleanupAt) {
    nextCallCleanupAt = now + HOUR_MS;
    cleanOldCalls.run(now - CALL_RETENTION_MS);
  }
  countCall.run(now - (now % HOUR_MS), call.server, call.endpoint, call.work, call.status);
}

export function listMetadataCalls(since: number) {
  const hour = since - (since % HOUR_MS);
  return {
    since: new Date(hour).toISOString(),
    calls: sumCalls.all(hour),
    hours: sumCallsByHour.all(hour).map((row) => ({
      hour: new Date(row.hour).toISOString(),
      count: row.count,
    })),
  };
}
