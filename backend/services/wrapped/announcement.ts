import { db } from "../../config/db-sqlite.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { getWrappedReport, validateWrappedRequest } from "./reports.ts";

const read = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);

export function getWrappedAnnouncement(userId: number, year: number, timeZone: string) {
  validateWrappedRequest(userId, year, timeZone);
  const row = read.get(`wrapped-banner:${userId}`);
  const dismissal: { year: number; expiresAt: number } | null = row ? JSON.parse(row.value) : null;
  const report = getWrappedReport(userId, year, timeZone);
  const summary = report?.state === "ready" ? report.summary : null;
  const artwork = summary
    ? [...summary.topAlbums, ...summary.topArtists, ...summary.topSongs]
        .flatMap((item) => (item.artwork ? [item.artwork] : []))
        .filter((url, index, urls) => urls.indexOf(url) === index)
        .slice(0, 4)
    : [];
  return {
    year,
    state: report?.state ?? "missing",
    ready: summary !== null && summary.totalPlays > 0,
    hidden: dismissal?.year === year && dismissal.expiresAt > Date.now(),
    artwork,
  };
}

export function setWrappedAnnouncementHidden(
  userId: number,
  year: number,
  timeZone: string,
  hidden: boolean,
) {
  const season = validateWrappedRequest(userId, year, timeZone);
  const key = `wrapped-banner:${userId}`;
  if (hidden) {
    db.prepare<[string, string]>("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      key,
      JSON.stringify({ year, expiresAt: season.expiresAt }),
    );
  } else {
    db.prepare<[string]>("DELETE FROM settings WHERE key = ?").run(key);
  }
  return getWrappedAnnouncement(userId, year, timeZone);
}
