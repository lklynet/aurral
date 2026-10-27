import { createHash, randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { getMaintenanceTaskQueue, getHonkerDb, wakeQueueOwner } from "../honkerDb.ts";
import { isWrappedEnabled } from "../../config/apiContract.ts";
import { wrappedPeriod } from "./metrics.ts";
import { buildWrappedSummary } from "./history.ts";
import { getWrappedAvailability } from "./preview.ts";

type ReportBase = {
  requestId: string;
  userId: number;
  year: number;
  timeZone: string;
  cutoff: number;
  expiresAt: number;
  operationId: number;
};
export type WrappedReport = ReportBase &
  (
    | { state: "queued" | "running" }
    | { state: "failed"; message: string }
    | { state: "ready"; summary: Awaited<ReturnType<typeof buildWrappedSummary>> }
  );
const read = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const save = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);
const remove = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");
const cacheKey = (userId: number, year: number, timeZone: string) =>
  `wrapped:${userId}:${year}:${createHash("sha256").update(timeZone).digest("hex").slice(0, 16)}`;

export function cleanupWrappedReports(now = Date.now()) {
  db.prepare<[number]>(
    "DELETE FROM settings WHERE (key LIKE 'wrapped:%' OR key LIKE 'wrapped-banner:%' OR key LIKE 'wrapped-preview:%') AND (NOT json_valid(value) OR json_extract(value, '$.expiresAt') <= ?)",
  ).run(now);
}

export function validateWrappedRequest(
  userId: number,
  year: number,
  timeZone: string,
  now = Date.now(),
) {
  wrappedPeriod(year, timeZone, now);
  if (!timeZone || timeZone.length > 100) throw new Error("Invalid timezone");
  const season = getWrappedAvailability(userId, now);
  if (!season || year !== season.year) throw new Error("Choose the latest released Wrapped year");
  return season;
}

export function rolloverWrappedReports(now = Date.now()) {
  if (!isWrappedEnabled()) return;
  const rows = db
    .prepare<[], Pick<SettingsRow, "value">>(
      "SELECT settings.value FROM settings JOIN users ON users.id = json_extract(settings.value, '$.userId') WHERE settings.key LIKE 'wrapped:%' AND json_valid(settings.value) AND users.status = 'active'",
    )
    .all();
  for (const row of rows) {
    const report: WrappedReport = JSON.parse(row.value);
    const season = getWrappedAvailability(report.userId, now);
    if (season && report.year < season.year)
      requestWrappedReport(report.userId, season.year, report.timeZone, now);
  }
}

export function getWrappedReport(userId: number, year: number, timeZone: string, now = Date.now()) {
  const key = cacheKey(userId, year, timeZone);
  const row = read.get(key);
  if (!row) return null;
  const report: WrappedReport = JSON.parse(row.value);
  if (
    report.userId !== userId ||
    report.expiresAt <= now ||
    report.cutoff !== getWrappedAvailability(userId, now)?.cutoff
  ) {
    remove.run(key);
    return null;
  }
  if (
    (report.state === "queued" || report.state === "running") &&
    !getHonkerDb().query("SELECT id FROM _honker_live WHERE id = ?", [report.operationId]).length
  ) {
    const failed: WrappedReport = {
      ...report,
      state: "failed",
      message: "Your recap stopped before it finished. Try again.",
    };
    save.run(key, JSON.stringify(failed));
    return failed;
  }
  return report;
}

export function requestWrappedReport(
  userId: number,
  year: number,
  timeZone: string,
  now = Date.now(),
  refresh = false,
) {
  const season = validateWrappedRequest(userId, year, timeZone, now);
  const existing = getWrappedReport(userId, year, timeZone, now);
  if (
    existing &&
    (existing.state === "queued" ||
      existing.state === "running" ||
      (!refresh && existing.state === "ready"))
  )
    return existing;
  const requestId = randomUUID();
  const tx = getHonkerDb().transaction();
  try {
    const operationId = getMaintenanceTaskQueue().enqueueTx(tx, {
      kind: "wrapped-build",
      userId,
      year,
      timeZone,
      cutoff: season.cutoff,
      requestId,
    });
    const report: WrappedReport = {
      requestId,
      operationId,
      userId,
      year,
      timeZone,
      cutoff: season.cutoff,
      expiresAt: Math.min(now + 86400000, season.expiresAt),
      state: "queued",
    };
    tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
      cacheKey(userId, year, timeZone),
      JSON.stringify(report),
    ]);
    tx.commit();
    wakeQueueOwner("system-task-maintenance");
    return report;
  } catch (error) {
    tx.rollback();
    throw error;
  }
}

export async function processWrappedReport(
  userId: number,
  year: number,
  timeZone: string,
  cutoff: number,
  requestId: string,
) {
  if (!getWrappedAvailability(userId)) return;
  const key = cacheKey(userId, year, timeZone);
  const row = read.get(key);
  if (!row) return;
  const report: WrappedReport = JSON.parse(row.value);
  if (report.requestId !== requestId || report.expiresAt <= Date.now()) return;
  const running: WrappedReport = { ...report, state: "running" };
  save.run(key, JSON.stringify(running));
  let result: WrappedReport;
  try {
    const season = validateWrappedRequest(userId, year, timeZone);
    const summary = await buildWrappedSummary(userId, wrappedPeriod(year, timeZone, cutoff));
    result = { ...running, state: "ready", summary, expiresAt: season.expiresAt };
  } catch {
    result = {
      ...running,
      state: "failed",
      message:
        "Your listening history could not be collected. Check your connections and try again.",
    };
  }
  const latest = read.get(key);
  if (latest && JSON.parse(latest.value).requestId === requestId && result.expiresAt > Date.now())
    save.run(key, JSON.stringify(result));
}
