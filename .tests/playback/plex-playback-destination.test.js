import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";
import { PlexClient } from "../../backend/services/plex.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { plexConnectionStore },
  { plexPlaylistPointerStore },
  { flowPlaylistConfig },
  { PlexPlaybackDestination },
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "plex-playback-destination",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/plex/plexConnectionStore.js",
  "backend/services/plex/plexPlaylistPointerStore.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/playback/plexPlaybackDestination.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  resetDatabase(db);
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.afterEach(() => mock.restoreAll());
test.after(() => cleanupIsolatedState(isolatedState));

function makeDestination(config = {}) {
  const destination = new PlexPlaybackDestination(weeklyFlowRoot);
  destination.updateConfig({
    url: "http://plex.local:32400",
    token: "admin-token",
    clientId: "admin-client",
    ...config,
  });
  return destination;
}

function snapshot(overrides = {}) {
  return {
    entityId: "flow-1",
    ownerUserId: null,
    displayName: "Discover Weekly",
    tracks: [],
    ...overrides,
  };
}

test("selects the global client for its owner and a linked client for another owner", () => {
  const owner = userOps.createUser("linked", "hash", "user");
  plexConnectionStore.saveConnection(owner.id, {
    linkType: "self",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 55,
  });
  const destination = makeDestination();
  destination.client._machineIdentifier = "server-id";
  const cache = new Map();

  assert.equal(destination._ownerClient(null, cache), destination.client);
  const selected = destination._ownerClient(owner.id, cache);
  assert.notEqual(selected, destination.client);
  assert.equal(selected.token, "owner-token");
  assert.equal(selected.clientId, "owner-client");
  assert.equal(selected._machineIdentifier, "server-id");
});

test("allows only the configured global owner unless another owner has a Plex link", () => {
  const configured = userOps.createUser("configured", "hash", "admin");
  const other = userOps.createUser("other", "hash", "admin");
  const destination = makeDestination({ configuredByUserId: configured.id });

  assert.equal(destination._isOwnerBlocked(configured.id, new Map()), false);
  assert.equal(destination._isOwnerBlocked(other.id, new Map()), true);

  plexConnectionStore.saveConnection(other.id, {
    linkType: "self",
    token: "other-token",
    clientId: "other-client",
    plexAccountId: 88,
  });
  assert.equal(destination._isOwnerBlocked(other.id, new Map()), false);
});

test("recovers a managed-user token and retries with the stored client identifier", async () => {
  const owner = userOps.createUser("managed", "hash", "user");
  plexConnectionStore.saveConnection(owner.id, {
    linkType: "managed",
    token: "stale-token",
    clientId: "managed-client",
    plexAccountId: 77,
  });
  mock.method(PlexClient, "switchHomeUser", async (_id, _token, _adminId, targetId) => {
    assert.equal(targetId, "managed-client");
    return "fresh-token";
  });
  mock.method(PlexClient, "getResources", async () => ({ servers: [] }));
  const destination = makeDestination();
  destination.client._machineIdentifier = "server-id";
  const seen = [];

  const result = await destination._withOwnerClient(owner.id, new Map(), async (client) => {
    seen.push(client.token);
    if (client.token === "stale-token") {
      const error = new Error("expired");
      error.response = { status: 401 };
      throw error;
    }
    return "published";
  });

  assert.equal(result, "published");
  assert.deepEqual(seen, ["stale-token", "fresh-token"]);
  assert.equal(plexConnectionStore.getConnection(owner.id).token, "fresh-token");
});

test("resolves managed and reused Lidarr paths to private Plex rating keys", async () => {
  const destination = makeDestination({ mainLibrarySectionId: "9" });
  const managedPath = path.join(
    destination.playlistLibraryRoot,
    "flow-1",
    "Artist",
    "Album",
    "Managed.flac",
  );
  const reusedRoot = path.join(weeklyFlowRoot, "..", "lidarr");
  const reusedPath = path.join(reusedRoot, "Artist", "Reused.flac");
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    pathMappings: [{ source: "plex", remote: "/music", local: reusedRoot }],
  });
  dbOps.getSettings();
  destination._libraryTracks = [
    {
      ratingKey: "101",
      files: ["/data/aurral-weekly-flow/another-flow/Artist/Album/Managed.flac"],
    },
  ];
  destination._mainLibraryTracks = [
    { ratingKey: "202", files: ["/music/Artist/Reused.flac"] },
  ];

  assert.deepEqual(
    await destination._resolveRatingKeys(
      snapshot({
        tracks: [
          { path: managedPath, title: "Managed", artist: "Artist" },
          { path: reusedPath, title: "Reused", artist: "Artist" },
        ],
      }),
    ),
    ["101", "202"],
  );
});

