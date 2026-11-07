import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";
import type { SettingsRow } from "../../backend/db/rows.ts";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading gives every saved webhook the events that were turned on for all of them", async () => {
  const state = await createIsolatedStateDir("webhook-events-migration");
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
    const gotify = { url: "http://gotify.test", notifyRequestMade: true };
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('integrations', ?)").run(
      JSON.stringify({
        gotify,
        webhookEvents: {
          notifyRequestMade: true,
          notifyRequestAvailable: false,
          notifyFlowDone: true,
        },
        webhooks: [
          { url: "http://discord.test", body: '{"content":"$albumName"}', headers: [] },
          { url: "http://ntfy.test", headers: [] },
        ],
      }),
    );
    db.prepare("DELETE FROM settings WHERE key = 'migration:webhook-events-per-webhook-v1'").run();

    start();

    const stored = db
      .prepare<[], Pick<SettingsRow, "value">>(
        "SELECT value FROM settings WHERE key = 'integrations'",
      )
      .get();
    const events = ["notifyRequestMade", "notifyFlowDone"];
    assert.deepEqual(JSON.parse(stored?.value ?? "null"), {
      gotify,
      webhooks: [
        { url: "http://discord.test", body: '{"content":"$albumName"}', headers: [], events },
        { url: "http://ntfy.test", headers: [], events },
      ],
    });
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
