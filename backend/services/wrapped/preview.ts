import { db } from "../../config/db-sqlite.ts";
import { APP_VERSION } from "../../config/constants.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { isWrappedPreviewBuild, wrappedSeason } from "../../../lib/wrapped.ts";
import { wrappedPeriod } from "./metrics.ts";

type WrappedPreview = { year: number; cutoff: number; expiresAt: number };

export function getWrappedPreview(userId: number, now = Date.now()) {
  if (!isWrappedPreviewBuild(APP_VERSION)) return null;
  const row = db
    .prepare<[string], Pick<SettingsRow, "value">>("SELECT value FROM settings WHERE key = ?")
    .get(`wrapped-preview:${userId}`);
  const preview: WrappedPreview | null = row ? JSON.parse(row.value) : null;
  return preview && preview.expiresAt > now ? preview : null;
}

export function getWrappedAvailability(userId: number, now = Date.now()) {
  return getWrappedPreview(userId, now) ?? wrappedSeason(APP_VERSION, now);
}

export function setWrappedPreview(
  userId: number,
  timeZone: string,
  enabled: boolean,
  now = Date.now(),
) {
  if (!isWrappedPreviewBuild(APP_VERSION)) throw new Error("Preview build required");
  const key = `wrapped-preview:${userId}`;
  if (!enabled) {
    db.prepare<[string]>("DELETE FROM settings WHERE key = ?").run(key);
    return null;
  }
  const year = new Date(now).getUTCFullYear();
  wrappedPeriod(year, timeZone, now);
  const preview = {
    year,
    cutoff: now,
    expiresAt: Math.min(now + 86400000, Date.UTC(year + 1, 0, 1)),
  };
  db.prepare<[string, string]>("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    JSON.stringify(preview),
  );
  return preview;
}