test("reuses a Lidarr file linked into the entity folder without a main Plex library", async () => {
  const destination = makeDestination();
  const reusedPath = path.join(weeklyFlowRoot, "..", "lidarr", "Artist", "Track.flac");
  const linkedPath = path.join(
    destination.playlistLibraryRoot,
    "flow-1",
    "Artist",
    "Album",
    "Track.flac",
  );
  await fs.mkdir(path.dirname(reusedPath), { recursive: true });
  await fs.mkdir(path.dirname(linkedPath), { recursive: true });
  await fs.writeFile(reusedPath, "track");
  await fs.symlink(reusedPath, linkedPath);
  destination._libraryTracks = [
    { ratingKey: "303", files: ["/data/aurral-weekly-flow/flow-1/Artist/Album/Track.flac"] },
  ];
  destination._mainLibraryTracks = [];

  assert.deepEqual(
    await destination._resolveRatingKeys(
      snapshot({ tracks: [{ path: reusedPath, title: "Track", artist: "Artist" }] }),
    ),
    ["303"],
  );
});

test("upserts from the entity-owner pointer and stores the returned pointer privately", async () => {
  const destination = makeDestination();
  const trackPath = path.join(
    destination.playlistLibraryRoot,
    "flow-1",
    "Artist",
    "Album",
    "Track.flac",
  );
  destination._libraryTracks = [
    { ratingKey: "101", files: ["/data/aurral-weekly-flow/flow-1/Artist/Album/Track.flac"] },
  ];
  destination._mainLibraryTracks = [];
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: "88",
    title: "Old title",
  });
  let received;
  mock.method(PlexClient.prototype, "syncPlaylist", async (value) => {
    received = value;
    return { ratingKey: "88" };
  });

  assert.deepEqual(
    await destination.publishPlaylist(
      snapshot({ tracks: [{ path: trackPath, title: "Track", artist: "Artist" }] }),
    ),
    { ok: true },
  );
  assert.equal(received.ratingKey, "88");
  assert.deepEqual(received.ratingKeys, ["101"]);
  const stored = plexPlaylistPointerStore.getPointer("flow-1", "global");
  assert.equal(stored.ratingKey, "88");
  assert.equal(stored.title, "Discover Weekly");
});

test("deletes the pointed playlist and forgets only that entity-owner state", async () => {
  const destination = makeDestination();
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: "88",
    title: "Discover Weekly",
  });
  plexPlaylistPointerStore.setPointer("flow-2", "global", {
    location: "global",
    ratingKey: "99",
    title: "Keep",
  });
  const deleted = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async (ratingKey) => {
    deleted.push(ratingKey);
  });

  assert.deepEqual(await destination.deletePlaylist(snapshot()), { ok: true });
  assert.deepEqual(deleted, ["88"]);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "global"), null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-2", "global").ratingKey, "99");
});

test("ensures and scans the Plex library through the adapter", async () => {
  const destination = makeDestination({ downloadsPath: "/downloads" });
  const calls = [];
  mock.method(PlexClient.prototype, "ensureWeeklyFlowLibrary", async (libraryPath) => {
    calls.push(["ensure", libraryPath]);
    return { key: "7" };
  });
  mock.method(PlexClient.prototype, "getTracks", async (sectionId) => {
    calls.push(["tracks", sectionId]);
    return [];
  });
  mock.method(PlexClient.prototype, "scanLibrary", async (sectionId) => {
    calls.push(["scan", sectionId]);
  });

  assert.deepEqual(await destination.ensureLibrary(), { ok: true });
  assert.deepEqual(await destination.requestScan(), { ok: true });
  assert.deepEqual(calls, [
    ["ensure", "/downloads/aurral-weekly-flow"],
    ["tracks", "7"],
    ["tracks", "7"],
    ["scan", "7"],
  ]);
});

test("keeps Navidrome and Plex failures isolated when both destinations are configured", async (t) => {
  t.mock.method(console, "warn", () => {});
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Isolation" });
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  const calls = [];
  manager.navidromeDestination.ensureLibrary = async () => ({ ok: true });
  manager.navidromeDestination.publishPlaylist = async () => ({
    ok: false,
    error: { message: "Navidrome unavailable" },
  });
  manager.plexDestination.isConfigured = () => true;
  manager.plexDestination.ensureLibrary = async () => ({ ok: true });
  manager.plexDestination.publishPlaylist = async (value) => {
    calls.push(value.entityId);
    return { ok: true };
  };

  await manager.ensurePlaylists();
  assert.deepEqual(calls, [playlist.id]);

  manager.navidromeDestination.publishPlaylist = async () => ({ ok: true });
  manager.plexDestination.publishPlaylist = async () => ({
    ok: false,
    error: { message: "Plex unavailable" },
  });
  await assert.doesNotReject(manager.ensurePlaylists());
});
