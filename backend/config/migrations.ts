import type Database from "better-sqlite3";
import { createAurral3Schema } from "./aurral-3-schema.ts";

type Migration = (db: Database.Database) => void;

const indexFinishedDownloadNames: Migration = (db) =>
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_download_jobs_done_name
      ON download_jobs(lower(trim(coalesce(track_name, ''))))
      WHERE status = 'done' AND final_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_download_jobs_done_unicode_name
      ON download_jobs(id)
      WHERE status = 'done' AND final_path IS NOT NULL AND (track_name GLOB '*[^ -~]*' OR length(track_name) <> length(CAST(track_name AS BLOB)));
  `);

export const migrations: Migration[] = [createAurral3Schema, indexFinishedDownloadNames];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations) {
  const applied = () => Number(db.pragma("user_version", { simple: true }));
  if (applied() >= steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(applied())) step(db);
    db.pragma(`user_version = ${steps.length}`);
  }).immediate();
}
