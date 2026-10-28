import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  honkerDb,
  { dbOps },
  { flowPlaylistConfig },
  { NavidromePlaybackDestination },
  { processSystemTask },
] = await setupIsolatedBackend(
  "honker-db-config",
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playback/navidromePlaybackDestination.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("schedule bootstrap skips stale runs without postponing recently due work", () => {
  honkerDb.bootstrapHonkerSchedules();
  const scheduler = honkerDb.getHonkerDb().scheduler();
  const now = Math.floor(Date.now() / 1000);

  const tx = honkerDb.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_scheduler_tasks SET next_fire_at = ?, priority = ? WHERE name = ?", [
    now - 3 * 60 * 60,
    99,
    "weekly-flow-refresh",
  ]);
  tx.commit();

  honkerDb.bootstrapHonkerSchedules();

  const rows = scheduler.list();
  const flowRefresh = rows.find((row) => row.name === "weekly-flow-refresh");
  assert.ok(flowRefresh != null);
  const enrichment = rows.find((row) => row.name === "playlist-mbid-enrichment-sweep");

  assert.ok(flowRefresh?.next_fire_at > now);
  assert.equal(flowRefresh?.priority, 0);

  const recentlyDue = now - 60;
  const recentTx = honkerDb.getHonkerDb().transaction();
  recentTx.execute("UPDATE _honker_scheduler_tasks SET next_fire_at = ? WHERE name = ?", [
    recentlyDue,
    "weekly-flow-refresh",
  ]);
  recentTx.commit();

  honkerDb.bootstrapHonkerSchedules();

  const preserved = scheduler.list().find((row) => row.name === "weekly-flow-refresh");
  assert.equal(preserved?.next_fire_at, recentlyDue);
  assert.equal(enrichment?.max_attempts, 4);
  assert.equal(rows.length, honkerDb.SCHEDULED_SYSTEM_TASKS.length);
});

test("queue registry survives a Honker database close and reopen", () => {
  honkerDb.closeHonkerDb();

  const queue = honkerDb.getHonkerQueueByName("system-task");
  assert.equal(queue?.name, "system-task");
  assert.equal(queue?.maxAttempts, 3);
});

test("independent system tasks use isolated queues", () => {
  assert.equal(honkerDb.getSystemTaskQueueName("inbox-refresh"), "system-task-inbox");
  assert.equal(honkerDb.getSystemTaskQueueName("news-refresh"), "system-task-maintenance");
  assert.equal(honkerDb.getSystemTaskQueueName("weekly-flow-refresh"), "system-task-maintenance");
  assert.equal(honkerDb.getSystemTaskQueueName("import-list-sync"), "system-task");
  for (const task of honkerDb.SCHEDULED_SYSTEM_TASKS) {
    if (task.queue.startsWith("system-task")) {
      assert.equal(task.queue, honkerDb.getSystemTaskQueueName(String(task.payload.kind)));
    }
  }
});

test("startup only queues due bootstrap work and a pending migration", () => {
  const db = honkerDb.getHonkerDb();
  const clearQueue = () => {
    const tx = db.transaction();
    tx.execute("DELETE FROM _honker_live");
    tx.commit();
  };
  const queuedKinds = () =>
    db
      .query("SELECT payload FROM _honker_live ORDER BY id")
      .map((row) => JSON.parse(row.payload).kind);

  clearQueue();
  honkerDb.enqueueHonkerStartupTasks();
  honkerDb.enqueueHonkerStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "playlist-startup-migration",
    "stored-data-migration",
    "identity-marker-migration",
    "weekly-flow-startup-check",
    "playlist-startup-publish",
    "discovery-bootstrap",
    "library-index-bootstrap",
    "release-metadata-refresh",
    "news-refresh",
    "trending-charts-refresh",
  ]);

  dbOps.setJSONSetting(honkerDb.PLAYLIST_STARTUP_MIGRATION_SETTING, {
    version: honkerDb.PLAYLIST_STARTUP_MIGRATION_VERSION,
    rootPath: process.env.WEEKLY_FLOW_FOLDER,
  });
  dbOps.setJSONSetting(honkerDb.STORED_DATA_MIGRATION_SETTING, {
    version: honkerDb.STORED_DATA_MIGRATION_VERSION,
  });
  dbOps.setJSONSetting(honkerDb.IDENTITY_MARKER_MIGRATION_SETTING, {
    version: honkerDb.IDENTITY_MARKER_MIGRATION_VERSION,
  });
  clearQueue();
  honkerDb.enqueueHonkerStartupTasks();
  assert.deepEqual(queuedKinds(), [
    "weekly-flow-startup-check",
    "playlist-startup-publish",
    "discovery-bootstrap",
    "library-index-bootstrap",
    "release-metadata-refresh",
    "news-refresh",
    "trending-charts-refresh",
  ]);
});

test("playlists publish from the startup task, not when a process loads the playlist manager", async () => {
  dbOps.updateSettings({
    integrations: {
      navidrome: { url: "http://navidrome.invalid", username: "test", password: "password" },
    },
    flows: [],
    sharedPlaylists: [],
  });
  const flow = flowPlaylistConfig.createFlow({ name: "Startup Flow", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Startup Playlist" });
  const calls: string[] = [];
  vi.spyOn(NavidromePlaybackDestination.prototype, "ensureLibrary").mockImplementation(async () => {
    calls.push("ensure library");
    return { ok: true };
  });
  vi.spyOn(NavidromePlaybackDestination.prototype, "publishPlaylist").mockImplementation(
    async (snapshot) => {
      assert.ok(snapshot != null);
      calls.push(String(snapshot.entityId));
      return { ok: true };
    },
  );

  const nodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await import(
      /* @vite-ignore */ `../../backend/services/playlists/playlistManager.ts?process=${Date.now()}`
    );
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  assert.deepEqual([...calls], []);

  await processSystemTask({ kind: "playlist-startup-publish" });
  assert.deepEqual([...calls], []);
  const [sync] = honkerDb
    .listHonkerJobs("playback")
    .filter((job) => job.payload?.kind === "playback-playlist-sync");
  assert.deepEqual(sync.payload, { kind: "playback-playlist-sync", entityIds: null, attempt: 0 });
  honkerDb.getPlaybackTaskQueue().cancel(sync.id);
  await processSystemTask(sync.payload);
  assert.equal(calls[0], "ensure library");
  assert.deepEqual(calls.slice(1).sort(), [flow.id, playlist.id].sort());
});
