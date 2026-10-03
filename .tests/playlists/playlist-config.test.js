import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  playlistConfigModule,
  flowHandlerUtils,
  flowHandlersModule,
  libraryScanWorker,
] =
  await setupIsolatedBackend(
    "playlist-config",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/routes/playlists/handlers/utils.js",
    "backend/routes/playlists/handlers/flows.js",
    "backend/services/libraryScanWorker.js",
  );
const { flowPlaylistConfig, normalizeImportSource, tracksShareMembership, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { validateFlowPayload } = flowHandlerUtils;
const { registerFlows } = flowHandlersModule;
const { clearScheduledLibraryScan, getScheduledLibraryScanJobId } = libraryScanWorker;

test.beforeEach(() => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
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

test("removing and readding a canonical membership renews its incarnation", () => {
  const track = { artistName: "Artist", trackName: "Track", canonicalJobId: "canonical-job" };
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Membership", tracks: [track] });
  const first = playlist.tracks[0].membershipId;
  assert.ok(first);
  const renamed = flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "Renamed" });
  assert.equal(renamed.tracks[0].membershipId, first);
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { tracks: [] });
  const readded = flowPlaylistConfig.appendStaticPlaylistTracks(playlist.id, [{ ...track, membershipId: first }]);
  assert.notEqual(readded.tracks[0].membershipId, first);
});


