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
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "plex-playlist-sync",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

const { downloadTracker } = trackerModule;
const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("Plex sync includes reused tracks from the Lidarr music library", async () => {
  const playlist = {
    id: "imported-playlist",
    name: "Imported playlist",
  };
  const track = {
    artistName: "Artist",
    trackName: "Song",
    albumName: "Album",
  };
  const localPath = path.join(weeklyFlowRoot, "lidarr", "Artist", "Album", "Song.flac");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio");
  const jobId = downloadTracker.addJob(track, playlist.id);
  downloadTracker.setDone(jobId, localPath, track.albumName, "/music/Artist/Album/Song.flac");
  const duplicateJobId = downloadTracker.addJob(track, playlist.id);
  downloadTracker.setDone(
    duplicateJobId,
    localPath,
    track.albumName,
    "/music/Artist/Album/Song.flac",
  );

  const created = [];
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  manager.plexClient = {
    ensureWeeklyFlowLibrary: async () => ({ key: "aurral" }),
    getTracks: async () => [],
    getMusicTracks: async (sectionId) => {
      assert.equal(sectionId, "aurral");
      return [
        {
          ratingKey: "lidarr-track",
          files: ["/music/Artist/Album/Song.flac"],
        },
      ];
    },
    getPlaylists: async () => [],
    createPlaylist: async (title, ratingKeys) => {
      created.push({ title, ratingKeys });
    },
    deletePlaylist: async () => {},
  };

  await manager._syncPlexPlaylists([], [playlist]);

  assert.deepEqual(created, [
    {
      title: playlist.name,
      ratingKeys: ["lidarr-track"],
    },
  ]);
  assert.equal(await fs.readFile(localPath, "utf8"), "audio");
  await assert.rejects(fs.access(path.join(manager.playlistLibraryRoot, playlist.id)));
});

test("Plex sync keeps Aurral tracks when the Lidarr library is unavailable", async () => {
  const playlist = {
    id: "imported-playlist",
    name: "Imported playlist",
  };
  const track = {
    artistName: "Artist",
    trackName: "Song",
    albumName: "Album",
  };
  const jobId = downloadTracker.addJob(track, playlist.id);
  downloadTracker.setDone(
    jobId,
    path.join(weeklyFlowRoot, "lidarr", "Artist", "Album", "Song.flac"),
    track.albumName,
    "/music/Artist/Album/Song.flac",
  );

  const created = [];
  const manager = new WeeklyFlowPlaylistManager(weeklyFlowRoot);
  manager.plexClient = {
    ensureWeeklyFlowLibrary: async () => ({ key: "aurral" }),
    getTracks: async () => [
      {
        ratingKey: "aurral-track",
        files: [
          path.join(
            weeklyFlowRoot,
            "aurral-weekly-flow",
            playlist.id,
            "Artist",
            "Album",
            "Song.flac",
          ),
        ],
      },
    ],
    getMusicTracks: async () => {
      throw new Error("Lidarr library unavailable");
    },
    getPlaylists: async () => [],
    createPlaylist: async (title, ratingKeys) => {
      created.push({ title, ratingKeys });
    },
    deletePlaylist: async () => {},
  };

  await manager._syncPlexPlaylists([], [playlist]);

  assert.deepEqual(created, [
    {
      title: playlist.name,
      ratingKeys: ["aurral-track"],
    },
  ]);
});
