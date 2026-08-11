import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { userOps },
  { flowPlaylistConfig },
  { syncM3uPathMappings },
  { createPlaybackPlaylistIdentity, createPlaybackPlaylistSnapshot },
  { navidromePlaylistPointerStore },
  { NavidromePlaybackDestination },
] = await setupIsolatedBackend(
  "navidrome-playback-destination",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/playlistM3uPaths.js",
  "backend/services/playback/playbackDestination.js",
  "backend/services/navidrome/navidromePlaylistPointerStore.js",
  "backend/services/playback/navidromePlaybackDestination.js",
);

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

function createClient({ configured = true, playlists = [], songs = {} } = {}) {
  const currentPlaylists = playlists.map((playlist) => ({ ...playlist }));
  const calls = { created: [], deleted: [], ensured: [], scans: 0, updated: [] };
  return {
    calls,
    isConfigured: () => configured,
    async ping() {},
    async ensureWeeklyFlowLibrary(libraryPath) {
      calls.ensured.push(libraryPath);
    },
    async getPlaylists() {
      return currentPlaylists;
    },
    async findSong(title) {
      return songs[title] || null;
    },
    async createPlaylist(name, songIds) {
      calls.created.push({ name, songIds });
      const playlist = { id: "created", name };
      currentPlaylists.push(playlist);
      return playlist;
    },
    async updatePlaylist(id, payload) {
      calls.updated.push({ id, ...payload });
      const playlist = currentPlaylists.find((candidate) => candidate.id === id);
      if (playlist) playlist.name = payload.name;
    },
    async deletePlaylist(id) {
      calls.deleted.push(id);
      const index = currentPlaylists.findIndex((playlist) => playlist.id === id);
      if (index >= 0) currentPlaylists.splice(index, 1);
    },
    async scanLibrary() {
      calls.scans += 1;
    },
  };
}

test.beforeEach(async () => {
  await resetDatabase(db);
  syncM3uPathMappings([]);
  delete process.env.M3U_PATH_MODE;
  delete process.env.M3U_PATH_MAPPINGS;
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("publishes mapped M3U files and ensures the Navidrome library", async () => {
  const owner = userOps.createUser("jody", "hash", "user");
  const flow = flowPlaylistConfig.createFlow({ name: "Morning Mix", ownerUserId: owner.id });
  const localRoot = path.join(weeklyFlowRoot, "music");
  const trackPath = path.join(localRoot, "Artist", "Song.flac");
  const client = createClient();
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  syncM3uPathMappings([{ local: localRoot, remote: "/navidrome/music" }]);
  process.env.M3U_PATH_MODE = "remote";

  assert.deepEqual(await destination.ensureLibrary(), { ok: true });
  assert.deepEqual(
    await destination.publishPlaylist(
      createPlaybackPlaylistSnapshot({
        entityId: flow.id,
        ownerUserId: owner.id,
        displayName: flow.name,
        tracks: [
          {
            path: trackPath,
            title: "Song",
            artist: "Artist",
            durationMs: 245600,
          },
        ],
      }),
    ),
    { ok: true },
  );

  assert.deepEqual(client.calls.ensured, [destination.playlistLibraryRoot.replace(/\\/g, "/")]);
  assert.equal(
    await fs.readFile(path.join(destination.libraryRoot, "jody - Morning Mix.m3u"), "utf8"),
    "#EXTM3U\n#EXTINF:246,Artist - Song\n/navidrome/music/Artist/Song.flac\n",
  );
});

test("publishes resolved tracks through the Subsonic API and stores the playlist ID", async () => {
  const owner = userOps.createUser("casey", "hash", "user");
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "API Mix",
    ownerUserId: owner.id,
  });
  const client = createClient({
    songs: {
      First: { id: "song-1" },
      Second: { id: "song-2" },
    },
  });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });

  assert.deepEqual(
    await destination.publishPlaylist(
      createPlaybackPlaylistSnapshot({
        entityId: playlist.id,
        ownerUserId: owner.id,
        displayName: playlist.name,
        tracks: [
          { path: "/music/first.flac", title: "First", artist: "Artist" },
          { path: "/music/second.flac", title: "Second", artist: "Artist" },
        ],
      }),
    ),
    { ok: true },
  );

  assert.deepEqual(client.calls.created, [
    { name: "casey - API Mix", songIds: ["song-1", "song-2"] },
  ]);
  assert.equal(
    navidromePlaylistPointerStore.getPointer(playlist.id, String(owner.id)).playlistId,
    "created",
  );
  await assert.rejects(
    fs.access(path.join(destination.libraryRoot, "casey - API Mix.m3u")),
  );
});

