import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  trackerModule,
  reuseModule,
  playlistConfigModule,
  playlistManagerModule,
  libraryStore,
  managementStore,
] = await setupIsolatedBackend(
  "file-reuse",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/fileReuse.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { playlistManager } = playlistManagerModule;
const {
  moveHandedOverTracksToLidarr,
  pathsShareDevice,
  reuseTrackForPlaylist,
  repairJobsUnderRemovedPlaylistDir,
  repairOrphanedPlaylistTrackPaths,
  repairReusableTrackLinks,
  restoreCompletedTrack,
  relocateSharedFilesBeforePlaylistRemoval,
  removePlaylistFileIfUnshared,
} = reuseModule;

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

test.after(async () => {
  const { downloadWorker } = await importFromRepo(
    "backend/services/downloadJobs/downloadWorker.js",
  );
  await downloadWorker.stopAndDrain();
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
    downloadRoot,
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
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, sourcePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, sourcePath);
});

test("reusing an existing track for a flow does not schedule a full library scan", async (t) => {
  const flow = flowPlaylistConfig.createFlow({ name: "Reuse Flow", size: 10 });
  const track = {
    artistName: "System of a Down",
    trackName: "Chop Suey",
    albumName: "Toxicity",
  };
  const sourcePath = path.join(
    downloadRoot,
    "_flows",
    flow.id,
    "System of a Down",
    "Toxicity",
    "Chop Suey.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);

  const result = await reuseTrackForPlaylist(track, flow.id, {
    existingFileMode: "reuse",
    downloadRoot,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.reused, true);
  assert.equal(scheduleScanLibrary.mock.callCount(), 0);
});

test("reuseTrackForPlaylist detects and reuses local audio file from disk without prior tracker job (#741)", async () => {
  const track = {
    artistName: "Ella Langley",
    trackName: "Choosin' Texas",
    albumName: "Hungover",
  };
  const localFilePath = path.join(
    downloadRoot,
    "Ella Langley",
    "Hungover",
    "Choosin' Texas.flac",
  );
  await fs.mkdir(path.dirname(localFilePath), { recursive: true });
  await fs.writeFile(localFilePath, "audio");

  const result = await reuseTrackForPlaylist(track, "library", {
    existingFileMode: "reuse",
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, localFilePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, localFilePath);
});

test("reuseTrackForPlaylist finds a local file named with its album position", async () => {
  const track = { artistName: "Numbered Artist", trackName: "Second Song", albumName: "Numbered Album" };
  const albumDir = path.join(downloadRoot, "Numbered Artist", "Numbered Album");
  await fs.mkdir(albumDir, { recursive: true });
  await fs.writeFile(path.join(albumDir, "01 - Other Second Song.flac"), "audio");
  const localFilePath = path.join(albumDir, "02 - Second Song.flac");
  await fs.writeFile(localFilePath, "audio");

  const result = await reuseTrackForPlaylist(track, "library", {
    existingFileMode: "reuse",
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.finalPath, localFilePath);

  const reprise = { artistName: "Numbered Artist", trackName: "Theme", albumName: "Repeated Album", trackNumber: 9 };
  const repeatedDir = path.join(downloadRoot, "Numbered Artist", "Repeated Album");
  await fs.mkdir(repeatedDir, { recursive: true });
  await fs.writeFile(path.join(repeatedDir, "01 - Theme.flac"), "audio");
  const options = { existingFileMode: "reuse", downloadRoot };
  assert.equal((await reuseTrackForPlaylist(reprise, "library", options)).reused, false);
  const reprisePath = path.join(repeatedDir, "09 - Theme.flac");
  await fs.writeFile(reprisePath, "audio");
  assert.equal((await reuseTrackForPlaylist(reprise, "library", options)).finalPath, reprisePath);
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
      downloadRoot,
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
    downloadRoot,
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
    { existingFileMode: "reuse", downloadRoot },
  );

  assert.equal(result.reused, false);
});

test("reuseTrackForPlaylist does not inspect sources when reuse is disabled", async () => {
  const result = await reuseTrackForPlaylist(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "target-playlist",
    {
      existingFileMode: "download",
      downloadRoot,
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
    downloadRoot,
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
    downloadRoot,
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
    downloadRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Change.flac",
  );
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, missingPath, track.albumName);

  const result = await restoreCompletedTrack(downloadTracker.getJob(jobId), {
    existingFileMode: "reuse",
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.action, "requeued");
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, null);
});

test("repairJobsUnderRemovedPlaylistDir requeues other playlists that reused a deleted flow folder", async (t) => {
  const track = {
    artistName: "Metric",
    trackName: "Victim of Luck",
    albumName: "Romanticize the Dive",
  };
  const deletedFlowId = "deleted-flow";
  const reusedPath = path.join(
    downloadRoot,
    "aurral-weekly-flow",
    deletedFlowId,
    "Metric",
    "Romanticize the Dive",
    "Victim of Luck.mp3",
  );
  const jobId = downloadTracker.addJob(track, "active-playlist");
  downloadTracker.setDone(jobId, reusedPath, track.albumName);
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);

  const result = await repairJobsUnderRemovedPlaylistDir(deletedFlowId, {
    existingFileMode: "reuse",
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, null);
  assert.equal(scheduleScanLibrary.mock.callCount(), 0);
});

test("repairOrphanedPlaylistTrackPaths finds removed playlist ids from missing file paths", async () => {
  const track = {
    artistName: "Metric",
    trackName: "Victim of Luck",
    albumName: "Romanticize the Dive",
  };
  const deletedFlowId = "56cb64eb-e545-4760-bb29-58ad2ccaccea";
  const reusedPath = path.join(
    downloadRoot,
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
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.deepEqual(result.removedIds, [deletedFlowId]);
  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
});

test("repairReusableTrackLinks requeues missing completed tracks and refreshes playlists", async (t) => {
  const track = {
    artistName: "Portishead",
    trackName: "Glory Box",
    albumName: "Dummy",
  };
  const missingPath = path.join(
    downloadRoot,
    "aurral-weekly-flow",
    "flow-playlist",
    "Glory Box.flac",
  );
  const jobId = downloadTracker.addJob(track, "flow-playlist");
  downloadTracker.setDone(jobId, missingPath, track.albumName);
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);

  const result = await repairReusableTrackLinks({
    existingFileMode: "reuse",
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(scheduleScanLibrary.mock.callCount(), 0);
});

test("repairReusableTrackLinks scans after repairing a library track", async (t) => {
  const track = {
    artistName: "Portishead",
    trackName: "Glory Box",
    albumName: "Dummy",
  };
  const sourcePath = path.join(isolatedState.baseDir, "library-source.flac");
  await fs.writeFile(sourcePath, "audio");
  const missingPath = path.join(downloadRoot, "Portishead", "Dummy", "Glory Box.flac");
  const jobId = downloadTracker.addJob(track, "library");
  downloadTracker.setDone(jobId, missingPath, track.albumName);
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);

  const result = await repairReusableTrackLinks({
    existingFileMode: "reuse",
    downloadRoot,
    resolveSource: async () => ({
      source: { sourceType: "aurral", sourcePath, albumName: track.albumName },
      reason: null,
    }),
  });

  assert.equal(result.repaired, 1);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, sourcePath);
  assert.equal(scheduleScanLibrary.mock.callCount(), 1);
});

test("reuseTrackForPlaylist path-shares flow files until refresh relocates them", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Discover Weekly", size: 10 });
  const track = {
    artistName: "Burial",
    trackName: "Archangel",
    albumName: "Untrue",
  };
  const sourcePath = path.join(
    downloadRoot,
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
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, sourcePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, sourcePath);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "audio");

  const relocated = await relocateSharedFilesBeforePlaylistRemoval(flow.id, {
    downloadRoot,
  });
  const expectedPath = path.join(
    downloadRoot,
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
    downloadRoot,
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
    downloadRoot,
  });

  const expectedPath = path.join(
    downloadRoot,
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
    downloadRoot,
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
    downloadRoot,
    excludeJobIds: [ownerJobId],
  });

  const expectedPath = path.join(
    downloadRoot,
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
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "External" });
  const track = {
    artistName: "Aphex Twin",
    trackName: "External Xtal",
    albumName: "Selected Ambient Works",
  };
  const externalPath = path.join(downloadRoot, "external-xtal.flac");
  await fs.mkdir(path.dirname(externalPath), { recursive: true });
  await fs.writeFile(externalPath, "audio");
  const jobId = downloadTracker.addJob(track, playlist.id);
  downloadTracker.setDone(jobId, externalPath, track.albumName, "/music/External Xtal.flac");

  const result = await removePlaylistFileIfUnshared(externalPath, playlist.id, {
    downloadRoot,
    excludeJobIds: [jobId],
    deleteIfUnshared: true,
  });

  assert.equal(result.action, "skipped");
  await fs.access(externalPath);
});

