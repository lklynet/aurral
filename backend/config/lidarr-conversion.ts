import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import * as v from "valibot";
import { resolveDefaultDownloadRoot } from "../services/downloadFolderConfig.ts";
import { logger } from "../services/logger.ts";
import { getPathMappings, resolveLocalPath, syncPathMappings } from "../services/pathMappings.ts";

const MIGRATION_KEY = "migration:lidarr-conversion-v1";
const SNAPSHOT_NAME = "aurral.pre-lidarr-conversion.db";
export const LIDARR_CONVERSION_REPORT_KEY = "lidarrConversion";

const LIDARR_METADATA_PATHS = [
  "librarySource",
  "id",
  "monitored",
  "monitor",
  "monitorNewItems",
  "addOptions",
  "path",
  "qualityProfile",
  "rootFolderPath",
  "statistics",
  "monitorOption",
]
  .map((key) => `'$.${key}'`)
  .join(", ");

const lidarrSettings = v.fallback(
  v.object({
    lidarr: v.optional(
      v.looseObject({
        enabled: v.optional(v.unknown()),
        apiKey: v.optional(v.unknown()),
        rootFolderPath: v.optional(v.unknown()),
        rootFolderPaths: v.optional(v.array(v.unknown())),
      }),
    ),
  }),
  {},
);

export const lidarrConversionReport = v.object({
  convertedAt: v.number(),
  folders: v.array(
    v.object({ lidarrPath: v.string(), path: v.string(), sharesLibraryFolder: v.boolean() }),
  ),
  artistIds: v.array(v.number()),
});

function parse(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const outermost = (folders: string[]) =>
  [...new Set(folders)].filter(
    (folder) => !folders.some((other) => other !== folder && isWithin(other, folder)),
  );

// Aurral 3 always runs the Library. An install that Lidarr ran keeps its
// music: Lidarr's root folders become read-only folders, so Aurral plays the
// files and never renames, retags, upgrades, or deletes them, and every
// artist and album becomes Aurral's with the same IDs, unmonitored. Nothing
// here calls Lidarr.
export function convertLidarrLibrary(db: Database.Database, dataDir: string) {
  const setting = db.prepare<[string], string>("SELECT value FROM settings WHERE key = ?").pluck();
  if (setting.get(MIGRATION_KEY)) return null;
  const finish = () =>
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(MIGRATION_KEY);
  const hasLidarrMode = db
    .prepare("SELECT 1 FROM pragma_table_info('library_management') WHERE name = 'managed_by'")
    .get();
  const lidarr = v.parse(lidarrSettings, parse(setting.get("integrations"))).lidarr ?? {};
  const connected =
    lidarr.enabled !== false && Boolean(lidarr.apiKey || process.env.LIDARR_API_KEY?.trim());
  const hasLidarrData =
    hasLidarrMode &&
    db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM library_media_files WHERE source = 'lidarr')
           OR EXISTS (SELECT 1 FROM library_management WHERE managed_by = 'lidarr')`,
      )
      .get();
  if (!hasLidarrMode || (!connected && !hasLidarrData)) {
    finish();
    return null;
  }

  const snapshot = path.join(dataDir, SNAPSHOT_NAME);
  if (!fs.existsSync(snapshot)) db.prepare("VACUUM INTO ?").run(snapshot);

  const report = db
    .transaction(() => {
      if (setting.get(MIGRATION_KEY)) return null;
      const now = Date.now();
      syncPathMappings(parse(setting.get("pathMappings")));
      const mappings = getPathMappings("lidarr");
      const downloadRoot = path.resolve(
        String(setting.get("downloadFolderPath") ?? "").trim() || resolveDefaultDownloadRoot(),
      );
      const folders = [
        ...new Map(
          [...(lidarr.rootFolderPaths ?? []), lidarr.rootFolderPath]
            .map((root) => String(root ?? "").trim())
            .filter(Boolean)
            .map((lidarrPath) => {
              const folder = path.resolve(resolveLocalPath(lidarrPath, mappings));
              return [
                folder,
                { lidarrPath, path: folder, sharesLibraryFolder: isWithin(downloadRoot, folder) },
              ] as const;
            }),
        ).values(),
      ];

      const readOnly = v.parse(
        v.fallback(v.array(v.string()), []),
        parse(setting.get("readOnlyFolders")),
      );
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('readOnlyFolders', ?)").run(
        JSON.stringify(
          outermost(
            [...readOnly, ...folders.map((folder) => folder.path)].map((folder) =>
              path.resolve(folder),
            ),
          ),
        ),
      );

      db.prepare(
        "UPDATE OR IGNORE library_media_files SET source = 'readonly', updated_at = ? WHERE source = 'lidarr'",
      ).run(now);
      db.prepare("DELETE FROM library_media_files WHERE source = 'lidarr'").run();
      const claim = db.prepare<[number, number, string]>(
        `UPDATE OR IGNORE library_media_files SET source = 'readonly', updated_at = ?
         WHERE source = 'aurral' AND substr(path, 1, ?) = ?`,
      );
      const dropTwins = db.prepare<[number, string]>(
        "DELETE FROM library_media_files WHERE source = 'aurral' AND substr(path, 1, ?) = ?",
      );
      for (const folder of folders.filter((entry) => entry.sharesLibraryFolder)) {
        const prefix = folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep;
        claim.run(now, prefix.length, prefix);
        dropTwins.run(prefix.length, prefix);
      }

      const artistIds = db
        .prepare<[], number>(
          `SELECT management.entity_id FROM library_management AS management
           JOIN library_artists AS artist ON artist.id = management.entity_id
           WHERE management.entity_kind = 'artist' AND management.managed_by = 'lidarr'
             AND coalesce(management.monitor_mode, 'none') <> 'none' AND artist.mbid IS NOT NULL
           ORDER BY management.entity_id`,
        )
        .pluck()
        .all();
      db.prepare(
        `UPDATE library_management
         SET managed_by = 'aurral',
           monitor_mode = CASE entity_kind WHEN 'artist' THEN 'none' ELSE NULL END,
           monitor_rules = NULL,
           updated_at = ?
         WHERE managed_by = 'lidarr'`,
      ).run(now);
      for (const table of ["library_artists", "library_albums"]) {
        db.prepare(
          `UPDATE ${table}
           SET metadata_json = json_remove(metadata_json, ${LIDARR_METADATA_PATHS}), updated_at = ?
           WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'`,
        ).run(now);
      }

      db.prepare(
        `UPDATE download_jobs SET status = 'cancelled', error = 'Lidarr no longer runs the Library'
         WHERE managed_by = 'lidarr' AND status NOT IN ('done', 'failed', 'cancelled')`,
      ).run();
      db.prepare(
        "UPDATE download_jobs SET managed_by = 'aurral' WHERE managed_by = 'lidarr'",
      ).run();

      const converted = { convertedAt: now, folders, artistIds };
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        LIDARR_CONVERSION_REPORT_KEY,
        JSON.stringify(converted),
      );
      finish();
      return converted;
    })
    .immediate();

  if (report) {
    logger.info("migration", "Aurral now runs the Library that Lidarr ran", {
      readOnlyFolders: report.folders.map((folder) => folder.path),
      artists: report.artistIds.length,
      snapshot,
    });
  }
  return report;
}
