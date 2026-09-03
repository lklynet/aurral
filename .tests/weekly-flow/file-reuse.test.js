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
  { dbOps },
  trackerModule,
  reuseModule,
  playlistConfigModule,
] = await setupIsolatedBackend(
  "weekly-flow-file-reuse",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowFileReuse.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const {
  pathsShareDevice,
  reuseTrackForPlaylist,
  repairJobsUnderRemovedPlaylistDir,
  repairOrphanedPlaylistTrackPaths,
  repairReusableTrackLinks,
  restoreCompletedTrack,
  relocateSharedFilesBeforePlaylistRemoval,
  removePlaylistFileIfUnshared,
} = reuseModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  downloadTracker.clearAll();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
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

test("reuseTrackForPlaylist detects and reuses local audio file from disk without prior tracker job (#741)", async () => {
  const track = {
    artistName: "Ella Langley",
    trackName: "Choosin' Texas",
    albumName: "Hungover",
  };
  const localFilePath = path.join(
    weeklyFlowRoot,
    "Ella Langley",
    "Hungover",
    "Choosin' Texas.flac",
  );
  await fs.mkdir(path.dirname(localFilePath), { recursive: true });
  await fs.writeFile(localFilePath, "audio");

  const result = await reuseTrackForPlaylist(track, "library", {
    existingFileMode: "reuse",
    weeklyFlowRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, localFilePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, localFilePath);
});

test("reuseTrackForPlaylist neutralizes path traversal attempts in track metadata and target playlist", async () => {
  const result = await reuseTrackForPlaylist(
    {
      artistName: "../../etc",
      trackName: "../../passwd",
      albumName: "..",
    },
    "../../secrets",
    {
      existingFileMode: "reuse",
      weeklyFlowRoot,
    },
  );

  assert.equal(result.reused, false);
});

test("library reuse does not cross album boundaries for the same track title", async () => {
  const sourceTrack = {
    artistName: "Amigo the Devil",
    trackName: "Hell and You",
    albumName: "Everything is Fine",
    albumMbid: "everything-is-fine",
    trackMbid: "everything-track",
  };
  const sourcePath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "source-playlist",
    "Amigo the Devil",
    "Everything is Fine",
    "Hell and You.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = downloadTracker.addJob(sourceTrack, "source-playlist");
  downloadTracker.setDone(sourceJobId, sourcePath, sourceTrack.albumName);

  const result = await reuseTrackForPlaylist(
    {
      artistName: "Amigo the Devil",
      trackName: "Hell and You",
      albumName: "Volume 1",
      albumMbid: "volume-1",
      trackMbid: "volume-1-track",
    },
    "library",
    { existingFileMode: "reuse", weeklyFlowRoot },
  );

  assert.equal(result.reused, false);
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
  assert.equal(result.requeued, 0);
  assert.equal(await fs.readFile(playlistPath, "utf8"), "audio");
});

test("restoreCompletedTrack requeues done jobs when the file and reuse source are missing", async () => {
  const track = {
    artistName: "Deftones",
    trackName: "Change",
    albumName: "White Pony",
  };
  const missingPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Change.flac",
  );
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, missingPath, track.albumName);

  const result = await restoreCompletedTrack(downloadTracker.getJob(jobId), {
    existingFileMode: "reuse",
    weeklyFlowRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.action, "requeued");
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, null);
});

test("repairJobsUnderRemovedPlaylistDir requeues other playlists that reused a deleted flow folder", async () => {
  const track = {
    artistName: "Metric",
    trackName: "Victim of Luck",
    albumName: "Romanticize the Dive",
  };
  const deletedFlowId = "deleted-flow";
  const reusedPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    deletedFlowId,
    "Metric",
    "Romanticize the Dive",
    "Victim of Luck.mp3",
  );
  const jobId = downloadTracker.addJob(track, "active-playlist");
  downloadTracker.setDone(jobId, reusedPath, track.albumName);

  const result = await repairJobsUnderRemovedPlaylistDir(deletedFlowId, {
    existingFileMode: "reuse",
    weeklyFlowRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, null);
});

