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
    flows: [],
    sharedPlaylists: [],
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
  assert.ok(Array.isArray(shared.trackIdentities));
  assert.equal(shared.trackIdentities.length, 250);
  assert.equal(shared.sourceName, "Exported JSON");

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("Artist 249"), false);
  assert.equal(serialized.includes("Track 249"), false);
});

test("status snapshot includes empty manual playlists", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Manual Empty",
  });

  const status = getWeeklyFlowStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.name, "Manual Empty");
  assert.equal(shared.trackCount, 0);
  assert.deepEqual(shared.trackIdentities, []);
});

test("status snapshot trackIdentities includes pending download jobs", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlowDownloadTracker.js",
  );
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Pending Mix",
  });
  const jobId = downloadTracker.addJob(
    {
      artistName: "Radiohead",
      trackName: "Karma Police",
      albumName: "OK Computer",
    },
    playlist.id,
  );
  assert.ok(jobId);

  const status = getWeeklyFlowStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);
  const job = downloadTracker.getJob(jobId);

  assert.ok(shared);
  assert.equal(job?.status, "pending");
  assert.equal(shared.trackIdentities.length, 1);
  assert.ok(
    shared.trackIdentities[0].includes("radiohead"),
    "expected pending job identity in snapshot",
  );
});
