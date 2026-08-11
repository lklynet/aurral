import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  trackerModule,
  configModule,
  tracksModule,
  m3uPathsModule,
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "playlist-m3u",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/playback/playbackPlaylistTracks.js",
  "backend/services/playlistM3uPaths.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = configModule;
const { collectPlaybackPlaylistTracks } = tracksModule;
const { syncM3uPathMappings } = m3uPathsModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

function enableNavidrome(manager) {
  manager.navidromeDestination.client = {
    isConfigured: () => true,
    async ensureWeeklyFlowLibrary() {},
    async getPlaylists() {
      return [];
    },
    async deletePlaylist() {},
    async scanLibrary() {},
  };
}

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  syncM3uPathMappings([]);
  delete process.env.M3U_PATH_MODE;
  delete process.env.M3U_PATH_MAPPINGS;
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("collectPlaybackPlaylistTracks preserves shared playlist track order", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Ordered",
    tracks: [
      { artistName: "A", trackName: "Second", albumName: "Album" },
      { artistName: "B", trackName: "First", albumName: "Album" },
    ],
  });
  const secondPath = path.join(weeklyFlowRoot, "music", "second.flac");
  const firstPath = path.join(weeklyFlowRoot, "music", "first.flac");
  await fs.mkdir(path.dirname(secondPath), { recursive: true });
  await fs.writeFile(secondPath, "two");
  await fs.writeFile(firstPath, "one");

  const secondJobId = downloadTracker.addJob(
    playlist.tracks[0],
    playlist.id,
  );
  const firstJobId = downloadTracker.addJob(playlist.tracks[1], playlist.id);
  downloadTracker.setDone(secondJobId, secondPath, "Album");
  downloadTracker.setDone(firstJobId, firstPath, "Album");

  const entries = await collectPlaybackPlaylistTracks(playlist.id, {
    weeklyFlowRoot,
  });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [secondPath, firstPath],
  );
});

test("collectPlaybackPlaylistTracks keeps completed tracks after metadata correction", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Corrected album",
    tracks: [
      { artistName: "Artist", trackName: "Track", albumName: "Imported album" },
    ],
  });
  const trackPath = path.join(weeklyFlowRoot, "music", "track.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.updateMetadata(jobId, {
    artistName: "Resolved artist",
    trackName: "Resolved track",
  });
  downloadTracker.setDone(jobId, trackPath, "Resolved album");

  const entries = await collectPlaybackPlaylistTracks(playlist.id, {
    weeklyFlowRoot,
  });
  assert.deepEqual(entries.map((entry) => entry.path), [trackPath]);
});

test("collectPlaybackPlaylistTracks normalizes empty migrated names", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Migrated",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });
  const trackPath = path.join(weeklyFlowRoot, "music", "migrated.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(jobId, trackPath);
  downloadTracker.updateMetadata(jobId, { artistName: "", trackName: " " });

  const tracks = await collectPlaybackPlaylistTracks(playlist.id, { weeklyFlowRoot });

  assert.equal(tracks[0].artist, "Unknown Artist");
  assert.equal(tracks[0].title, "Unknown Track");
});

test("refreshPlaylist writes m3u entries for completed tracks", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Ready",
    tracks: [{ artistName: "Artist", trackName: "Song", albumName: "Album" }],
  });
  const trackPath = path.join(weeklyFlowRoot, "lidarr", "Song.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(jobId, trackPath, "Album");

  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  enableNavidrome(manager);
  await manager.refreshPlaylist(playlist.id);

  const m3uPath = path.join(
    manager.libraryRoot,
    `${manager._sanitize(manager.getPlaylistName(playlist.id))}.m3u`,
  );
  const content = await fs.readFile(m3uPath, "utf8");
  assert.match(content, /#EXTM3U/);
  assert.match(content, new RegExp(trackPath.replace(/\\/g, "/")));
});

test("ensurePlaylists continues after one Navidrome playlist fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const first = flowPlaylistConfig.createSharedPlaylist({ name: "Isolation Broken" });
  const second = flowPlaylistConfig.createSharedPlaylist({ name: "Isolation Ready" });
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  enableNavidrome(manager);
  const publish = manager.navidromeDestination.publishPlaylist.bind(
    manager.navidromeDestination,
  );
  manager.navidromeDestination.publishPlaylist = (snapshot) =>
    snapshot.entityId === first.id
      ? Promise.resolve({ ok: false, error: { message: "write failed" } })
      : publish(snapshot);

  await manager.ensurePlaylists();

  await assert.doesNotReject(
    fs.access(path.join(manager.libraryRoot, `${manager.getPlaylistName(second.id)}.m3u`)),
  );
});

test("the Navidrome adapter uses stored external paths in remote mode", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Remote",
    tracks: [{ artistName: "Artist", trackName: "Song", albumName: "Album" }],
  });
  const localPath = path.join(weeklyFlowRoot, "lidarr", "Song.flac");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(
    jobId,
    localPath,
    "Album",
    "N:\\ServerFolders\\Music\\Music\\Artist\\Song.flac",
  );

  process.env.M3U_PATH_MODE = "remote";
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  enableNavidrome(manager);
  await manager.refreshPlaylist(playlist.id);
  const content = await fs.readFile(
    path.join(manager.libraryRoot, `${manager.getPlaylistName(playlist.id)}.m3u`),
    "utf8",
  );
  assert.match(content, /N:\/ServerFolders\/Music\/Music\/Artist\/Song\.flac/);
});

test("the Navidrome adapter uses Navidrome path mappings in remote mode", async () => {
  const mappedRoot = path.join(weeklyFlowRoot, "navidrome-local");
  const localPath = path.join(
    mappedRoot,
    "Aurral",
    "Mapped",
    "Artist",
    "Song.flac",
  );
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Navidrome Mapped",
    tracks: [{ artistName: "Artist", trackName: "Song", albumName: "Album" }],
  });
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(jobId, localPath, "Album");
  process.env.M3U_PATH_MODE = "remote";
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  enableNavidrome(manager);
  syncM3uPathMappings([
    {
      local: mappedRoot,
      remote: "/music/aurral",
    },
  ]);
  await manager.refreshPlaylist(playlist.id);
  const content = await fs.readFile(
    path.join(manager.libraryRoot, `${manager.getPlaylistName(playlist.id)}.m3u`),
    "utf8",
  );
  assert.match(content, /\/music\/aurral\/Aurral\/Mapped\/Artist\/Song\.flac/);
});

test("the Navidrome adapter falls back to shared path mappings in remote mode", async () => {
  const previousMappings = process.env.PATH_MAPPINGS;
  const mappedRoot = path.join(weeklyFlowRoot, "mapped-root");
  const localPath = path.join(mappedRoot, "Aurral", "Mapped", "Artist", "Song.flac");
  process.env.PATH_MAPPINGS = `N:/ServerFolders/Music|${mappedRoot}`;

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Fallback Mapped",
    tracks: [{ artistName: "Artist", trackName: "Song", albumName: "Album" }],
  });
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(jobId, localPath, "Album");

  process.env.M3U_PATH_MODE = "remote";
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  enableNavidrome(manager);
  let content;
  try {
    await manager.refreshPlaylist(playlist.id);
    content = await fs.readFile(
      path.join(manager.libraryRoot, `${manager.getPlaylistName(playlist.id)}.m3u`),
      "utf8",
    );
  } finally {
    if (previousMappings === undefined) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = previousMappings;
  }

  assert.match(content, /N:\/ServerFolders\/Music\/Aurral\/Mapped\/Artist\/Song\.flac/);
});