test("repairOrphanedPlaylistTrackPaths finds removed playlist ids from missing file paths", async () => {
  const track = {
    artistName: "Metric",
    trackName: "Victim of Luck",
    albumName: "Romanticize the Dive",
  };
  const deletedFlowId = "56cb64eb-e545-4760-bb29-58ad2ccaccea";
  const reusedPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    deletedFlowId,
    "Metric",
    "Romanticize the Dive",
    "Victim of Luck.mp3",
  );
  const jobId = downloadTracker.addJob(track, "active-playlist");
  downloadTracker.setDone(jobId, reusedPath, track.albumName);

  const result = await repairOrphanedPlaylistTrackPaths({
    existingFileMode: "reuse",
    weeklyFlowRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.deepEqual(result.removedIds, [deletedFlowId]);
  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
});

test("repairReusableTrackLinks requeues missing completed tracks and refreshes playlists", async () => {
  const track = {
    artistName: "Portishead",
    trackName: "Glory Box",
    albumName: "Dummy",
  };
  const missingPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Glory Box.flac",
  );
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, missingPath, track.albumName);

  const result = await repairReusableTrackLinks({
    existingFileMode: "reuse",
    weeklyFlowRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
});

test("reuseTrackForPlaylist path-shares flow files until refresh relocates them", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Discover Weekly", size: 10 });
  const track = {
    artistName: "Burial",
    trackName: "Archangel",
    albumName: "Untrue",
  };
  const sourcePath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    flow.id,
    "Burial",
    "Untrue",
    "Archangel.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = downloadTracker.addJob(track, flow.id);
  downloadTracker.setDone(sourceJobId, sourcePath, track.albumName);

  const result = await reuseTrackForPlaylist(track, "keepers", {
    existingFileMode: "reuse",
    weeklyFlowRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, sourcePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, sourcePath);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "audio");

  const relocated = await relocateSharedFilesBeforePlaylistRemoval(flow.id, {
    weeklyFlowRoot,
  });
  const expectedPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "keepers",
    "Burial",
    "Untrue",
    "Archangel.flac",
  );
  assert.equal(relocated.relocated, 1);
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
  await assert.rejects(fs.access(sourcePath));
});
test("relocateSharedFilesBeforePlaylistRemoval moves shared files to a survivor playlist", async () => {
  const track = {
    artistName: "Four Tet",
    trackName: "Two Thousand and Seventeen",
    albumName: "New Energy",
  };
  const ownerPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "owner-playlist",
    "Four Tet",
    "New Energy",
    "Two Thousand and Seventeen.flac",
  );
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  await fs.writeFile(ownerPath, "audio");
  const ownerJobId = downloadTracker.addJob(track, "owner-playlist");
  downloadTracker.setDone(ownerJobId, ownerPath, track.albumName);
  const sharedJobId = downloadTracker.addJob(track, "survivor-playlist");
  downloadTracker.setDone(sharedJobId, ownerPath, track.albumName);

  const result = await relocateSharedFilesBeforePlaylistRemoval("owner-playlist", {
    weeklyFlowRoot,
  });

  const expectedPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "survivor-playlist",
    "Four Tet",
    "New Energy",
    "Two Thousand and Seventeen.flac",
  );
  assert.equal(result.relocated, 1);
  assert.equal(downloadTracker.getJob(sharedJobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
  await assert.rejects(fs.access(ownerPath));
});

test("removePlaylistFileIfUnshared relocates when another playlist still references the file", async () => {
  const track = {
    artistName: "Aphex Twin",
    trackName: "Xtal",
    albumName: "Selected Ambient Works",
  };
  const ownerPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "owner-playlist",
    "Aphex Twin",
    "Selected Ambient Works",
    "Xtal.flac",
  );
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  await fs.writeFile(ownerPath, "audio");
  const ownerJobId = downloadTracker.addJob(track, "owner-playlist");
  downloadTracker.setDone(ownerJobId, ownerPath, track.albumName);
  const sharedJobId = downloadTracker.addJob(track, "other-playlist");
  downloadTracker.setDone(sharedJobId, ownerPath, track.albumName);

  const result = await removePlaylistFileIfUnshared(ownerPath, "owner-playlist", {
    weeklyFlowRoot,
    excludeJobIds: [ownerJobId],
  });

  const expectedPath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    "other-playlist",
    "Aphex Twin",
    "Selected Ambient Works",
    "Xtal.flac",
  );
  assert.equal(result.action, "relocated");
  assert.equal(downloadTracker.getJob(sharedJobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
});

test("removePlaylistFileIfUnshared preserves external files during shared cleanup", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "External" });
  const track = {
    artistName: "Aphex Twin",
    trackName: "External Xtal",
    albumName: "Selected Ambient Works",
  };
  const externalPath = path.join(weeklyFlowRoot, "external-xtal.flac");
  await fs.mkdir(path.dirname(externalPath), { recursive: true });
  await fs.writeFile(externalPath, "audio");
  const jobId = downloadTracker.addJob(track, playlist.id);
  downloadTracker.setDone(jobId, externalPath, track.albumName, "/music/External Xtal.flac");

  const result = await removePlaylistFileIfUnshared(externalPath, playlist.id, {
    weeklyFlowRoot,
    excludeJobIds: [jobId],
    deleteIfUnshared: true,
  });

  assert.equal(result.action, "skipped");
  await fs.access(externalPath);
});
