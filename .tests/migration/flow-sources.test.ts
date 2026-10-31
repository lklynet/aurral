import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";
import type { SettingsRow } from "../../backend/db/rows.ts";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading moves Release Radar to New releases and Listening History to recent listening", async () => {
  const state = await createIsolatedStateDir("flow-sources-migration");
  const start = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { db } = await import("./backend/config/db-sqlite.ts"); db.close();',
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: {
          ...process.env,
          AURRAL_DATA_DIR: state.dataDir,
          AURRAL_DB_PATH: state.dbPath,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };

  start();
  const db = new Database(state.dbPath);
  try {
    const custom = { id: "custom", mix: { discover: 50, mix: 50, trending: 0, focus: 0 } };
    const flows = [
      { id: "radar", discoverPresetId: "release-radar", mix: { discover: 100 } },
      {
        id: "history",
        discoverPresetId: "focus-listening-history",
        description: "Tracks related to Slowdive, Ride",
        relatedArtists: ["Slowdive", "Ride"],
      },
      {
        id: "renamed",
        discoverPresetId: "focus-listening-history",
        description: "Sunday mornings",
        relatedArtists: ["Slowdive"],
      },
      custom,
    ];
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('flows', ?)").run(
      JSON.stringify(flows),
    );
    db.prepare("DELETE FROM settings WHERE key = 'migration:flow-sources-v1'").run();

    start();

    const stored = db
      .prepare<[], Pick<SettingsRow, "value">>("SELECT value FROM settings WHERE key = 'flows'")
      .get();
    assert.deepEqual(JSON.parse(stored?.value ?? "null"), [
      {
        id: "radar",
        discoverPresetId: "release-radar",
        mix: { discover: 0, mix: 0, trending: 0, focus: 0, newReleases: 100 },
      },
      {
        id: "history",
        discoverPresetId: "focus-listening-history",
        description: null,
        relatedArtists: [],
        recentListening: true,
      },
      { ...flows[2], recentListening: true },
      custom,
    ]);
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
