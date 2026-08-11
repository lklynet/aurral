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
  { downloadTracker },
  { flowPlaylistConfig },
  { collectPlaybackPlaylistTracks },
] = await setupIsolatedBackend(
  "playback-playlist-tracks",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/playback/playbackPlaylistTracks.js",
);

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("preserves shared playlist track order", async () => {
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

  const secondJobId = downloadTracker.addJob(playlist.tracks[0], playlist.id);
  const firstJobId = downloadTracker.addJob(playlist.tracks[1], playlist.id);
  downloadTracker.setDone(secondJobId, secondPath, "Album");
  downloadTracker.setDone(firstJobId, firstPath, "Album");

  const entries = await collectPlaybackPlaylistTracks(playlist.id, { weeklyFlowRoot });
  assert.deepEqual(entries.map((entry) => entry.path), [secondPath, firstPath]);
});

test("keeps completed tracks after metadata correction", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Corrected album",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Imported album" }],
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

  const entries = await collectPlaybackPlaylistTracks(playlist.id, { weeklyFlowRoot });
  assert.deepEqual(entries.map((entry) => entry.path), [trackPath]);
});

test("normalizes empty migrated names", async () => {
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