async function seedHandoverAlbum({ handedOver = true } = {}) {
  const artistMbid = "f1111111-1111-4111-8111-111111111111";
  const albumMbid = "f2222222-2222-4222-8222-222222222222";
  const trackMbid = "f3333333-3333-4333-8333-333333333333";
  const aurralPath = path.join(downloadRoot, "Handover Artist", "Handover Album", "01 Single.flac");
  const lidarrPath = path.join(isolatedState.dataDir, "lidarr", "Handover Artist", "Handover Album", "01 Single.flac");
  for (const [filePath, content] of [[aurralPath, "aurral"], [lidarrPath, "lidarr"]]) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Handover Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: "Handover Album",
    metadata: handedOver ? { aurralHandoverAt: Date.now() } : {},
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "lidarr" });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: "Single",
    artistName: "Handover Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  for (const [source, filePath] of [["aurral", aurralPath], ["lidarr", lidarrPath]]) {
    libraryStore.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source, path: filePath });
  }
  const jobId = downloadTracker.addJob(
    {
      artistName: "Handover Artist",
      trackName: "Single",
      albumName: "Handover Album",
      artistMbid,
      albumMbid,
      trackMbid,
    },
    "synced-playlist",
  );
  downloadTracker.setDone(jobId, aurralPath, "Handover Album");
  return { jobId, aurralPath, lidarrPath };
}

