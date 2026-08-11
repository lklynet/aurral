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
  { NavidromePlaybackDestination },
] = await setupIsolatedBackend(
  "navidrome-playback-destination",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/playlistM3uPaths.js",
  "backend/services/playback/playbackDestination.js",
  "backend/services/playback/navidromePlaybackDestination.js",
);

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

function createClient({ configured = true, playlists = [] } = {}) {
  const calls = { deleted: [], ensured: [], scans: 0 };
  return {
    calls,
    isConfigured: () => configured,
    async ping() {},
    async ensureWeeklyFlowLibrary(libraryPath) {
      calls.ensured.push(libraryPath);
    },
    async getPlaylists() {
      return playlists;
    },
    async deletePlaylist(id) {
      calls.deleted.push(id);
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

test("publishing removes legacy files and Navidrome playlists", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Road Trip" });
  const client = createClient({
    playlists: [
      { id: "bracketed", name: "[A] Road Trip" },
      { id: "prefixed", name: "Aurral Road Trip" },
    ],
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
        tracks: [],
      }),
    ),
    { ok: true },
  );

  for (const name of ["[A] Road Trip", "Aurral Road Trip"]) {
    await assert.rejects(fs.access(path.join(destination.libraryRoot, `${name}.m3u`)));
    await assert.rejects(fs.access(path.join(destination.libraryRoot, `${name}.webp`)));
  }
  assert.deepEqual(client.calls.deleted.sort(), ["bracketed", "prefixed"]);
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
