import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("status-snapshot");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { dbOps }, { flowPlaylistConfig }, snapshotModule] =
  await Promise.all([
    importFromRepo("backend/config/db-sqlite.js"),
    importFromRepo("backend/config/db-helpers.js"),
    importFromRepo("backend/services/weeklyFlowPlaylistConfig.js"),
    importFromRepo("backend/services/weeklyFlowStatusSnapshot.js"),
  ]);

const { getWeeklyFlowStatusSnapshot } = snapshotModule;

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

test("status snapshot includes shared playlist summaries without embedding track arrays", () => {
  const tracks = Array.from({ length: 250 }, (_, index) => ({
    artistName: `Artist ${index}`,
    trackName: `Track ${index}`,
  }));

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Big Import",
    sourceName: "Exported JSON",
    tracks,
  });

  const status = getWeeklyFlowStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.trackCount, 250);
  assert.equal("tracks" in shared, false);
  assert.equal(shared.sourceName, "Exported JSON");

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("Artist 249"), false);
  assert.equal(serialized.includes("Track 249"), false);
});