test("bounds concurrent Navidrome song lookups and preserves track order", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Large API Mix" });
  const tracks = Array.from({ length: 6 }, (_, index) => ({
    path: `/music/song-${index}.flac`,
    title: `Song ${index}`,
    artist: "Artist",
  }));
  const client = createClient({
    songs: Object.fromEntries(tracks.map((track, index) => [track.title, { id: `song-${index}` }])),
  });
  const findSong = client.findSong.bind(client);
  let active = 0;
  let maxActive = 0;
  client.findSong = async (...args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    const song = await findSong(...args);
    active -= 1;
    return song;
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });

  assert.deepEqual(
    await destination.publishPlaylist(
      createPlaybackPlaylistSnapshot({
        entityId: playlist.id,
        displayName: playlist.name,
        tracks,
      }),
    ),
    { ok: true },
  );
  assert.equal(maxActive, 5);
  assert.deepEqual(client.calls.created[0].songIds, tracks.map((_, index) => `song-${index}`));
});

test("creates an empty API playlist without waiting for a scan", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Empty" });
  const client = createClient();
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });

  assert.deepEqual(
    await destination.publishPlaylist(
      createPlaybackPlaylistSnapshot({
        entityId: playlist.id,
        displayName: playlist.name,
        tracks: [],
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(client.calls.created, [{ name: "Empty", songIds: [] }]);
});

test("serializes concurrent publishes before creating a native playlist", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Concurrent" });
  const client = createClient({ songs: { Song: { id: "song-1" } } });
  const createPlaylist = client.createPlaylist.bind(client);
  let createEntrants = 0;
  let releaseCreate;
  let signalCreate;
  const createStarted = new Promise((resolve) => {
    signalCreate = resolve;
  });
  client.createPlaylist = async (...args) => {
    createEntrants += 1;
    signalCreate();
    await new Promise((resolve) => {
      releaseCreate = resolve;
    });
    return createPlaylist(...args);
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  const snapshot = createPlaybackPlaylistSnapshot({
    entityId: playlist.id,
    displayName: playlist.name,
    tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
  });

  const publishes = [destination.publishPlaylist(snapshot), destination.publishPlaylist(snapshot)];
  await createStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createEntrants, 1);
  releaseCreate();
  await Promise.all(publishes);

  assert.equal(client.calls.created.length, 1);
  assert.deepEqual(client.calls.updated, []);
});

test("adopts an imported M3U playlist and keeps its ID across rename and delete", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Imported" });
  const client = createClient({
    playlists: [{ id: "imported-id", name: "Imported" }],
    songs: { Song: { id: "song-1" } },
  });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  await fs.writeFile(path.join(destination.libraryRoot, "Imported.m3u"), "legacy");
  const updatePlaylist = client.updatePlaylist.bind(client);
  let releaseUpdate;
  let signalUpdate;
  const updateStarted = new Promise((resolve) => {
    signalUpdate = resolve;
  });
  client.updatePlaylist = async (...args) => {
    signalUpdate();
    await new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    return updatePlaylist(...args);
  };

  const migrating = destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: "Imported",
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );
  await updateStarted;
  assert.equal(
    await fs.readFile(path.join(destination.libraryRoot, "Imported.m3u"), "utf8"),
    "legacy",
  );
  releaseUpdate();
  await migrating;
  client.updatePlaylist = updatePlaylist;
  await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: "Renamed",
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );
  assert.deepEqual(client.calls.updated, [
    { id: "imported-id", name: "Imported", songIds: ["song-1"] },
    { id: "imported-id", name: "Renamed", songIds: ["song-1"] },
  ]);
  assert.equal(
    navidromePlaylistPointerStore.getPointer(playlist.id, "global").playlistId,
    "imported-id",
  );

  await destination.deletePlaylist(
    createPlaybackPlaylistIdentity({ entityId: playlist.id }),
  );
  assert.deepEqual(client.calls.deleted, ["imported-id"]);
  assert.equal(navidromePlaylistPointerStore.getPointer(playlist.id, "global"), null);
});

