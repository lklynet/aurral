import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { getStaticPlaylistTrackCount, hasReviewActivity } from "../../frontend/src/pages/playlists/playlistStats.js";

const [isolatedState, { db }, { dbOps }, { flowPlaylistConfig }, snapshotModule] =
  await setupIsolatedBackend(
    "status-snapshot",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/services/playlists/playlistStatusSnapshot.js",
  );

const { getPlaylistStatusSnapshot } = snapshotModule;

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

test("status snapshot includes static playlist summaries without embedding track arrays", async () => {
  const tracks = Array.from({ length: 421 }, (_, index) => ({
    artistName: `Artist ${index}`,
    trackName: `Track ${index}`,
  }));

  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Big Import",
    sourceName: "Exported JSON",
    tracks,
  });
  const { downloadTracker } = await importFromRepo(
    "backend/services/downloadJobs/downloadTracker.js",
  );
  downloadTracker.addJob(tracks[0], playlist.id);

  const status = getPlaylistStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.trackCount, 421);
  assert.equal(
    getStaticPlaylistTrackCount(shared, status.sharedPlaylistStats[playlist.id]),
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
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Manual Empty",
  });

  const status = getPlaylistStatusSnapshot();
  const shared = (status.sharedPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.name, "Manual Empty");
  assert.equal(shared.trackCount, 0);
  assert.deepEqual(shared.trackIdentities, []);
});

test("status snapshot trackIdentities includes pending download jobs", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/downloadJobs/downloadTracker.js",
  );
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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

  const status = getPlaylistStatusSnapshot();
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
    "backend/services/downloadJobs/downloadTracker.js",
  );
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Failed Mix" });
  const jobId = downloadTracker.addJob(
    { artistName: "Radiohead", trackName: "Karma Police" },
    playlist.id,
  );
  downloadTracker.setFailed(jobId, "Not found");

  const status = getPlaylistStatusSnapshot();
  const shared = status.sharedPlaylists.find((entry) => entry.id === playlist.id);

  assert.equal(shared.trackCount, 1);
  assert.equal(
    getStaticPlaylistTrackCount(shared, status.sharedPlaylistStats[playlist.id]),
    1,
  );
});

test("review count includes Library jobs and respects playlist ownership", async () => {
  const { downloadTracker } = await importFromRepo("backend/services/downloadJobs/downloadTracker.js");
  const ownFlow = flowPlaylistConfig.createFlow({ name: "Mine", ownerUserId: 1 });
  const otherFlow = flowPlaylistConfig.createFlow({ name: "Someone else's", ownerUserId: 2 });
  const staticPlaylist = flowPlaylistConfig.createStaticPlaylist({ name: "Mine too", ownerUserId: 1 });
  const held = ["library", ownFlow.id, otherFlow.id, staticPlaylist.id].map((playlistId, index) => {
    const id = downloadTracker.addJob({ artistName: "Artist", trackName: `Held ${index}` }, playlistId);
    downloadTracker.setBlocked(id, "Needs review");
    return id;
  });
  downloadTracker.addJob({ artistName: "Artist", trackName: "Pending" }, "library");
  const user = { id: 1, role: "user" };
  assert.equal(getPlaylistStatusSnapshot({ user }).reviewCount, 3);
  assert.equal(getPlaylistStatusSnapshot({ user: { id: 1, role: "admin" } }).reviewCount, 4);
  assert.equal(hasReviewActivity(getPlaylistStatusSnapshot({ user })), true);
  for (const id of [held[1], held[3]]) downloadTracker.setFailed(id, "Dismissed");
  const libraryOnly = getPlaylistStatusSnapshot({ user });
  assert.equal(libraryOnly.stats.blocked + libraryOnly.sharedStats.blocked, 0);
  assert.equal(libraryOnly.reviewCount, 1);
  assert.equal(hasReviewActivity(libraryOnly), true);
  downloadTracker.setFailed(held[0], "Dismissed");
  assert.equal(getPlaylistStatusSnapshot({ user }).reviewCount, 0);
  assert.equal(hasReviewActivity(getPlaylistStatusSnapshot({ user })), false);
});
