import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "weekly-flow-webhook-vars",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("weekly flow webhook vars use display name and track library path", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Late Night",
    tracks: [],
  });
  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  const flowName = manager.getPlaylistName(playlist.id) || playlist.id;
  const flowPath = path.join(manager.playlistLibraryRoot, playlist.id);

  assert.equal(flowName, "Late Night");
  assert.equal(
    flowPath,
    path.join(process.env.WEEKLY_FLOW_FOLDER, "aurral-weekly-flow", playlist.id),
  );
  assert.doesNotMatch(flowPath, /_playlists/);
  assert.match(manager.libraryRoot, /_playlists$/);
});
