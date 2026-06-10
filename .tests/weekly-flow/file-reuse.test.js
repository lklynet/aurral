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
  reuseTrackForPlaylist,
  createPlaylistFileEntry,
  repairCompletedTrackLink,
  repairReusableTrackLinks,
  pathsShareDevice,
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

test("normalizeExistingFileMode accepts supported modes and defaults invalid values", () => {
  assert.equal(normalizeExistingFileMode("download"), "download");
  assert.equal(normalizeExistingFileMode("hardlink"), "hardlink");
  assert.equal(normalizeExistingFileMode("copy"), "copy");
  assert.equal(normalizeExistingFileMode(""), "hardlink");
  assert.equal(normalizeExistingFileMode("unsupported"), "hardlink");
});

test("reuseTrackForPlaylist hardlinks a completed Aurral track into the target playlist", async () => {
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
    existingFileMode: "hardlink",
    weeklyFlowRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.linkType, "hardlink");
  assert.notEqual(result.finalPath, sourcePath);
  assert.equal(await fs.readFile(result.finalPath, "utf8"), "audio");

  const sourceStat = await fs.stat(sourcePath);
  const targetStat = await fs.stat(result.finalPath);
  assert.equal(targetStat.ino, sourceStat.ino);

  await fs.rm(result.finalPath, { force: true });
  assert.equal(await fs.readFile(sourcePath, "utf8"), "audio");
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
});

test("createPlaylistFileEntry can copy files directly", async () => {
  const sourcePath = path.join(weeklyFlowRoot, "source.mp3");
  const targetPath = path.join(weeklyFlowRoot, "target.mp3");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");

  const result = await createPlaylistFileEntry(sourcePath, targetPath, "copy");

  assert.equal(result.linked, true);
  assert.equal(result.linkType, "copy");
  assert.equal(await fs.readFile(targetPath, "utf8"), "audio");
  const sourceStat = await fs.stat(sourcePath);
  const targetStat = await fs.stat(targetPath);
  assert.notEqual(targetStat.ino, sourceStat.ino);
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

test("repairCompletedTrackLink replaces a standalone copy with a hardlink", async () => {
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
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(lidarrPath, "lidarr-audio");
  await fs.writeFile(playlistPath, "downloaded-audio");
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairCompletedTrackLink(
    downloadTracker.getJob(jobId),
    {
      existingFileMode: "hardlink",
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
  assert.equal(result.linkType, "hardlink");
  assert.equal(await fs.readFile(playlistPath, "utf8"), "lidarr-audio");
  const lidarrStat = await fs.stat(lidarrPath);
  const playlistStat = await fs.stat(playlistPath);
  assert.equal(playlistStat.ino, lidarrStat.ino);
});

test("repairCompletedTrackLink skips tracks already linked to the reusable source", async () => {
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
  await fs.link(sourcePath, playlistPath);
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairCompletedTrackLink(
    downloadTracker.getJob(jobId),
    {
      existingFileMode: "hardlink",
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
  assert.equal(result.reason, "Already linked to reusable source");
});

test("pathsShareDevice returns true for files in the same directory", async () => {
  const root = path.join(weeklyFlowRoot, "shared-device");
  const left = path.join(root, "source.flac");
  const right = path.join(root, "target.flac");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(left, "audio");

  assert.equal(await pathsShareDevice(left, right), true);
});

test("repairCompletedTrackLink skips hardlink repair across filesystems", async () => {
  const track = {
    artistName: "Artist",
    trackName: "Song",
    albumName: "Album",
  };
  const sourcePath = path.join(weeklyFlowRoot, "lidarr", "Song.flac");
  const playlistPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Song.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(sourcePath, "source-audio");
  await fs.writeFile(playlistPath, "playlist-audio");
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, playlistPath, track.albumName);

  const result = await repairCompletedTrackLink(
    downloadTracker.getJob(jobId),
    {
      existingFileMode: "hardlink",
      weeklyFlowRoot,
      deviceCheck: async () => false,
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
  assert.equal(result.reason, "Hardlink unavailable across filesystems");
  assert.equal(await fs.readFile(playlistPath, "utf8"), "playlist-audio");
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