test("does not adopt a same-name playlist claimed by another Aurral entity", async () => {
  const second = flowPlaylistConfig.createSharedPlaylist({ name: "Same Name" });
  const client = createClient({
    playlists: [{ id: "claimed-id", name: "Same Name" }],
    songs: { Song: { id: "song-1" } },
  });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer("other-entity", "global", {
    playlistId: "claimed-id",
    title: second.name,
  });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  await fs.writeFile(path.join(destination.libraryRoot, "Same Name.m3u"), "migration");

  await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: second.id,
      displayName: second.name,
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );

  assert.deepEqual(client.calls.updated, []);
  assert.deepEqual(client.calls.created, [{ name: "Same Name", songIds: ["song-1"] }]);
});

test("converts the M3U fallback after Navidrome indexes a missing song", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Catch-up" });
  const songs = {};
  const client = createClient({ songs });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  const snapshot = createPlaybackPlaylistSnapshot({
    entityId: playlist.id,
    displayName: playlist.name,
    tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
  });

  await destination.publishPlaylist(snapshot);
  await assert.doesNotReject(fs.access(path.join(destination.libraryRoot, "Catch-up.m3u")));
  songs.Song = { id: "indexed-song" };
  destination._scheduleCatchup([0]);
  while (destination._catchupRunning) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.deepEqual(client.calls.created, [
    { name: "Catch-up", songIds: ["indexed-song"] },
  ]);
  await assert.rejects(fs.access(path.join(destination.libraryRoot, "Catch-up.m3u")));
});

test("updates a stored playlist ID without relying on the playlist list", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Stored" });
  const client = createClient({ songs: { Song: { id: "song-1" } } });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(playlist.id, "global", {
    playlistId: "saved-id",
    title: playlist.name,
  });

  const result = await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: playlist.name,
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(client.calls.updated, [
    { id: "saved-id", name: "Stored", songIds: ["song-1"] },
  ]);
  assert.deepEqual(client.calls.created, []);
});

test("retries a transient missing-ID response without replacing the playlist", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Transient" });
  const client = createClient({ songs: { Song: { id: "song-1" } } });
  const updatePlaylist = client.updatePlaylist.bind(client);
  let attempts = 0;
  client.updatePlaylist = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("temporarily missing");
      error.code = 70;
      throw error;
    }
    return updatePlaylist(...args);
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(playlist.id, "global", {
    playlistId: "saved-id",
    title: playlist.name,
  });

  const result = await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: playlist.name,
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(client.calls.created, []);
  assert.equal(
    navidromePlaylistPointerStore.getPointer(playlist.id, "global").playlistId,
    "saved-id",
  );
});

test("recreates a stored playlist only when Navidrome reports it missing", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Missing" });
  const client = createClient({ songs: { Song: { id: "song-1" } } });
  client.updatePlaylist = async () => {
    const error = new Error("not found");
    error.code = 70;
    throw error;
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(playlist.id, "global", {
    playlistId: "missing-id",
    title: playlist.name,
  });

  const result = await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: playlist.name,
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(client.calls.created, [{ name: "Missing", songIds: ["song-1"] }]);
});

test("keeps the stored playlist ID when Navidrome is unavailable", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Offline" });
  const client = createClient({ songs: { Song: { id: "song-1" } } });
  client.updatePlaylist = async () => {
    throw new Error("offline");
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(playlist.id, "global", {
    playlistId: "saved-id",
    title: playlist.name,
  });

  const result = await destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: playlist.id,
      displayName: playlist.name,
      tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    navidromePlaylistPointerStore.getPointer(playlist.id, "global").playlistId,
    "saved-id",
  );
});

test("deletes the current playlist but preserves its artwork", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Quiet Night" });
  const client = createClient({ playlists: [{ id: "current", name: "Quiet Night" }] });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  await fs.writeFile(path.join(destination.libraryRoot, "Quiet Night.m3u"), "playlist");
  await fs.writeFile(path.join(destination.libraryRoot, "Quiet Night.nsp"), "playlist");
  await fs.writeFile(path.join(destination.libraryRoot, "Quiet Night.webp"), "artwork");

  assert.deepEqual(
    await destination.deletePlaylist(
      createPlaybackPlaylistIdentity({ entityId: flow.id, ownerUserId: null }),
    ),
    { ok: true },
  );

  await assert.rejects(fs.access(path.join(destination.libraryRoot, "Quiet Night.m3u")));
  await assert.rejects(fs.access(path.join(destination.libraryRoot, "Quiet Night.nsp")));
  await assert.doesNotReject(fs.access(path.join(destination.libraryRoot, "Quiet Night.webp")));
  assert.deepEqual(client.calls.deleted, ["current"]);
});

