import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-config");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { dbOps }, { flowPlaylistConfig }] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/config/db-helpers.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistConfig.js"),
]);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    weeklyFlows: [],
    sharedFlowPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("creates flows with normalized scheduling and enforces unique names", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Late Night",
    size: 25,
    mix: { discover: 60, mix: 25, trending: 15 },
    scheduleDays: [5, 1, 5],
    scheduleTime: "6:30",
  });

  assert.equal(flow.name, "Late Night");
  assert.deepEqual(flow.scheduleDays, [1, 5]);
  assert.equal(flow.scheduleTime, "06:00");
  assert.equal(flow.enabled, false);

  assert.throws(
    () =>
      flowPlaylistConfig.createFlow({
        name: "late night",
      }),
    /already exists/,
  );
});

test("stores full shared playlists but exposes trackless summaries for hot paths", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Road Trip",
    sourceName: "Discover Weekly",
    sourceFlowId: "flow-123",
    tracks: [
      {
        artistName: "Artist One",
        trackName: "Track One",
        albumName: "Album One",
      },
      {
        artistName: "Artist Two",
        trackName: "Track Two",
      },
    ],
  });

  const stored = flowPlaylistConfig.getSharedPlaylist(playlist.id);
  const summaries = flowPlaylistConfig.getSharedPlaylistSummaries();

  assert.equal(stored?.tracks?.length, 2);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].trackCount, 2);
  assert.equal("tracks" in summaries[0], false);
  assert.equal(summaries[0].sourceName, "Discover Weekly");
});

test("updates shared playlists and keeps summaries in sync", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Gym Mix",
    tracks: [
      { artistName: "A", trackName: "One" },
      { artistName: "B", trackName: "Two" },
    ],
  });

  const updated = flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
    name: "Gym Mix Updated",
    tracks: [{ artistName: "C", trackName: "Three" }],
  });
  const summary = flowPlaylistConfig
    .getSharedPlaylistSummaries()
    .find((entry) => entry.id === playlist.id);

  assert.equal(updated?.name, "Gym Mix Updated");
  assert.equal(updated?.tracks?.length, 1);
  assert.equal(summary?.name, "Gym Mix Updated");
  assert.equal(summary?.trackCount, 1);
});
