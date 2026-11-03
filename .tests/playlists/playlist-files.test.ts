import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
const [
  state,
  { db },
  { dbOps, userOps },
  honker,
  { playlistManager },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { downloadTracker },
  { playlistDisplayNames },
] = await setupIsolatedBackend(
  "playlist-files",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistFiles.ts"),
);

const { downloadRoot, libraryRoot } = playlistManager;

beforeEach(async () => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  dbOps.updateSettings({ onboardingComplete: true, flows: [], sharedPlaylists: [] });
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

afterAll(async () => {
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

async function addDownloadedTrack(playlistId: string, title: string) {
  const file = path.join(downloadRoot, "Artist", "Album", `${title}.flac`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, title);
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: title, albumName: "Album", durationMs: 61_400 },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, file, "Album");
}

const playlistFiles = async () =>
  (await fs.readdir(libraryRoot).catch(() => [])).filter((file) => file.endsWith(".m3u")).sort();

function pendingSyncs() {
  const now = Math.floor(Date.now() / 1000);
  return honker
    .listHonkerJobs("playback")
    .flatMap(({ run_at: runAt, payload }) =>
      payload?.kind === "playback-playlist-sync"
        ? [{ delaySeconds: runAt - now, entityIds: payload.entityIds, rewrite: payload.rewrite }]
        : [],
    );
}

test("writes a playlist file with relative paths and rewrites it once later", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Road: Trip" });
  await addDownloadedTrack(playlist.id, "Song A");

  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });

  assert.deepEqual(await playlistFiles(), ["Road_ Trip.m3u"]);
  assert.equal(
    await fs.readFile(path.join(libraryRoot, "Road_ Trip.m3u"), "utf8"),
    "#EXTM3U\n#EXTINF:61,Artist - Song A\n../../Artist/Album/Song A.flac\n",
  );
  const [rewrite] = pendingSyncs();
  assert.deepEqual([rewrite.entityIds, rewrite.rewrite], [[playlist.id], true]);
  assert.ok(rewrite.delaySeconds >= 170);

  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  await playlistManager.syncPlaylists({ entityIds: [playlist.id], rewrite: true });
  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });
  assert.deepEqual(pendingSyncs(), []);
});

test("renaming, disabling, or deleting removes the old file", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Morning", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Keep" });
  await playlistManager.syncPlaylists();
  assert.deepEqual(await playlistFiles(), ["Keep.m3u", "Morning.m3u"]);

  flowPlaylistConfig.updateFlow(flow.id, { name: "Evening" });
  await playlistManager.syncPlaylists({ entityIds: [flow.id] });
  assert.deepEqual(await playlistFiles(), ["Evening.m3u", "Keep.m3u"]);

  flowPlaylistConfig.setEnabled(flow.id, false);
  await playlistManager.syncPlaylists({ entityIds: [flow.id] });
  assert.deepEqual(await playlistFiles(), ["Keep.m3u"]);

  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  await playlistManager.syncPlaylists();
  assert.deepEqual(await playlistFiles(), []);
});

test("names stay unique when the owner prefix is off", () => {
  const ana = userOps.createUser("ana", "hash")!.id;
  const bo = userOps.createUser("bo", "hash")!.id;
  const entities = [
    { id: "1", name: "Mix", ownerUserId: ana },
    { id: "2", name: "mix", ownerUserId: bo },
    { id: "3", name: "Solo", ownerUserId: ana },
    { id: "4", name: "Solo", ownerUserId: ana },
  ];

  assert.deepEqual(
    [...playlistDisplayNames(entities, { prefixOwnerUsername: false }).values()],
    ["ana - Mix", "bo - mix", "Solo", "Solo (2)"],
  );
  assert.deepEqual(
    [...playlistDisplayNames(entities, { prefixOwnerUsername: true }).values()],
    ["ana - Mix", "bo - mix", "ana - Solo", "ana - Solo (2)"],
  );
});
