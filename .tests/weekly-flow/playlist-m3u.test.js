import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-m3u");
applyIsolatedBackendEnv(isolatedState);

const [
  { db },
  trackerModule,
  configModule,
  m3uModule,
  { WeeklyFlowPlaylistManager },
] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/weeklyFlowDownloadTracker.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistConfig.js"),
  importFromRepo("backend/services/playlistM3u.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistManager.js"),
]);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = configModule;
const { buildM3uContent, collectPlaylistM3uEntries } = m3uModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("buildM3uContent writes absolute paths with extinf metadata", () => {
  const content = buildM3uContent([
    {
      path: "/data/music/Artist/Album/Track.flac",
      title: "Track",
      artist: "Artist",
      durationSeconds: 245,
    },
  ]);
  assert.match(content, /^#EXTM3U\n/);
  assert.match(content, /#EXTINF:245,Artist - Track\n/);
  assert.match(content, /\/data\/music\/Artist\/Album\/Track\.flac\n$/);
});

test("collectPlaylistM3uEntries preserves shared playlist track order", async () => {
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

  const entries = await collectPlaylistM3uEntries(playlist.id, {
    weeklyFlowRoot,
  });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [secondPath, firstPath],
  );
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
  await manager.refreshPlaylist(playlist.id);

  const m3uPath = path.join(
    manager.libraryRoot,
    `${manager._sanitize(manager._getSharedPlaylistNames("Ready").current)}.m3u`,
  );
  const content = await fs.readFile(m3uPath, "utf8");
  assert.match(content, /#EXTM3U/);
  assert.match(content, new RegExp(trackPath.replace(/\\/g, "/")));
});

test("collectPlaylistM3uEntries uses stored external paths in remote mode", async () => {
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

  const entries = await collectPlaylistM3uEntries(playlist.id, {
    weeklyFlowRoot,
    m3uPathMode: "remote",
  });
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].path,
    "N:/ServerFolders/Music/Music/Artist/Song.flac",
  );
});

test("collectPlaylistM3uEntries inverts path mappings in remote mode", async () => {
  const previousMappings = process.env.PATH_MAPPINGS;
  const mappedRoot = path.join(weeklyFlowRoot, "mapped-root");
  const localPath = path.join(mappedRoot, "Aurral", "Mapped", "Artist", "Song.flac");
  process.env.PATH_MAPPINGS = `N:/ServerFolders/Music|${mappedRoot}`;

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Mapped",
    tracks: [{ artistName: "Artist", trackName: "Song", albumName: "Album" }],
  });
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio");
  const jobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  downloadTracker.setDone(jobId, localPath, "Album");

  const entries = await collectPlaylistM3uEntries(playlist.id, {
    weeklyFlowRoot,
    m3uPathMode: "remote",
  });

  if (previousMappings === undefined) delete process.env.PATH_MAPPINGS;
  else process.env.PATH_MAPPINGS = previousMappings;

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].path,
    "N:/ServerFolders/Music/Aurral/Mapped/Artist/Song.flac",
  );
});
