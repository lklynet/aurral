import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import {
  getStaticPlaylistTrackCount,
  hasReviewActivity,
} from "../../frontend/src/pages/playlists/playlistStats.ts";
import { requireFixture } from "./fixtures.ts";

const [isolatedState, { db }, { dbOps }, { flowPlaylistConfig }, snapshotModule] =
  await setupIsolatedBackend(
    "status-snapshot",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
    () => import("../../backend/services/playlists/playlistStatusSnapshot.ts"),
  );

const { getPlaylistStatusSnapshot, getPlaylistsContainingTrack } = snapshotModule;

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    staticPlaylists: [],
  });
});

afterAll(async () => {
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
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  downloadTracker.addJob(tracks[0], playlist.id);

  const status = getPlaylistStatusSnapshot();
  const shared = (status.staticPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.trackCount, 421);
  assert.equal(getStaticPlaylistTrackCount(shared, status.staticPlaylistStats[playlist.id]), 421);
  assert.equal("tracks" in shared, false);
  assert.equal("trackIdentities" in shared, false);
  assert.deepEqual(getPlaylistsContainingTrack(null, tracks[420]!), [
    { id: playlist.id, jobId: null },
  ]);
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
  const shared = (status.staticPlaylists || []).find((p) => p.id === playlist.id);

  assert.ok(shared);
  assert.equal(shared.name, "Manual Empty");
  assert.equal(shared.trackCount, 0);
  assert.deepEqual(getPlaylistsContainingTrack(null, { artistName: "A", trackName: "B" }), []);
});

test("playlists containing a track include pending download jobs", async () => {
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const pending = { artistName: "Radiohead", trackName: "Karma Police", albumName: "OK Computer" };
  const jobId = downloadTracker.addJob(pending, "library");
  assert.ok(jobId);
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Pending Mix",
    tracks: [{ ...pending, canonicalJobId: jobId }],
  });

  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  const track = { artistName: "radiohead", trackName: "Karma Police" };
  assert.deepEqual(getPlaylistsContainingTrack(null, track), [{ id: playlist.id, jobId }]);
  assert.deepEqual(getPlaylistsContainingTrack(null, { ...track, albumName: "The Bends" }), [
    { id: playlist.id, jobId },
  ]);
  assert.deepEqual(getPlaylistsContainingTrack(null, { ...track, trackName: "Airbag" }), []);
});

test("status snapshot trackCount includes failed download jobs", async () => {
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const failed = { artistName: "Radiohead", trackName: "Karma Police" };
  const jobId = downloadTracker.addJob(failed, "library");
  assert.ok(jobId != null);
  downloadTracker.setFailed(jobId, "Not found");
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Failed Mix",
    tracks: [{ ...failed, canonicalJobId: jobId }],
  });

  const status = getPlaylistStatusSnapshot();
  const shared = status.staticPlaylists.find((entry) => entry.id === playlist.id);
  assert.ok(shared != null);

  assert.equal(shared.trackCount, 1);
  assert.equal(getStaticPlaylistTrackCount(shared, status.staticPlaylistStats[playlist.id]), 1);
});

test("review count includes Library jobs and respects playlist ownership", async () => {
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const ownFlow = flowPlaylistConfig.createFlow({ name: "Mine", ownerUserId: 1 });
  const otherFlow = flowPlaylistConfig.createFlow({ name: "Someone else's", ownerUserId: 2 });
  const held = ["library", ownFlow.id, otherFlow.id].map((playlistId, index) => {
    const id = downloadTracker.addJob(
      { artistName: "Artist", trackName: `Held ${index}` },
      playlistId,
    );
    assert.ok(id != null);
    downloadTracker.setBlocked(id, "Needs review");
    return id;
  });
  assert.ok(held.every((value) => value != null));
  downloadTracker.addJob({ artistName: "Artist", trackName: "Pending" }, "library");
  const user = { id: 1, role: "user", username: "test", permissions: {} };
  assert.equal(getPlaylistStatusSnapshot({ user }).reviewCount, 2);
  assert.equal(
    getPlaylistStatusSnapshot({ user: { id: 1, role: "admin", username: "test", permissions: {} } })
      .reviewCount,
    3,
  );
  assert.equal(hasReviewActivity(getPlaylistStatusSnapshot({ user })), true);
  downloadTracker.setFailed(requireFixture(held[1]), "Dismissed");
  const libraryOnly = getPlaylistStatusSnapshot({ user });
  assert.equal(libraryOnly.stats.blocked + libraryOnly.staticStats.blocked, 0);
  assert.equal(libraryOnly.reviewCount, 1);
  assert.equal(hasReviewActivity(libraryOnly), true);
  downloadTracker.setFailed(requireFixture(held[0]), "Dismissed");
  assert.equal(getPlaylistStatusSnapshot({ user }).reviewCount, 0);
  assert.equal(hasReviewActivity(getPlaylistStatusSnapshot({ user })), false);
});
