import type Database from "better-sqlite3";
import * as v from "valibot";

export const SCHEMA_VERSION = 5;

const ONE_TIME_MIGRATIONS = [
  "album-credits-v1",
  "aurral-album-monitored-v1",
  "aurral-missing-monitor-mode-v1",
  "aurral-monitoring-rules-v1",
  "aurral-track-monitoring-v1",
  "flow-sources-v1",
  "name-guesses-v1",
  "name-guesses-v2",
  "per-user-discovery-v1",
  "play-album-stats-v2",
  "retire-discover-playlists-v1",
  "retired-flows-v1",
  "unified-discovery-source-v1",
];

const versioned = v.looseObject({ version: v.number(), status: v.optional(v.string()) });

const SETTINGS_MARKERS: [key: string, done: (value: unknown) => boolean][] = [
  ["schemaVersion", (value) => Number(value) >= 4],
  ["storedDataMigration", (value) => v.is(versioned, value) && value.version >= 3],
  ["identityMarkerMigration", (value) => v.is(versioned, value) && value.version >= 2],
  ["playlistStartupMigration", (value) => v.is(versioned, value) && value.version >= 1],
  [
    "aurralDownloadFolderMigration",
    (value) => v.is(versioned, value) && value.version >= 1 && value.status === "complete",
  ],
  ...ONE_TIME_MIGRATIONS.map((name): [string, () => boolean] => [`migration:${name}`, () => true]),
];

const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export function missingUpgradeSteps(db: Database.Database) {
  const tables = new Set(
    db.prepare<[], string>("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all(),
  );
  if (tables.size === 0) return [];
  const settings = new Map(
    tables.has("settings")
      ? db
          .prepare<[], { key: string; value: string }>("SELECT key, value FROM settings")
          .all()
          .map((row) => [row.key, parse(row.value)])
      : [],
  );
  if (Number(settings.get("schemaVersion")) >= SCHEMA_VERSION) return [];
  return SETTINGS_MARKERS.filter(
    ([key, done]) => !settings.has(key) || !done(settings.get(key)),
  ).map(([key]) => key);
}
