import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { flowPlaylistConfig },
  { collectPlaylistFileTracks },
] = await setupIsolatedBackend(
  "playlist-file-tracks",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistFileTracks.ts"),
);

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);

beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

function libraryTrack(track: { artistName: string; trackName: string; albumName?: string }) {
  const jobId = downloadTracker.addJob(track, "library");
  assert.ok(jobId != null);
  return { ...track, canonicalJobId: jobId };
}

test("preserves static playlist track order", async () => {
  const second = libraryTrack({ artistName: "A", trackName: "Second", albumName: "Album" });
  const first = libraryTrack({ artistName: "B", trackName: "First", albumName: "Album" });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Ordered",
    tracks: [second, first],
  });
  const secondPath = path.join(downloadRoot, "music", "second.flac");
  const firstPath = path.join(downloadRoot, "music", "first.flac");
  await fs.mkdir(path.dirname(secondPath), { recursive: true });
  await fs.writeFile(secondPath, "two");
  await fs.writeFile(firstPath, "one");
  downloadTracker.setDone(first.canonicalJobId, firstPath, "Album");
  downloadTracker.setDone(second.canonicalJobId, secondPath, "Album");

  const entries = await collectPlaylistFileTracks(playlist.id);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [secondPath, firstPath],
  );
});

test("normalizes empty migrated names", async () => {
  const track = libraryTrack({ artistName: "Artist", trackName: "Track" });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Migrated", tracks: [track] });
  const trackPath = path.join(downloadRoot, "music", "migrated.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  downloadTracker.setDone(track.canonicalJobId, trackPath);
  db.prepare("UPDATE download_jobs SET artist_name = '', track_name = ' ' WHERE id = ?").run(
    track.canonicalJobId,
  );
  downloadTracker._load();

  const tracks = await collectPlaylistFileTracks(playlist.id);
  assert.equal(tracks[0]?.artist, "Unknown Artist");
  assert.equal(tracks[0]?.title, "Unknown Track");
});
