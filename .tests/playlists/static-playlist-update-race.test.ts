import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { downloadTracker },
  { flowPlaylistConfig },
  { downloadWorker },
  { updateStaticPlaylist },
] = await setupIsolatedBackend(
  "static-playlist-update-race",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
);

beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanupIsolatedState(state);
});

test("a track update reports a playlist deleted while it waited for the lock as missing", async () => {
  const playlistId = "deleted-while-waiting";
  flowPlaylistConfig.createStaticPlaylist({ id: playlistId, name: "Gone Soon", tracks: [] });
  downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, playlistId);
  const blockPlaylist = downloadWorker.blockPlaylist.bind(downloadWorker);
  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementationOnce(async (id: string) => {
    flowPlaylistConfig.deleteStaticPlaylist(playlistId);
    return blockPlaylist(id);
  });

  const result = await updateStaticPlaylist({ playlistId, hasTracksUpdate: true, tracks: [] });

  assert.deepEqual(result, { missing: true });
});
