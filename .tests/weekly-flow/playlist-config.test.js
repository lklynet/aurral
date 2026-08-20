import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, playlistConfigModule, flowHandlerUtils] =
  await setupIsolatedBackend(
    "playlist-config",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/routes/weeklyFlow/handlers/utils.js",
  );
const { flowPlaylistConfig, normalizeImportSource, tracksShareMembership } = playlistConfigModule;
const { validateFlowPayload } = flowHandlerUtils;

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
  assert.equal(flow.yearFrom, null);
  assert.equal(flow.yearTo, null);

  assert.throws(
    () =>
      flowPlaylistConfig.createFlow({
        name: "late night",
      }),
    /already exists/,
  );
});

test("defaults listening history on and persists a flow opt-out", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "No History",
    size: 20,
  });

  assert.equal(flow.recordHistory, true);

  const updated = flowPlaylistConfig.updateFlow(flow.id, {
    recordHistory: false,
  });

  assert.equal(updated?.recordHistory, false);
  assert.equal(flowPlaylistConfig.getFlow(flow.id)?.recordHistory, false);
});

test("rejects non-boolean listening history payloads", () => {
  dbOps.updateSettings({ integrations: { lastfm: { apiKey: "test" } } });
  const payload = {
    name: "Validated History",
    size: 20,
    mix: { discover: 100 },
    scheduleDays: [1],
  };

  assert.equal(
    validateFlowPayload({ ...payload, recordHistory: "false" }),
    "recordHistory must be a boolean",
  );
  assert.equal(validateFlowPayload({ ...payload, recordHistory: false }), null);
  assert.equal(validateFlowPayload(payload), null);
});

test("stores and swaps optional release year range", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Eighties",
    size: 20,
    yearFrom: 1989,
    yearTo: 1980,
  });
  assert.equal(flow.yearFrom, 1980);
  assert.equal(flow.yearTo, 1989);

  const updated = flowPlaylistConfig.updateFlow(flow.id, {
    yearFrom: 2020,
    yearTo: null,
  });
  assert.equal(updated?.yearFrom, 2020);
  assert.equal(updated?.yearTo, null);
});

test("partial year updates do not silently swap the untouched bound", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Nineties",
    size: 20,
    yearFrom: 1980,
    yearTo: 1989,
  });

  const raisedFrom = flowPlaylistConfig.updateFlow(flow.id, {
    yearFrom: 2020,
  });
  assert.equal(raisedFrom?.yearFrom, 2020);
  assert.equal(raisedFrom?.yearTo, null);

  const loweredTo = flowPlaylistConfig.updateFlow(flow.id, {
    yearFrom: 1980,
    yearTo: 1989,
  });
  assert.equal(loweredTo?.yearFrom, 1980);
  assert.equal(loweredTo?.yearTo, 1989);

  const earlyTo = flowPlaylistConfig.updateFlow(flow.id, {
    yearTo: 1970,
  });
  assert.equal(earlyTo?.yearFrom, null);
  assert.equal(earlyTo?.yearTo, 1970);
});

test("rejects flow and shared playlist names that collide across types", () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Rock" });
  assert.throws(
    () => flowPlaylistConfig.createSharedPlaylist({ name: "rock" }),
    /already exists/,
  );

  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Jazz" });
  assert.throws(
    () => flowPlaylistConfig.createFlow({ name: "Jazz" }),
    /already exists/,
  );

  flowPlaylistConfig.deleteFlow(flow.id);
  flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
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
  const summaries = flowPlaylistConfig.getSharedPlaylists().map(
    ({ id, name, ownerUserId, sourceName, sourceFlowId, importedAt, createdAt, trackCount }) => ({
      id,
      name,
      ownerUserId,
      sourceName,
      sourceFlowId,
      importedAt,
      createdAt,
      trackCount,
    }),
  );

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
    .getSharedPlaylists()
    .map(
      ({ id, name, ownerUserId, sourceName, sourceFlowId, importedAt, createdAt, trackCount }) => ({
        id,
        name,
        ownerUserId,
        sourceName,
        sourceFlowId,
        importedAt,
        createdAt,
        trackCount,
      }),
    )
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
    .getSharedPlaylists()
    .map(
      ({ id, name, ownerUserId, sourceName, sourceFlowId, importedAt, createdAt, trackCount }) => ({
        id,
        name,
        ownerUserId,
        sourceName,
        sourceFlowId,
        importedAt,
        createdAt,
        trackCount,
      }),
    )
    .find((entry) => entry.id === playlist.id);

  assert.equal(updated?.name, "Gym Mix Updated");
  assert.equal(updated?.tracks?.length, 1);
  assert.equal(summary?.name, "Gym Mix Updated");
  assert.equal(summary?.trackCount, 1);
});

test("defaults Spotify removed-track retention on and preserves an explicit opt-out", () => {
  const source = normalizeImportSource({
    provider: "spotify-playlist",
    externalId: "playlist-id",
    syncEnabled: true,
    syncIntervalHours: 24,
  });
  const optedOut = normalizeImportSource({
    ...source,
    keepRemovedTracks: false,
  });

  assert.equal(source.keepRemovedTracks, true);
  assert.equal(optedOut.keepRemovedTracks, false);
});

test("rejects unsupported playlist import providers", () => {
  assert.equal(
    normalizeImportSource({
      provider: "unknown-provider",
      externalId: "playlist-id",
      syncEnabled: true,
      syncIntervalHours: 24,
    }),
    null,
  );
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
