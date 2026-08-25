import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { jellyfinPlaylistPointerStore }, { JellyfinPlaybackDestination }] =
  await setupIsolatedBackend(
    "jellyfin-playback-destination",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/jellyfin/jellyfinPlaylistPointerStore.js",
    "backend/services/playback/jellyfinPlaybackDestination.js",
  );

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;
const userId = "jellyfin-user";

test.beforeEach(async () => {
  resetDatabase(db);
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
  dbOps.updateSettings({ integrations: {} });
});

test.after(() => cleanupIsolatedState(isolatedState));

function makeClient(calls) {
  return {
    url: "http://jellyfin.local",
    userId,
    isConfigured: () => true,
    getAudioItems: async () => [
      { Id: "jellyfin-track-1", Path: "/downloads/one.flac" },
      {
        Id: "jellyfin-track-2",
        Path: "/downloads/two.flac",
        ProviderIds: { MusicBrainzTrack: "recording-2" },
      },
    ],
    createPlaylist: async (payload) => {
      calls.push({ operation: "create", payload });
      return { Id: "playlist-1" };
    },
    updatePlaylist: async (playlistId, payload) => {
      calls.push({ operation: "update", playlistId, payload });
    },
    deletePlaylist: async (playlistId) => {
      calls.push({ operation: "delete", playlistId });
    },
    scanLibrary: async () => {
      calls.push({ operation: "scan" });
    },
  };
}

function snapshot(overrides = {}) {
  return {
    entityId: "flow-jellyfin",
    ownerUserId: null,
    displayName: "Discover Weekly",
    tracks: [
      { path: "/media/one.flac", title: "One", artist: "Artist" },
      {
        path: "/media/two.flac",
        title: "Two",
        artist: "Artist",
        mbid: "recording-2",
      },
    ],
    ...overrides,
  };
}

test("publishes, updates, scans, and deletes a managed playlist", async () => {
  const calls = [];
  const destination = new JellyfinPlaybackDestination(weeklyFlowRoot, {
    client: makeClient(calls),
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";
  try {
    assert.equal((await destination.publishPlaylist(snapshot())).ok, true);
    assert.deepEqual(calls[0], {
      operation: "create",
      payload: {
        name: "Discover Weekly",
        itemIds: ["jellyfin-track-1", "jellyfin-track-2"],
      },
    });
    assert.equal(
      jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId).playlistId,
      "playlist-1",
    );

    assert.equal(
      (await destination.publishPlaylist(snapshot({ displayName: "Fresh Weekly" }))).ok,
      true,
    );
    assert.deepEqual(calls[1], {
      operation: "update",
      playlistId: "playlist-1",
      payload: { name: "Fresh Weekly", itemIds: ["jellyfin-track-1", "jellyfin-track-2"] },
    });

    assert.equal((await destination.requestScan()).ok, true);
    assert.deepEqual(calls[2], { operation: "scan" });
    assert.equal((await destination.deletePlaylist({ entityId: "flow-jellyfin" })).ok, true);
    assert.deepEqual(calls[3], { operation: "delete", playlistId: "playlist-1" });
    assert.equal(jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId), null);
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

test("preserves repeated resolved tracks in a playlist", async () => {
  const calls = [];
  const destination = new JellyfinPlaybackDestination(weeklyFlowRoot, {
    client: makeClient(calls),
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";
  try {
    assert.equal(
      (await destination.publishPlaylist(snapshot({
        tracks: [
          { path: "/media/one.flac", title: "One", artist: "Artist" },
          { path: "/media/one.flac", title: "One", artist: "Artist" },
        ],
      }))).ok,
      true,
    );
    assert.deepEqual(calls[0].payload.itemIds, [
      "jellyfin-track-1",
      "jellyfin-track-1",
    ]);
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});
