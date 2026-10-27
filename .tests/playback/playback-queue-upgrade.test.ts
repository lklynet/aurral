import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "downloads";
const [
  state,
  { dbOps },
  honker,
  { playlistManager },
  { flowPlaylistConfig },
  { downloadTracker },
  systemTaskWorker,
  { shutdownHonkerInfrastructure },
] = await setupIsolatedBackend(
  "playback-queue-upgrade",
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/honkerWorkerRuntime.ts"),
);
const originalFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await shutdownHonkerInfrastructure();
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

test("media server jobs an older version left in the system task queue, including one it was running, run on the playback queue after an upgrade", async () => {
  const downloadRoot = playlistManager.downloadRoot;
  const file = path.join(downloadRoot, "Artist", "Album", "Upgrade Song.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  dbOps.updateSettings({
    integrations: {
      navidrome: { url: "http://navidrome.test", username: "test", password: "password" },
    },
    onboardingComplete: true,
  });
  const navidrome = createFakeNavidrome({
    libraries: [{ id: 1, name: "Aurral Playlists", path: downloadRoot }],
    songs: [
      {
        id: "upgrade-song",
        libraryPath: downloadRoot,
        path: "Artist/Album/Upgrade Song.flac",
        title: "Upgrade Song",
        artist: "Artist",
      },
    ],
  });
  globalThis.fetch = navidrome.fetch;
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Upgraded" });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Upgrade Song", albumName: "Album" },
    playlist.id,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, file, "Album");

  const legacy = honker.getSystemTaskQueue();
  const interruptedId = legacy.enqueue({ kind: "playback-library-scan" });
  assert.equal(legacy.claimOne("older-version-worker")!.id, interruptedId);
  const syncId = legacy.enqueue({
    kind: "playback-playlist-sync",
    entityIds: [playlist.id],
    attempt: 0,
  });
  const navidromeScanId = legacy.enqueue({
    kind: "playback-library-scan",
    folders: [path.dirname(file)],
    destinations: ["navidrome"],
  });
  const unrelatedId = legacy.enqueue(
    { kind: "import-list-sync" },
    { runAt: Math.floor(Date.now() / 1000) + 3600 },
  );

  honker.bootstrapHonkerSchedules();
  assert.deepEqual(
    honker.listHonkerJobs("playback").map(({ id, state }) => [id, state]),
    [
      [interruptedId, "pending"],
      [syncId, "pending"],
      [navidromeScanId, "pending"],
    ],
  );
  assert.deepEqual(
    honker.listHonkerJobs("system-task").map(({ id }) => id),
    [unrelatedId],
  );

  const events = honker.getHonkerDb().updateEvents();
  try {
    void systemTaskWorker.startPlaybackTaskWorker();
    while (honker.listHonkerJobs("playback").length) await events.next();
  } finally {
    events.close();
  }

  assert.deepEqual(
    navidrome.playlists.map(({ name, songIds }) => ({ name, songIds })),
    [{ name: "Upgraded", songIds: ["upgrade-song"] }],
  );
  assert.deepEqual(navidrome.scans, [["1:"], ["1:Artist/Album"]]);
  assert.deepEqual(
    honker.listHonkerJobs("system-task").map(({ id }) => id),
    [unrelatedId],
  );
});
