import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as v from "valibot";
import { test, beforeEach, afterAll } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  startup,
  schedules,
  { playbackTaskQueue, systemTaskSchema },
  { flowPlaylistConfig },
  { playlistManager },
  { processSystemTask },
] = await setupIsolatedBackend(
  "job-startup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/jobs/startup.ts"),
  () => import("../../backend/services/jobs/schedules.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
);

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

test("syncing schedules skips runs missed long ago without postponing recently due ones", () => {
  const now = Date.now();
  schedules.syncSchedules(now);
  const nextRun = (name: string) =>
    schedules.listSchedules().find((row) => row.name === name)?.next_run_at;
  const setNextRun = (name: string, at: number) =>
    db
      .prepare("UPDATE job_schedules SET next_run_at = ?, priority = 99 WHERE name = ?")
      .run(at, name);

  setNextRun("flow-refresh", now - 3 * 60 * 60 * 1000);
  setNextRun("session-cleanup", now - 60_000);
  schedules.syncSchedules(now);

  assert.equal(nextRun("flow-refresh"), now + 60 * 60 * 1000);
  assert.equal(nextRun("session-cleanup"), now - 60_000);
  assert.ok(schedules.listSchedules().every((row) => row.priority !== 99));
  assert.equal(schedules.listSchedules().length, schedules.SCHEDULES.length);
});

test("startup only queues bootstrap work once, and a migration only while it is pending", () => {
  const queuedKinds = () =>
    db
      .prepare<[], { kind: string }>("SELECT kind FROM jobs ORDER BY id")
      .all()
      .map((row) => row.kind);

  startup.enqueueStartupTasks();
  startup.enqueueStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "playlist-startup-migration",
    "stored-data-migration",
    "identity-marker-migration",
    "flow-startup-check",
    "playlist-startup-publish",
    "discovery-bootstrap",
    "library-index-bootstrap",
    "release-metadata-refresh",
    "news-refresh",
    "trending-charts-refresh",
  ]);

  dbOps.setJSONSetting(startup.PLAYLIST_STARTUP_MIGRATION_SETTING, {
    version: startup.PLAYLIST_STARTUP_MIGRATION_VERSION,
    rootPath: process.env.WEEKLY_FLOW_FOLDER,
  });
  dbOps.setJSONSetting(startup.STORED_DATA_MIGRATION_SETTING, {
    version: startup.STORED_DATA_MIGRATION_VERSION,
  });
  dbOps.setJSONSetting(startup.IDENTITY_MARKER_MIGRATION_SETTING, {
    version: startup.IDENTITY_MARKER_MIGRATION_VERSION,
  });
  db.prepare("DELETE FROM jobs").run();
  startup.enqueueStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "flow-startup-check",
    "playlist-startup-publish",
    "discovery-bootstrap",
    "library-index-bootstrap",
    "release-metadata-refresh",
    "news-refresh",
    "trending-charts-refresh",
  ]);
});

test("playlists publish from the startup task, not when a process loads the playlist manager", async () => {
  dbOps.updateSettings({ flows: [], staticPlaylists: [] });
  const flow = flowPlaylistConfig.createFlow({ name: "Startup Flow", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Startup Playlist" });
  const files = () => fs.readdir(playlistManager.libraryRoot).catch(() => []);

  const nodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await import(
      /* @vite-ignore */ `../../backend/services/playlists/playlistManager.ts?process=${Date.now()}`
    );
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  assert.deepEqual(await files(), []);

  await processSystemTask({ kind: "playlist-startup-publish" });
  assert.deepEqual(await files(), []);
  const [sync] = playbackTaskQueue.list().filter((job) => job.kind === "playback-playlist-sync");
  assert.ok(sync);
  assert.deepEqual(sync.payload, {
    kind: "playback-playlist-sync",
    entityIds: null,
    rewrite: false,
  });
  playbackTaskQueue.cancel(sync.id);
  await processSystemTask(v.parse(systemTaskSchema, sync.payload));
  assert.deepEqual((await files()).filter((file) => file.endsWith(".m3u")).sort(), [
    `${flow.name}.m3u`,
    `${playlist.name}.m3u`,
  ]);
});
