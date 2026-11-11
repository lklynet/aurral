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

// Aurral runs every Library, so nothing reads who managed an artist, an album,
// or a download, and Lidarr's settings, IDs, and open requests have no reader.
const dropLidarrMode: Migration = (db) => {
  db.exec("DROP INDEX IF EXISTS idx_library_management_managed_by");
  const hasColumn = db.prepare<[string, string]>(
    "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
  );
  for (const [table, column] of [
    ["library_management", "managed_by"],
    ["download_jobs", "managed_by"],
    ["users", "lidarr_root_folder_path"],
    ["users", "lidarr_quality_profile_id"],
  ] as const) {
    if (hasColumn.get(table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  db.exec(`
    DROP TABLE IF EXISTS lidarr_artist_id_map;
    UPDATE settings SET value = json_remove(value, '$.lidarr')
      WHERE key = 'integrations' AND json_valid(value);
    DELETE FROM settings WHERE key = 'rootFolderPath';
    UPDATE settings SET value = (
        SELECT json_group_array(json(mapping.value)) FROM json_each(settings.value) AS mapping
        WHERE mapping.type = 'object'
          AND lower(trim(coalesce(mapping.value ->> '$.source', ''))) <> 'lidarr'
      )
      WHERE key = 'pathMappings' AND json_valid(value) AND json_type(value) = 'array';
    UPDATE aurral_history SET status = 'completed', status_label = 'Requested',
        title = 'Requested ' || coalesce(
          CASE WHEN json_valid(metadata) THEN metadata ->> '$.albumName' END, 'album')
      WHERE kind = 'album_requested' AND status = 'processing';
  `);
};

export const migrations: Migration[] = [
  createAurral3Schema,
  indexFinishedDownloadNames,
  dropLidarrMode,
];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations) {
  const applied = () => Number(db.pragma("user_version", { simple: true }));
  if (applied() >= steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(applied())) step(db);
    db.pragma(`user_version = ${steps.length}`);
  }).immediate();
}
