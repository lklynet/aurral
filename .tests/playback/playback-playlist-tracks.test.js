import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { flowPlaylistConfig },
  { collectPlaybackPlaylistTracks },
] = await setupIsolatedBackend(
  "playback-playlist-tracks",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/playback/playbackPlaylistTracks.js",
);

const downloadRoot = process.env.DOWNLOAD_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("preserves static playlist track order", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Ordered",
    tracks: [
      { artistName: "A", trackName: "Second", albumName: "Album" },
      { artistName: "B", trackName: "First", albumName: "Album" },
    ],
  });
  const secondPath = path.join(downloadRoot, "music", "second.flac");
  const firstPath = path.join(downloadRoot, "music", "first.flac");
  await fs.mkdir(path.dirname(secondPath), { recursive: true });
  await fs.writeFile(secondPath, "two");
  await fs.writeFile(firstPath, "one");

  const [firstJobId, secondJobId] = addStaticPlaylistJobs(
    { downloadTracker, flowPlaylistConfig },
    playlist.id,
    [playlist.tracks[1], playlist.tracks[0]],
  );
  downloadTracker.setDone(secondJobId, secondPath, "Album");
  downloadTracker.setDone(firstJobId, firstPath, "Album");

  const entries = await collectPlaybackPlaylistTracks(playlist.id, { downloadRoot });
  assert.deepEqual(entries.map((entry) => entry.path), [secondPath, firstPath]);
});

test("keeps completed tracks after metadata correction", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Corrected album",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Imported album" }],
  });
  const trackPath = path.join(downloadRoot, "music", "track.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [playlist.tracks[0]]);
  downloadTracker.updateMetadata(jobId, {
    artistName: "Resolved artist",
    trackName: "Resolved track",
  });
  downloadTracker.setDone(jobId, trackPath, "Resolved album");

  const entries = await collectPlaybackPlaylistTracks(playlist.id, { downloadRoot });
  assert.deepEqual(entries.map((entry) => entry.path), [trackPath]);
});

test("normalizes empty migrated names", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Migrated",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });
  const trackPath = path.join(downloadRoot, "music", "migrated.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [playlist.tracks[0]]);
  downloadTracker.setDone(jobId, trackPath);
  downloadTracker.updateMetadata(jobId, { artistName: "", trackName: " " });

  const tracks = await collectPlaybackPlaylistTracks(playlist.id, { downloadRoot });
  assert.equal(tracks[0].artist, "Unknown Artist");
  assert.equal(tracks[0].title, "Unknown Track");
});
