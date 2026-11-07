import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { downloadTracker }, { flowPlaylistConfig }, { updateStaticPlaylist }] =
  await setupIsolatedBackend(
    "static-playlist-update-race",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
    () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
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
  const getPlaylist = flowPlaylistConfig.getStaticPlaylist.bind(flowPlaylistConfig);
  vi.spyOn(flowPlaylistConfig, "getStaticPlaylist").mockImplementationOnce((id) => {
    const playlist = getPlaylist(id);
    flowPlaylistConfig.deleteStaticPlaylist(playlistId);
    return playlist;
  });

  const result = await updateStaticPlaylist({ playlistId, hasTracksUpdate: true, tracks: [] });

  assert.deepEqual(result, { missing: true });
});