const fileExists = (filePath) => fs.access(filePath).then(() => true, () => false);

test("a playlist track of an album handed to Lidarr moves onto Lidarr's file and the Aurral copy goes", async (t) => {
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  const { jobId, aurralPath, lidarrPath } = await seedHandoverAlbum();

  const result = await moveHandedOverTracksToLidarr({
    downloadRoot,
    existingFileMode: "reuse",
    deletionGuard: { canDelete: async () => true },
  });

  assert.deepEqual(result, { moved: 1, deleted: 1 });
  assert.equal(path.resolve(downloadTracker.getJob(jobId).finalPath), path.resolve(lidarrPath));
  assert.equal(await fileExists(aurralPath), false);
  assert.equal(await fs.readFile(lidarrPath, "utf8"), "lidarr");
});

test("Aurral copies stay when the album was not handed over or playback still uses them", async (t) => {
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  const notHandedOver = await seedHandoverAlbum({ handedOver: false });

  await moveHandedOverTracksToLidarr({ downloadRoot, existingFileMode: "reuse" });
  assert.equal(downloadTracker.getJob(notHandedOver.jobId).finalPath, notHandedOver.aurralPath);

  await resetDatabase(db);
  downloadTracker.clearAll();
  const inUse = await seedHandoverAlbum();
  const result = await moveHandedOverTracksToLidarr({
    downloadRoot,
    existingFileMode: "reuse",
    deletionGuard: { canDelete: async () => false },
  });

  assert.deepEqual(result, { moved: 1, deleted: 0 });
  assert.equal(path.resolve(downloadTracker.getJob(inUse.jobId).finalPath), path.resolve(inUse.lidarrPath));
  assert.equal(await fileExists(inUse.aurralPath), true);
});

