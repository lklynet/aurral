import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { getSharedPlaylistTrackCount } from "../../frontend/src/pages/flows/flowStats.js";

const [isolatedState, { db }, { dbOps }, { flowPlaylistConfig }, snapshotModule] =
  await setupIsolatedBackend(
    "status-snapshot",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/weeklyFlow/weeklyFlowStatusSnapshot.js",
  );

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

test("status snapshot includes shared playlist summaries without embedding track arrays", async () => {
  const tracks = Array.from({ length: 421 }, (_, index) => ({
    artistName: `Artist ${index}`,
    trackName: `Track ${index}`,
  }));

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Big Import",
    sourceName: "Exported JSON",
    tracks,
  });
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  downloadTracker.addJob(tracks[0], playlist.id);

  const status = getWeeklyFlowStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.trackCount, 421);
  assert.equal(
    getSharedPlaylistTrackCount(shared, status.sharedPlaylistStats[playlist.id]),
    421,
  );
  assert.equal("tracks" in shared, false);
  assert.ok(Array.isArray(shared.trackIdentities));
  assert.equal(shared.trackIdentities.length, 421);
  assert.equal(shared.sourceName, "Exported JSON");

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("Artist 420"), false);
  assert.equal(serialized.includes("Track 420"), false);
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
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
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

test("status snapshot trackCount includes failed download jobs", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Failed Mix" });
  const jobId = downloadTracker.addJob(
    { artistName: "Radiohead", trackName: "Karma Police" },
    playlist.id,
  );
  downloadTracker.setFailed(jobId, "Not found");

  const status = getWeeklyFlowStatusSnapshot();
  const shared = status.sharedPlaylists.find((entry) => entry.id === playlist.id);

  assert.equal(shared.trackCount, 1);
  assert.equal(
    getSharedPlaylistTrackCount(shared, status.sharedPlaylistStats[playlist.id]),
    1,
  );
});
