// Download-owner-only catalog in Aurral's established SQLite settings owner.
// No media-side files, new tables, job metadata markers, or legacy adoption.
import { isDownloadOwnerProcess } from "./downloadJobs/downloadOwnerClient.ts";
import { db } from "../config/db-sqlite.ts";
export const COMPLETED_NZB_KEY = "completedNzbReuse:v1";
export const completedNzbStore = {
  load(): unknown[] {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(COMPLETED_NZB_KEY) as { value: string } | undefined;
    if (!row) return [];
    const data = JSON.parse(row.value);
    if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error("Completed NZB catalog unavailable: invalid format");
    return data.entries;
  },
  save(entries: unknown[]) {
    if (!isDownloadOwnerProcess()) throw new Error("Completed NZB mutation requires download owner");
    // A single SQLite statement is atomic, including across process interruption.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(COMPLETED_NZB_KEY, JSON.stringify({ version: 1, entries }));
  },
};