test("playlist changes wait for another process's write instead of failing as locked", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Busy Database", tracks: [] });
  const writer = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require("better-sqlite3");
    const db = new Database(workerData.dbPath);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('otherProcess', '1')").run();
    parentPort.postMessage("locked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    db.exec("COMMIT");
    db.close();
  `, { eval: true, workerData: { dbPath: isolatedState.dbPath } });
  const exited = once(writer, "exit");
  await once(writer, "message");

  flowPlaylistConfig.appendStaticPlaylistTracks(playlist.id, [{ artistName: "Artist", trackName: "Track" }]);
  await exited;

  invalidateFlowPlaylistConfigCache();
  dbOps.invalidateSettingsCache();
  assert.deepEqual(
    flowPlaylistConfig.getStaticPlaylist(playlist.id).tracks.map((track) => track.trackName),
    ["Track"],
  );
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'otherProcess'").get()?.value, "1");
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

test("normalizes invalid playlist owners to null", () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Unowned Flow", ownerUserId: 0 });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Unowned Playlist",
    ownerUserId: "0",
  });
  const fractional = flowPlaylistConfig.createFlow({
    name: "Fractional Owner",
    ownerUserId: 7.9,
  });
  const unsafe = flowPlaylistConfig.createFlow({
    name: "Unsafe Owner",
    ownerUserId: Number.MAX_SAFE_INTEGER + 1,
  });
  const unowned = flowPlaylistConfig.createFlow({ name: "Invalid Owner Conflict" });
  const unownedPlaylist = flowPlaylistConfig.createStaticPlaylist({
    name: "Invalid Playlist Owner Conflict",
  });
  const owned = flowPlaylistConfig.createFlow({ name: "Owned Flow", ownerUserId: 7 });

  assert.equal(flow.ownerUserId, null);
  assert.equal(playlist.ownerUserId, null);
  assert.equal(fractional.ownerUserId, null);
  assert.equal(unsafe.ownerUserId, null);
  assert.equal(owned.ownerUserId, 7);
  assert.throws(
    () =>
      flowPlaylistConfig.createFlow({
        name: "Invalid Owner Conflict",
        ownerUserId: "not-a-user",
      }),
    /already exists/,
  );
  assert.throws(
    () =>
      flowPlaylistConfig.createStaticPlaylist({
        name: "Invalid Playlist Owner Conflict",
        ownerUserId: "not-a-user",
      }),
    /already exists/,
  );

  flowPlaylistConfig.deleteFlow(flow.id);
  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  flowPlaylistConfig.deleteFlow(fractional.id);
  flowPlaylistConfig.deleteFlow(unsafe.id);
  flowPlaylistConfig.deleteFlow(unowned.id);
  flowPlaylistConfig.deleteStaticPlaylist(unownedPlaylist.id);
  flowPlaylistConfig.deleteFlow(owned.id);
});

test("rejects flow creation without a real user owner", async () => {
  const beforeFlowIds = flowPlaylistConfig.getFlows().map((flow) => flow.id);
  let createHandler;
  const router = {
    post(path, ...handlers) {
      if (path === "/flows") createHandler = handlers.at(-1);
    },
    put() {},
    delete() {},
    get() {},
  };
  registerFlows(router);

  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await createHandler({ body: {}, user: { id: -1, role: "admin" } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Flow ownership requires a real user");
  assert.deepEqual(
    flowPlaylistConfig.getFlows().map((flow) => flow.id),
    beforeFlowIds,
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

test("keeps flow tracks out of the library until a flow opts in", async () => {
  dbOps.updateSettings({ integrations: { lastfm: { apiKey: "test" } } });
  const flow = flowPlaylistConfig.createFlow({
    name: "Library Opt In",
    size: 20,
    mix: { discover: 100 },
    scheduleDays: [1],
  });
  assert.equal(flow.showInLibrary, false);

  let updateHandler;
  registerFlows({
    post() {},
    put(path, ...handlers) {
      if (path === "/flows/:flowId") updateHandler = handlers.at(-1);
    },
    delete() {},
    get() {},
  });
  const send = async (body) => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    await updateHandler(
      { params: { flowId: flow.id }, body, user: { id: 1, role: "admin" } },
      response,
    );
    return response;
  };

  clearScheduledLibraryScan();
  const rejected = await send({ showInLibrary: "true" });
  assert.equal(rejected.statusCode, 400);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).showInLibrary, false);
  assert.equal(getScheduledLibraryScanJobId(), null);

  const enabled = await send({ showInLibrary: true });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.body.flow.showInLibrary, true);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).showInLibrary, true);
  assert.notEqual(getScheduledLibraryScanJobId(), null);

  clearScheduledLibraryScan();
  const renamed = await send({ name: "Library Opt In Renamed" });
  assert.equal(renamed.statusCode, 200);
  assert.equal(flowPlaylistConfig.getFlow(flow.id).showInLibrary, true);
  assert.equal(getScheduledLibraryScanJobId(), null);

  await send({ showInLibrary: false });
  assert.equal(flowPlaylistConfig.getFlow(flow.id).showInLibrary, false);
  assert.notEqual(getScheduledLibraryScanJobId(), null);
  clearScheduledLibraryScan();
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

test("rejects flow and static playlist names that collide across types", () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Rock" });
  assert.throws(
    () => flowPlaylistConfig.createStaticPlaylist({ name: "rock" }),
    /already exists/,
  );

  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Jazz" });
  assert.throws(
    () => flowPlaylistConfig.createFlow({ name: "Jazz" }),
    /already exists/,
  );

  flowPlaylistConfig.deleteFlow(flow.id);
  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
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

test("stores full static playlists but exposes trackless summaries for hot paths", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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

  const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
  const summaries = flowPlaylistConfig.getStaticPlaylists().map(
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
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Empty Queue",
  });

  const stored = flowPlaylistConfig.getStaticPlaylist(playlist.id);
  const summary = flowPlaylistConfig
    .getStaticPlaylists()
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

test("updates static playlists and keeps summaries in sync", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Gym Mix",
    tracks: [
      { artistName: "A", trackName: "One" },
      { artistName: "B", trackName: "Two" },
    ],
  });

  const updated = flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    name: "Gym Mix Updated",
    tracks: [{ artistName: "C", trackName: "Three" }],
  });
  const summary = flowPlaylistConfig
    .getStaticPlaylists()
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

test("normalizes YouTube Music import sources without a schema migration", () => {
  const source = normalizeImportSource({
    provider: "youtube-music-playlist",
    externalId: "PLabcdefghij_123",
    externalName: "Public playlist",
    syncEnabled: true,
    syncIntervalHours: 12,
    keepRemovedTracks: false,
    lastSyncAt: 1234,
    lastSyncTrackCount: 8,
  });

  assert.deepEqual(source, {
    provider: "youtube-music-playlist",
    externalId: "PLabcdefghij_123",
    externalName: "Public playlist",
    syncEnabled: true,
    syncIntervalHours: 12,
    keepRemovedTracks: false,
    lastSyncAt: 1234,
    lastSyncError: null,
    lastSyncTrackCount: 8,
  });
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

test("preserves rich track metadata when static playlists are updated", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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

  const updated = flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
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

  const { membershipId, ...metadata } = updated.tracks[0];
  assert.ok(membershipId);
  assert.deepEqual(metadata, {
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
