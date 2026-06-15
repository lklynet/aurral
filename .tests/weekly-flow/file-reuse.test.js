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

const isolatedState = await createIsolatedStateDir("weekly-flow-file-reuse");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, trackerModule, reuseModule] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/weeklyFlowDownloadTracker.js"),
  importFromRepo("backend/services/weeklyFlowFileReuse.js"),
]);

const { downloadTracker } = trackerModule;
const {
  normalizeExistingFileMode,
  pathsShareDevice,
  reuseTrackForPlaylist,
  repairCompletedTrackLink,
  repairReusableTrackLinks,
} = reuseModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("normalizeExistingFileMode accepts supported modes and maps legacy values", () => {
  assert.equal(normalizeExistingFileMode("download"), "download");
  assert.equal(normalizeExistingFileMode("reuse"), "reuse");
  assert.equal(normalizeExistingFileMode("hardlink"), "reuse");
  assert.equal(normalizeExistingFileMode("copy"), "reuse");
  assert.equal(normalizeExistingFileMode(""), "reuse");
  assert.equal(normalizeExistingFileMode("unsupported"), "reuse");
});

test("pathsShareDevice compares directory roots without ascending to filesystem root", async () => {
  const sharedRoot = path.join(isolatedState.baseDir, "media");
  const musicDir = path.join(sharedRoot, "music", "Artist", "Album");
  const downloadsDir = path.join(sharedRoot, "downloads", "aurral");
  const trackPath = path.join(musicDir, "Artist_Album_01_Track.mp3");
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.writeFile(trackPath, "audio");

  assert.equal(await pathsShareDevice(trackPath, downloadsDir), true);
  assert.equal(await pathsShareDevice(trackPath, path.join(sharedRoot, "downloads")), true);
});

test("reuseTrackForPlaylist references a completed Aurral track path", async () => {
  const track = {
    artistName: "System of a Down",
    trackName: "Chop Suey",
    albumName: "Toxicity",
  };
  const sourcePath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "source-playlist",
    "System of a Down",
    "Toxicity",
    "Chop Suey.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = downloadTracker.addJob(track, "source-playlist");
  downloadTracker.setDone(sourceJobId, sourcePath, track.albumName);

  const result = await reuseTrackForPlaylist(track, "target-playlist", {
    existingFileMode: "reuse",
    weeklyFlowRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, sourcePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, sourcePath);
});

test("reuseTrackForPlaylist does not inspect sources when reuse is disabled", async () => {
  const result = await reuseTrackForPlaylist(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "target-playlist",
    {
      existingFileMode: "download",
      weeklyFlowRoot,
    },
  );

  assert.equal(result.reused, false);
  assert.equal(downloadTracker.getAll().length, 0);
});

test("repairCompletedTrackLink updates missing playlist paths to a reusable source", async () => {
  const track = {
    artistName: "Radiohead",
    trackName: "Creep",
    albumName: "Pablo Honey",
  };
  const lidarrPath = path.join(weeklyFlowRoot, "lidarr-library", "Creep.flac");
  const playlistPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Radiohead",
    "Pablo Honey",
    "Creep.flac",
  );
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "lidarr-audio");
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairCompletedTrackLink(
    downloadTracker.getJob(jobId),
    {
      existingFileMode: "reuse",
      weeklyFlowRoot,
      resolveSource: async () => ({
        source: {
          sourceType: "lidarr",
          sourcePath: lidarrPath,
          albumName: track.albumName,
        },
        reason: null,
      }),
    },
  );

  assert.equal(result.repaired, true);
  assert.equal(result.sourceType, "lidarr");
  assert.equal(result.finalPath, lidarrPath);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, lidarrPath);
});

test("repairCompletedTrackLink skips tracks whose playlist file still exists", async () => {
  const track = {
    artistName: "Bjork",
    trackName: "Hyperballad",
    albumName: "Post",
  };
  const sourcePath = path.join(weeklyFlowRoot, "library", "Hyperballad.flac");
  const playlistPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Bjork",
    "Post",
    "Hyperballad.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(sourcePath, "shared-audio");
  await fs.writeFile(playlistPath, "playlist-audio");
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairCompletedTrackLink(
    downloadTracker.getJob(jobId),
    {
      existingFileMode: "reuse",
      weeklyFlowRoot,
      resolveSource: async () => ({
        source: {
          sourceType: "lidarr",
          sourcePath,
          albumName: track.albumName,
        },
        reason: null,
      }),
    },
  );

  assert.equal(result.repaired, false);
  assert.equal(result.reason, "Playlist file exists");
});

test("repairReusableTrackLinks does nothing when reuse is disabled", async () => {
  const track = {
    artistName: "Artist",
    trackName: "Song",
    albumName: "Album",
  };
  const playlistPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Song.flac",
  );
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(playlistPath, "audio");
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairReusableTrackLinks({
    existingFileMode: "download",
    weeklyFlowRoot,
  });

  assert.equal(result.scanned, 0);
  assert.equal(result.repaired, 0);
  assert.equal(await fs.readFile(playlistPath, "utf8"), "audio");
});