test("cleans local files when deleting a stored playlist during an outage", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Offline Delete" });
  const client = createClient({ playlists: [{ id: "saved-id", name: flow.name }] });
  client.deletePlaylist = async () => {
    throw new Error("offline");
  };
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(flow.id, "global", {
    playlistId: "saved-id",
    title: flow.name,
  });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  await fs.writeFile(path.join(destination.libraryRoot, `${flow.name}.m3u`), "playlist");

  const result = await destination.deletePlaylist(
    createPlaybackPlaylistIdentity({ entityId: flow.id }),
  );

  assert.equal(result.ok, false);
  await assert.rejects(fs.access(path.join(destination.libraryRoot, `${flow.name}.m3u`)));
  assert.equal(
    navidromePlaylistPointerStore.getPointer(flow.id, "global").playlistId,
    "saved-id",
  );
});

test("keeps a stored pointer while deleting local files when Navidrome is unconfigured", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Disabled Delete" });
  const client = createClient({ configured: false });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  navidromePlaylistPointerStore.setPointer(flow.id, "global", {
    playlistId: "saved-id",
    title: flow.name,
  });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  await fs.writeFile(path.join(destination.libraryRoot, `${flow.name}.m3u`), "playlist");

  assert.deepEqual(
    await destination.deletePlaylist(createPlaybackPlaylistIdentity({ entityId: flow.id })),
    { ok: true },
  );
  assert.deepEqual(client.calls.deleted, []);
  await assert.rejects(fs.access(path.join(destination.libraryRoot, `${flow.name}.m3u`)));
  assert.equal(
    navidromePlaylistPointerStore.getPointer(flow.id, "global").playlistId,
    "saved-id",
  );
});

test("publishing adopts one legacy playlist and removes the other legacy copies", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Road Trip" });
  const client = createClient({
    playlists: [
      { id: "bracketed", name: "[A] Road Trip" },
      { id: "prefixed", name: "Aurral Road Trip" },
    ],
    songs: { Song: { id: "song-1" } },
  });
  const destination = new NavidromePlaybackDestination(weeklyFlowRoot, { client });
  await fs.mkdir(destination.libraryRoot, { recursive: true });
  for (const name of ["[A] Road Trip", "Aurral Road Trip"]) {
    await fs.writeFile(path.join(destination.libraryRoot, `${name}.m3u`), "legacy");
    await fs.writeFile(path.join(destination.libraryRoot, `${name}.webp`), "legacy artwork");
  }

  assert.deepEqual(
    await destination.publishPlaylist(
      createPlaybackPlaylistSnapshot({
        entityId: flow.id,
        displayName: flow.name,
        tracks: [{ path: "/music/song.flac", title: "Song", artist: "Artist" }],
      }),
    ),
    { ok: true },
  );

  for (const name of ["[A] Road Trip", "Aurral Road Trip"]) {
    await assert.rejects(fs.access(path.join(destination.libraryRoot, `${name}.m3u`)));
    await assert.rejects(fs.access(path.join(destination.libraryRoot, `${name}.webp`)));
  }
  assert.deepEqual(client.calls.updated, [
    { id: "bracketed", name: "Road Trip", songIds: ["song-1"] },
  ]);
  assert.deepEqual(client.calls.deleted, ["prefixed"]);
});

test("requests configured scans and treats an unconfigured destination as a no-op", async () => {
  const configuredClient = createClient();
  const configured = new NavidromePlaybackDestination(weeklyFlowRoot, {
    client: configuredClient,
  });
  const unconfiguredClient = createClient({ configured: false });
  const unconfigured = new NavidromePlaybackDestination(weeklyFlowRoot, {
    client: unconfiguredClient,
  });

  assert.deepEqual(await configured.requestScan(), { ok: true });
  assert.deepEqual(await unconfigured.requestScan(), { ok: true });
  assert.equal(configuredClient.calls.scans, 1);
  assert.equal(unconfiguredClient.calls.scans, 0);
});
