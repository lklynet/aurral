import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { missingUpgradeSteps } from "../../backend/config/upgrade-gate.ts";

const FINISHED_2X: Record<string, unknown> = {
  schemaVersion: 4,
  storedDataMigration: { version: 3 },
  identityMarkerMigration: { version: 2 },
  playlistStartupMigration: { version: 1 },
  aurralDownloadFolderMigration: { version: 1, status: "complete" },
  ...Object.fromEntries(
    [
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
    ].map((name) => [`migration:${name}`, "1"]),
  ),
};

const databaseWith = (settings: Record<string, unknown> | null) => {
  const db = new Database(":memory:");
  if (!settings) {
    db.exec("CREATE TABLE playlist_download_jobs (id TEXT PRIMARY KEY)");
    return db;
  }
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(settings)) {
    insert.run(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return db;
};

test.each([
  ["a new database", () => new Database(":memory:"), []],
  ["a database 3.0 already opened", () => databaseWith({ schemaVersion: 5 }), []],
  ["a database that finished 2.x", () => databaseWith(FINISHED_2X), []],
  [
    "a folder move that left items for review",
    () =>
      databaseWith({
        ...FINISHED_2X,
        aurralDownloadFolderMigration: { version: 1, status: "needs-review" },
      }),
    [],
  ],
  [
    "an interrupted folder move",
    () =>
      databaseWith({
        ...FINISHED_2X,
        aurralDownloadFolderMigration: { version: 1, status: "pending" },
      }),
    ["aurralDownloadFolderMigration"],
  ],
  [
    "an older 2.x stored data step",
    () => databaseWith({ ...FINISHED_2X, storedDataMigration: { version: 2 } }),
    ["storedDataMigration"],
  ],
  [
    "a missing one-time migration",
    () => {
      const db = databaseWith(FINISHED_2X);
      db.prepare("DELETE FROM settings WHERE key = 'migration:name-guesses-v2'").run();
      return db;
    },
    ["migration:name-guesses-v2"],
  ],
])("%s", (_name, open, expected) => {
  const db = open();
  assert.deepEqual(missingUpgradeSteps(db), expected);
  db.close();
});

test("a database without settings is refused, not treated as new", () => {
  const db = databaseWith(null);
  assert.ok(missingUpgradeSteps(db).includes("schemaVersion"));
  db.close();
});