test("turning Lidarr off requeues downloads that used a Lidarr file", async (t) => {
  const { downloadWorker } = await importFromRepo("backend/services/downloadJobs/downloadWorker.js");
  const { lidarrClient } = await importFromRepo("backend/services/lidarrClient.js");
  const musicRoot = path.join(isolatedState.baseDir, "music");
  dbOps.updateSettings({
    integrations: { lidarr: { enabled: false, apiKey: "key", rootFolderPath: musicRoot } },
  });
  lidarrClient.updateConfig();
  t.mock.method(downloadWorker, "start", async () => {});
  t.mock.method(downloadWorker, "wake", () => {});
  const doneJob = (trackName, finalPath, externalPath = null) => {
    const id = downloadTracker.addJob({ artistName: "Artist", trackName }, "library");
    downloadTracker.setDone(id, finalPath, "Album", externalPath);
    return id;
  };
  const reused = doneJob("Reused", path.join(musicRoot, "Artist", "1.flac"), "/remote/music/Artist/1.flac");
  const repointed = doneJob("Repointed", path.join(musicRoot, "Artist", "2.flac"));
  const own = doneJob("Own", path.join(downloadRoot, "Artist", "3.flac"));
  const elsewhere = doneJob("Elsewhere", path.join(isolatedState.baseDir, "old-downloads", "4.flac"));

  assert.equal(await downloadWorker.releaseLidarrFiles(), 2);

  assert.equal(downloadTracker.getJob(reused).status, "pending");
  assert.equal(downloadTracker.getJob(repointed).status, "pending");
  assert.equal(downloadTracker.getJob(own).status, "done");
  assert.equal(downloadTracker.getJob(elsewhere).status, "done");

  dbOps.updateSettings({
    integrations: { lidarr: { enabled: true, apiKey: "key", rootFolderPath: musicRoot } },
  });
  lidarrClient.updateConfig();
  const kept = doneJob("Kept", path.join(musicRoot, "Artist", "5.flac"), "/remote/music/Artist/5.flac");
  assert.equal(await downloadWorker.releaseLidarrFiles(), 0);
  assert.equal(downloadTracker.getJob(kept).status, "done");
});

test("playlists reuse a Lidarr file only while Lidarr is on", async (t) => {
  const { lidarrClient } = await importFromRepo("backend/services/lidarrClient.js");
  const setLidarr = (enabled) => {
    dbOps.updateSettings({ integrations: { lidarr: { enabled, apiKey: "key" } } });
    lidarrClient.updateConfig();
  };
  t.after(() => setLidarr(false));
  const lidarrPath = path.join(isolatedState.baseDir, "music", "Reuse Artist", "Reuse Album", "01 Song.flac");
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "lidarr");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "name:reuse-artist", name: "Reuse Artist" });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "name:reuse-artist:reuse-album",
    artistId: artist.id,
    title: "Reuse Album",
  });
  const libraryTrack = libraryStore.upsertLibraryTrack({
    identityKey: "name:reuse-artist:reuse-album:song",
    title: "Song",
    artistName: "Reuse Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: libraryTrack.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({ trackId: libraryTrack.id, albumId: album.id, source: "lidarr", path: lidarrPath });
  const track = { artistName: "Reuse Artist", trackName: "Song", albumName: "Reuse Album" };

  setLidarr(false);
  const off = await reuseTrackForPlaylist(track, "off-playlist", { existingFileMode: "reuse", downloadRoot });
  setLidarr(true);
  const on = await reuseTrackForPlaylist(track, "on-playlist", { existingFileMode: "reuse", downloadRoot });

  assert.equal(off.reused, false);
  assert.equal(on.reused, true);
  assert.equal(on.sourceType, "lidarr");
});
