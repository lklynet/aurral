import test from "node:test";
import assert from "node:assert/strict";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("artist-blocklist");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, discovery, playlistSourceModule] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/discovery/index.js"),
  importFromRepo("backend/services/weeklyFlow/weeklyFlowPlaylistSource.js"),
]);

const { WeeklyFlowPlaylistSource } = playlistSourceModule;

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

test("artist blocks are per-user and match ids, names, and track aliases", () => {
  discovery.addDiscoveryFeedback("7", {
    artistId: "11111111-1111-1111-1111-111111111111",
    artistName: "Blocked Artist",
    action: "block_artist",
  });

  const allowed = discovery.filterBlockedArtistsForUser("7", [
    { name: "Allowed Artist" },
    { artistName: "Blocked Artist" },
    { artistMbid: "11111111-1111-1111-1111-111111111111", artistName: "Alias" },
    { artistName: "Alias", artistAliases: ["Blocked Artist"] },
  ]);

  assert.deepEqual(allowed.map((artist) => artist.name || artist.artistName), ["Allowed Artist"]);
  assert.equal(discovery.filterBlockedArtistsForUser("8", [{ name: "Blocked Artist" }]).length, 1);
});

test("resetting discovery tastes preserves artist blocks", () => {
  discovery.addDiscoveryFeedback("7", {
    artistName: "Blocked Artist",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistName: "Taste Artist",
    action: "less_like_this",
  });

  const remaining = discovery.resetDiscoveryFeedback("7");

  assert.deepEqual(remaining.map((entry) => entry.action), ["block_artist"]);
});

test("flows exclude only hard-blocked artists", async () => {
  discovery.addDiscoveryFeedback("7", {
    artistName: "Blocked Artist",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistId: "11111111-1111-1111-1111-111111111111",
    action: "block_artist",
  });
  discovery.addDiscoveryFeedback("7", {
    artistName: "Soft Dislike",
    action: "less_like_this",
  });

  const source = new WeeklyFlowPlaylistSource();

  source.getReleaseRadarTracks = async () => [
    { artistName: "Blocked Artist", trackName: "Blocked Track" },
    {
      artistName: "Renamed Artist",
      artistMbid: "11111111-1111-1111-1111-111111111111",
      trackName: "Blocked By Id",
    },
    { artistName: "Soft Dislike", trackName: "Still Eligible" },
  ];
  const plan = await source.buildFlowRunPlan({
    ownerUserId: 7,
    discoverPresetId: "release-radar",
    size: 2,
  });

  assert.deepEqual(plan.primaryTracks.map((track) => track.artistName), ["Soft Dislike"]);
});
