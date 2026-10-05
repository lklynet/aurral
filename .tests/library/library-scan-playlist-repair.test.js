import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  state,
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { scanConfiguredLibrary },
] = await setupIsolatedBackend(
  "library-scan-playlist-repair",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/libraryIndexService.js",
);
test.after(() => cleanupIsolatedState(state));

test("a library refresh removes playlist tracks whose downloads no longer exist", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-scan-playlist-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const deletedJobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Deleted" }, "library");
  const keptJobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Kept" }, "library");
  const repaired = flowPlaylistConfig.createStaticPlaylist({
    name: "Repaired",
    tracks: [
      { artistName: "Artist", trackName: "Deleted", canonicalJobId: deletedJobId },
      { artistName: "Artist", trackName: "Kept", canonicalJobId: keptJobId },
    ],
  });
  const untouched = flowPlaylistConfig.createStaticPlaylist({
    name: "Untouched",
    tracks: [{ artistName: "Artist", trackName: "Kept", canonicalJobId: keptJobId }],
  });
  const alsoRepaired = flowPlaylistConfig.createStaticPlaylist({
    name: "Also repaired",
    tracks: [{ artistName: "Artist", trackName: "Deleted", canonicalJobId: deletedJobId }],
  });
  downloadTracker.removeJob(deletedJobId);
  const refreshPlaylist = t.mock.method(playlistManager, "refreshPlaylist", async (playlistId) => {
    if (playlistId === repaired.id) throw new Error("artwork write failed");
  });

  await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

  assert.deepEqual(flowPlaylistConfig.getStaticPlaylist(repaired.id).tracks, repaired.tracks.slice(1));
  assert.deepEqual(flowPlaylistConfig.getStaticPlaylist(untouched.id).tracks, untouched.tracks);
  assert.deepEqual(flowPlaylistConfig.getStaticPlaylist(alsoRepaired.id).tracks, []);
  assert.deepEqual(
    refreshPlaylist.mock.calls.map((call) => call.arguments[0]),
    [repaired.id, alsoRepaired.id],
  );
});
