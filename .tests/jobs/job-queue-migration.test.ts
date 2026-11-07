import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, afterAll } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state, { migrateToJobQueue }] = await setupIsolatedBackend(
  "job-queue-migration",
  () => import("../../backend/config/job-queue-migration.ts"),
);
afterAll(() => cleanupIsolatedState(state));

function honkerDatabase(dir: string, nowS: number) {
  const db = new Database(path.join(dir, "legacy.db"));
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE playlist_download_jobs (id TEXT PRIMARY KEY, playlist_id TEXT, playlist_type TEXT);
    CREATE TABLE playlist_download_jobs_revision (id INTEGER PRIMARY KEY, revision INTEGER);
    CREATE TABLE weekly_flow_download_cancellations (playlist_id TEXT PRIMARY KEY, generation INTEGER);
    CREATE TABLE weekly_flow_download_job_cancellations (job_id TEXT PRIMARY KEY);
    CREATE TABLE weekly_flow_download_provider_work (job_id TEXT, playlist_id TEXT);
    CREATE TABLE honker_task_runs (id INTEGER PRIMARY KEY);
    CREATE TABLE _honker_live (
      id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT, payload TEXT, priority INTEGER,
      state TEXT, run_at INTEGER, attempts INTEGER, max_attempts INTEGER, created_at INTEGER
    );
    CREATE TABLE _honker_dead (
      id INTEGER PRIMARY KEY, queue TEXT, payload TEXT, priority INTEGER, run_at INTEGER,
      attempts INTEGER, max_attempts INTEGER, created_at INTEGER, last_error TEXT, died_at INTEGER
    );
    CREATE TABLE _honker_scheduler_tasks (
      name TEXT PRIMARY KEY, queue TEXT, cron_expr TEXT, payload TEXT, priority INTEGER,
      next_fire_at INTEGER, max_attempts INTEGER
    );
  `);
  const setting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  setting.run("sharedPlaylists", "[]");
  setting.run("weeklyFlowOperationTokens:flow-1", "{}");
  setting.run("weeklyFlowIncompleteRetryJobs", "[]");
  setting.run("integrations", JSON.stringify({ notifications: { notifyWeeklyFlowDone: true } }));
  db.prepare("INSERT INTO playlist_download_jobs VALUES ('job-1', 'flow-1', 'flow-1')").run();
  const live = db.prepare(
    "INSERT INTO _honker_live (id, queue, payload, priority, state, run_at, attempts, max_attempts, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, 3, ?)",
  );
  live.run(
    10,
    "slskd-pipeline",
    JSON.stringify({ jobId: "job-1", phase: "search" }),
    "pending",
    nowS + 60,
    0,
    nowS,
  );
  live.run(
    11,
    "weekly-flow-operation",
    JSON.stringify({ kind: "shared-playlist-bulk", label: "shared-playlist:Mix" }),
    "processing",
    nowS,
    3,
    nowS,
  );
  live.run(
    12,
    "system-task",
    JSON.stringify({ kind: "release-metadata-refresh" }),
    "pending",
    nowS,
    0,
    nowS,
  );
  live.run(
    13,
    "system-task-maintenance",
    JSON.stringify({ kind: "weekly-flow-refresh" }),
    "pending",
    nowS,
    0,
    nowS,
  );
  const dead = db.prepare(
    "INSERT INTO _honker_dead VALUES (?, '_outbox:notifications', '{\"kind\":\"webhook\"}', 0, ?, 5, 5, ?, 'refused', ?)",
  );
  dead.run(14, nowS, nowS, nowS - 60);
  dead.run(15, nowS, nowS, nowS - 2 * 60 * 60);
  db.prepare(
    "INSERT INTO _honker_scheduler_tasks VALUES ('weekly-flow-refresh', 'system-task-maintenance', '@every 1h', '{\"kind\":\"weekly-flow-refresh\"}', 0, ?, 3)",
  ).run(nowS + 600);
  db.prepare("UPDATE sqlite_sequence SET seq = 40 WHERE name = '_honker_live'").run();
  return db;
}

test("a Honker database moves its tables, settings, jobs, and schedules over in one pass", () => {
  const dir = fs.mkdtempSync(path.join(state.baseDir, "honker-"));
  const nowS = Math.floor(Date.now() / 1000);
  const db = honkerDatabase(dir, nowS);
  const tables = () =>
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  try {
    migrateToJobQueue(db, dir);

    assert.ok(fs.existsSync(path.join(dir, "aurral.pre-job-queue.db")));
    assert.deepEqual(tables(), [
      "_honker_dead",
      "_honker_live",
      "_honker_scheduler_tasks",
      "download_cancellations",
      "download_job_cancellations",
      "download_jobs",
      "download_jobs_revision",
      "download_provider_work",
      "job_locks",
      "job_schedules",
      "jobs",
      "settings",
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM download_jobs").all(), [
      { id: "job-1", owner_id: "flow-1", owner_type: "flow-1" },
    ]);
    assert.deepEqual(
      db
        .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'migration:%' ORDER BY key")
        .all(),
      [
        { key: "integrations", value: '{"notifications":{"notifyFlowDone":true}}' },
        { key: "playlistOperationTokens:flow-1", value: "{}" },
        { key: "staticPlaylists", value: "[]" },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT id, queue, kind, payload, state, run_at, attempts, finished_at, last_error FROM jobs ORDER BY id",
        )
        .all(),
      [
        {
          id: 10,
          queue: "download-pipeline",
          kind: "download-pipeline",
          payload: '{"jobId":"job-1","phase":"search"}',
          state: "pending",
          run_at: (nowS + 60) * 1000,
          attempts: 0,
          finished_at: null,
          last_error: null,
        },
        {
          id: 11,
          queue: "playlist-operation",
          kind: "static-playlist-bulk",
          payload: '{"kind":"static-playlist-bulk","label":"static-playlist:Mix"}',
          state: "pending",
          run_at: nowS * 1000,
          attempts: 2,
          finished_at: null,
          last_error: null,
        },
        {
          id: 12,
          queue: "release-metadata-refresh",
          kind: "release-metadata-refresh",
          payload: '{"kind":"release-metadata-refresh"}',
          state: "pending",
          run_at: nowS * 1000,
          attempts: 0,
          finished_at: null,
          last_error: null,
        },
        {
          id: 13,
          queue: "system-task-maintenance",
          kind: "flow-refresh",
          payload: '{"kind":"flow-refresh"}',
          state: "pending",
          run_at: nowS * 1000,
          attempts: 0,
          finished_at: null,
          last_error: null,
        },
        {
          id: 14,
          queue: "notifications",
          kind: "webhook",
          payload: '{"kind":"webhook"}',
          state: "failed",
          run_at: nowS * 1000,
          attempts: 5,
          finished_at: (nowS - 60) * 1000,
          last_error: "refused",
        },
      ],
    );
    assert.deepEqual(db.prepare("SELECT * FROM job_schedules").all(), [
      {
        name: "flow-refresh",
        queue: "system-task-maintenance",
        kind: "flow-refresh",
        payload: '{"kind":"flow-refresh"}',
        interval_ms: 60 * 60 * 1000,
        next_run_at: (nowS + 600) * 1000,
        priority: 0,
        max_attempts: 3,
      },
    ]);
    const next = db
      .prepare<[], { id: number }>(
        "INSERT INTO jobs (queue, kind, payload, state, run_at, max_attempts, created_at) VALUES ('q', 'k', '{}', 'pending', 0, 1, 0) RETURNING id",
      )
      .get();
    assert.equal(next?.id, 41);

    migrateToJobQueue(db, dir);
    assert.equal(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM jobs").get()?.count,
      6,
    );
  } finally {
    db.close();
  }
});
