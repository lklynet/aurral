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

const [{ db }, { dbOps }, playlistConfigModule] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/config/db-helpers.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistConfig.js"),
]);
const { flowPlaylistConfig, tracksShareMembership } = playlistConfigModule;

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
  assert.equal(flow.lastRunAt, null);

  assert.throws(
    () =>
      flowPlaylistConfig.createFlow({
        name: "late night",
      }),
    /already exists/,
  );
});

test("records flow last run time", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Morning",
    size: 20,
  });
  const lastRunAt = 1710000000000;

  const updated = flowPlaylistConfig.markLastRunAt(flow.id, lastRunAt);
  const stored = flowPlaylistConfig.getFlow(flow.id);

  assert.equal(updated?.lastRunAt, lastRunAt);
  assert.equal(stored?.lastRunAt, lastRunAt);
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

test("supports empty manual playlists", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Empty Queue",
  });

  const stored = flowPlaylistConfig.getSharedPlaylist(playlist.id);
  const summary = flowPlaylistConfig
    .getSharedPlaylistSummaries()
    .find((entry) => entry.id === playlist.id);

  assert.equal(stored?.tracks?.length, 0);
  assert.equal(summary?.trackCount, 0);
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

test("preserves rich track metadata when shared playlists are updated", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Metadata Mix",
    tracks: [
      {
        artistName: "Artist A",
        trackName: "Song A",
        albumName: "Album A",
        artistMbid: "artist-mbid",
        albumMbid: "album-mbid",
        trackMbid: "track-mbid",
        releaseYear: "1999",
        durationMs: 185000,
        artistAliases: ["Artist Alias"],
      },
    ],
  });

  const updated = flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
    tracks: [
      {
        artistName: "Artist B",
        trackName: "Song B",
        albumName: "Album B",
        artistMbid: "artist-b",
        albumMbid: "album-b",
        trackMbid: "track-b",
        releaseYear: "2004",
        durationMs: 201000,
        artistAliases: ["Alias B"],
      },
    ],
  });

  assert.deepEqual(updated?.tracks?.[0], {
    artistName: "Artist B",
    trackName: "Song B",
    albumName: "Album B",
    artistMbid: "artist-b",
    albumMbid: "album-b",
    trackMbid: "track-b",
    releaseYear: "2004",
    durationMs: 201000,
    artistAliases: ["Alias B"],
    reason: null,
  });
});

test("tracksShareMembership matches artist and song across album differences", () => {
  assert.equal(
    tracksShareMembership(
      {
        artistName: "Zao",
        trackName: "Lies Of Serpents, A River Of Tears",
        albumName: "Where Blood And Fire Bring Rest",
      },
      {
        artistName: "Zao",
        trackName: "Lies Of Serpents, A River Of Tears",
        albumName: "Where Blood and Fir...",
        trackMbid: "different-source-id",
      },
    ),
    true,
  );
});
