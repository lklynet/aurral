import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
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
  { dbOps },
  trackerModule,
  reuseModule,
  playlistConfigModule,
  playlistManagerModule,
  libraryStore,
] = await setupIsolatedBackend(
  "file-reuse",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/fileReuse.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { playlistManager } = playlistManagerModule;
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

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);

beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    staticPlaylists: [],
  });
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

afterAll(async () => {
  const { downloadWorker } = await import("../../backend/services/downloadJobs/downloadWorker.ts");
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
    "_flows",
    "source-flow",
    "System of a Down",
    "Toxicity",
    "Chop Suey.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = createTrackedJob(downloadTracker, track, "source-flow");
  assert.ok(sourceJobId != null);
  downloadTracker.setDone(sourceJobId, sourcePath, track.albumName);

  const result = await reuseTrackForPlaylist(track, "target-flow", {
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, sourcePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, sourcePath);
});

test("adding a flow track to the Library moves its file into the Library folder", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Source Flow", size: 10 });
  const track = {
    artistName: "Julia Holter",
    trackName: "Betsy on the Roof",
    albumName: "Wilderness",
  };
  const flowPath = path.join(
    downloadRoot,
    "_flows",
    flow.id,
    "Julia Holter",
    "Wilderness",
    "Betsy.flac",
  );
  await fs.mkdir(path.dirname(flowPath), { recursive: true });
  await fs.writeFile(flowPath, "audio");
  const flowJobId = createTrackedJob(downloadTracker, track, flow.id);
  assert.ok(flowJobId != null);
  downloadTracker.setDone(flowJobId, flowPath, track.albumName);
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);

  const result = await reuseTrackForPlaylist(track, "library", { downloadRoot });

  const libraryPath = path.join(downloadRoot, "Julia Holter", "Wilderness", "Betsy.flac");
  assert.equal(result.finalPath, libraryPath);
  assert.equal(downloadTracker.getJob(flowJobId)?.finalPath, libraryPath);
  await assert.rejects(fs.access(flowPath));
});

test("reusing an existing track for a flow does not schedule a full library scan", async () => {
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
  const scheduleScanLibrary = vi
    .spyOn(playlistManager, "scheduleScanLibrary")
    .mockImplementation(() => 1);
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);

  const result = await reuseTrackForPlaylist(track, flow.id, {
    downloadRoot,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.reused, true);
  assert.equal(scheduleScanLibrary.mock.calls.length, 0);
});

test("reuseTrackForPlaylist detects and reuses local audio file from disk without prior tracker job (#741)", async () => {
  const track = {
    artistName: "Ella Langley",
    trackName: "Choosin' Texas",
    albumName: "Hungover",
  };
  const localFilePath = path.join(downloadRoot, "Ella Langley", "Hungover", "Choosin' Texas.flac");
  await fs.mkdir(path.dirname(localFilePath), { recursive: true });
  await fs.writeFile(localFilePath, "audio");

  const result = await reuseTrackForPlaylist(track, "library", {
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.sourceType, "aurral");
  assert.equal(result.finalPath, localFilePath);
  assert.equal(downloadTracker.getJob(result.jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, localFilePath);
});

test("reuseTrackForPlaylist finds a local file named with its album position", async () => {
  const track = {
    artistName: "Numbered Artist",
    trackName: "Second Song",
    albumName: "Numbered Album",
  };
  const albumDir = path.join(downloadRoot, "Numbered Artist", "Numbered Album");
  await fs.mkdir(albumDir, { recursive: true });
  await fs.writeFile(path.join(albumDir, "01 - Other Second Song.flac"), "audio");
  const localFilePath = path.join(albumDir, "02 - Second Song.flac");
  await fs.writeFile(localFilePath, "audio");

  const result = await reuseTrackForPlaylist(track, "library", {
    downloadRoot,
  });

  assert.equal(result.reused, true);
  assert.equal(result.finalPath, localFilePath);

  const reprise = {
    artistName: "Numbered Artist",
    trackName: "Theme",
    albumName: "Repeated Album",
    trackNumber: 9,
  };
  const repeatedDir = path.join(downloadRoot, "Numbered Artist", "Repeated Album");
  await fs.mkdir(repeatedDir, { recursive: true });
  await fs.writeFile(path.join(repeatedDir, "01 - Theme.flac"), "audio");
  const options = { downloadRoot };
  assert.equal((await reuseTrackForPlaylist(reprise, "library", options)).reused, false);
  const reprisePath = path.join(repeatedDir, "09 - Theme.flac");
  await fs.writeFile(reprisePath, "audio");
  assert.equal((await reuseTrackForPlaylist(reprise, "library", options)).finalPath, reprisePath);

  const discDir = path.join(downloadRoot, "Numbered Artist", "Two Disc Album");
  const onDisc = (discNumber: number | null) => ({
    artistName: "Numbered Artist",
    trackName: "Bomb",
    albumName: "Two Disc Album",
    trackNumber: 3,
    discNumber,
  });
  await fs.mkdir(discDir, { recursive: true });
  const secondDiscPath = path.join(discDir, "2-03 - Bomb.flac");
  await fs.writeFile(secondDiscPath, "audio");
  assert.equal((await reuseTrackForPlaylist(onDisc(1), "library", options)).reused, false);
  assert.equal(
    (await reuseTrackForPlaylist(onDisc(2), "library", options)).finalPath,
    secondDiscPath,
  );
  const firstDiscPath = path.join(discDir, "03 - Bomb.flac");
  await fs.writeFile(firstDiscPath, "audio");
  assert.equal(
    (await reuseTrackForPlaylist(onDisc(null), "library", options)).finalPath,
    firstDiscPath,
  );

  const unnumbered = (discNumber: number | null) => ({
    artistName: "Numbered Artist",
    trackName: "Song",
    albumName: "Unnumbered Album",
    discNumber,
  });
  const unnumberedDir = path.join(downloadRoot, "Numbered Artist", "Unnumbered Album");
  await fs.mkdir(unnumberedDir, { recursive: true });
  await fs.writeFile(path.join(unnumberedDir, "2-03 - Song.flac"), "audio");
  for (const discNumber of [1, null]) {
    assert.equal(
      (await reuseTrackForPlaylist(unnumbered(discNumber), "library", options)).reused,
      false,
    );
  }
  const unnumberedPath = path.join(unnumberedDir, "03 - Song.flac");
  await fs.writeFile(unnumberedPath, "audio");
  assert.equal(
    (await reuseTrackForPlaylist(unnumbered(1), "library", options)).finalPath,
    unnumberedPath,
  );
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
    "_flows",
    "source-flow",
    "Amigo the Devil",
    "Everything is Fine",
    "Hell and You.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = createTrackedJob(downloadTracker, sourceTrack, "source-flow");
  assert.ok(sourceJobId != null);
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
    { downloadRoot },
  );

  assert.equal(result.reused, false);
});

test("restoreCompletedTrack requeues done jobs when the file and reuse source are missing", async () => {
  const track = {
    artistName: "Deftones",
    trackName: "Change",
    albumName: "White Pony",
  };
  const missingPath = path.join(downloadRoot, "_flows", "flow-playlist", "Change.flac");
  const jobId = createTrackedJob(downloadTracker, track, "flow-playlist");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, missingPath, track.albumName);

  const result = await restoreCompletedTrack(trackedJob(downloadTracker, jobId), {
    downloadRoot,
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
    downloadRoot,
    "_flows",
    deletedFlowId,
    "Metric",
    "Romanticize the Dive",
    "Victim of Luck.mp3",
  );
  const jobId = createTrackedJob(downloadTracker, track, "active-playlist");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, reusedPath, track.albumName);
  const scheduleScanLibrary = vi
    .spyOn(playlistManager, "scheduleScanLibrary")
    .mockImplementation(() => 1);

  const result = await repairJobsUnderRemovedPlaylistDir(deletedFlowId, {
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, null);
  assert.equal(scheduleScanLibrary.mock.calls.length, 0);
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
    "_flows",
    deletedFlowId,
    "Metric",
    "Romanticize the Dive",
    "Victim of Luck.mp3",
  );
  const jobId = createTrackedJob(downloadTracker, track, "active-playlist");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, reusedPath, track.albumName);

  const result = await repairOrphanedPlaylistTrackPaths({
    downloadRoot,
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
  const missingPath = path.join(downloadRoot, "_flows", "flow-playlist", "Glory Box.flac");
  const jobId = createTrackedJob(downloadTracker, track, "flow-playlist");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, missingPath, track.albumName);
  const scheduleScanLibrary = vi
    .spyOn(playlistManager, "scheduleScanLibrary")
    .mockImplementation(() => 1);

  const result = await repairReusableTrackLinks({
    downloadRoot,
    resolveSource: async () => ({ source: null, reason: "No source" }),
  });

  assert.equal(result.requeued, 1);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(scheduleScanLibrary.mock.calls.length, 0);
});

test("repairReusableTrackLinks scans after repairing a library track", async () => {
  const track = {
    artistName: "Portishead",
    trackName: "Glory Box",
    albumName: "Dummy",
  };
  const sourcePath = path.join(isolatedState.baseDir, "library-source.flac");
  await fs.writeFile(sourcePath, "audio");
  const missingPath = path.join(downloadRoot, "Portishead", "Dummy", "Glory Box.flac");
  const jobId = createTrackedJob(downloadTracker, track, "library");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, missingPath, track.albumName);
  const scheduleScanLibrary = vi
    .spyOn(playlistManager, "scheduleScanLibrary")
    .mockImplementation(() => 1);

  const result = await repairReusableTrackLinks({
    downloadRoot,
    resolveSource: async () => ({
      source: { sourceType: "aurral", sourcePath, albumName: track.albumName },
      reason: null,
    }),
  });

  assert.equal(result.repaired, 1);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, sourcePath);
  assert.equal(scheduleScanLibrary.mock.calls.length, 1);
});

test("reuseTrackForPlaylist path-shares flow files until refresh relocates them", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Discover Weekly", size: 10 });
  const keepers = flowPlaylistConfig.createFlow({ name: "Keepers", size: 10 });
  const track = {
    artistName: "Burial",
    trackName: "Archangel",
    albumName: "Untrue",
  };
  const sourcePath = path.join(
    downloadRoot,
    "_flows",
    flow.id,
    "Burial",
    "Untrue",
    "Archangel.flac",
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const sourceJobId = createTrackedJob(downloadTracker, track, flow.id);
  assert.ok(sourceJobId != null);
  downloadTracker.setDone(sourceJobId, sourcePath, track.albumName);

  const result = await reuseTrackForPlaylist(track, keepers.id, {
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
    "_flows",
    keepers.id,
    "Burial",
    "Untrue",
    "Archangel.flac",
  );
  assert.equal(relocated.relocated, 1);
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
  await assert.rejects(fs.access(sourcePath));
});

test("relocateSharedFilesBeforePlaylistRemoval moves a flow file the Library kept into the Library", async () => {
  const track = {
    artistName: "Four Tet",
    trackName: "Two Thousand and Seventeen",
    albumName: "New Energy",
  };
  const ownerPath = path.join(
    downloadRoot,
    "_flows",
    "owner-flow",
    "Four Tet",
    "New Energy",
    "Two Thousand and Seventeen.flac",
  );
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  await fs.writeFile(ownerPath, "audio");
  const ownerJobId = createTrackedJob(downloadTracker, track, "owner-flow");
  assert.ok(ownerJobId != null);
  downloadTracker.setDone(ownerJobId, ownerPath, track.albumName);
  const sharedJobId = createTrackedJob(downloadTracker, track, "library");
  assert.ok(sharedJobId != null);
  downloadTracker.setDone(sharedJobId, ownerPath, track.albumName);

  const result = await relocateSharedFilesBeforePlaylistRemoval("owner-flow", {
    downloadRoot,
  });

  const expectedPath = path.join(
    downloadRoot,
    "Four Tet",
    "New Energy",
    "Two Thousand and Seventeen.flac",
  );
  assert.equal(result.relocated, 1);
  assert.equal(downloadTracker.getJob(sharedJobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
  await assert.rejects(fs.access(ownerPath));
});

test("removePlaylistFileIfUnshared relocates when another flow still references the file", async () => {
  const owner = flowPlaylistConfig.createFlow({ name: "Owner", size: 10 });
  const other = flowPlaylistConfig.createFlow({ name: "Other", size: 10 });
  const track = {
    artistName: "Aphex Twin",
    trackName: "Xtal",
    albumName: "Selected Ambient Works",
  };
  const ownerPath = path.join(
    downloadRoot,
    "_flows",
    owner.id,
    "Aphex Twin",
    "Selected Ambient Works",
    "Xtal.flac",
  );
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  await fs.writeFile(ownerPath, "audio");
  const ownerJobId = createTrackedJob(downloadTracker, track, owner.id);
  assert.ok(ownerJobId != null);
  downloadTracker.setDone(ownerJobId, ownerPath, track.albumName);
  const sharedJobId = createTrackedJob(downloadTracker, track, other.id);
  assert.ok(sharedJobId != null);
  downloadTracker.setDone(sharedJobId, ownerPath, track.albumName);

  const result = await removePlaylistFileIfUnshared(ownerPath, owner.id, {
    downloadRoot,
    excludeJobIds: [ownerJobId],
  });

  const expectedPath = path.join(
    downloadRoot,
    "_flows",
    other.id,
    "Aphex Twin",
    "Selected Ambient Works",
    "Xtal.flac",
  );
  assert.equal(result.action, "relocated");
  assert.equal(downloadTracker.getJob(sharedJobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "audio");
});

test("removePlaylistFileIfUnshared preserves external files during shared cleanup", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "External", size: 10 });
  const track = {
    artistName: "Aphex Twin",
    trackName: "External Xtal",
    albumName: "Selected Ambient Works",
  };
  const externalPath = path.join(downloadRoot, "_flows", flow.id, "external-xtal.flac");
  await fs.mkdir(path.dirname(externalPath), { recursive: true });
  await fs.writeFile(externalPath, "audio");
  const jobId = createTrackedJob(downloadTracker, track, flow.id);
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, externalPath, track.albumName, "/music/External Xtal.flac");

  const result = await removePlaylistFileIfUnshared(externalPath, flow.id, {
    downloadRoot,
    excludeJobIds: [jobId],
  });

  assert.equal(result.action, "skipped");
  await fs.access(externalPath);
});

test("playlists use an indexed Library file whose folder and name Aurral did not choose", async () => {
  const filePath = path.join(downloadRoot, "Hellyeah", "Unden!Able", "01 - Hellyeah - !.mp3");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:hellyeah",
    mbid: "hellyeah",
    name: "Hellyeah",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "release-group:undeniable",
    releaseGroupMbid: "undeniable",
    artistId: artist.id,
    title: "Unden!able",
  });
  const libraryTrack = libraryStore.upsertLibraryTrack({
    identityKey: "recording:bang",
    mbid: "bang",
    title: "!",
    artistName: "Hellyeah",
  });
  libraryStore.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: libraryTrack.id,
    trackNumber: 1,
  });
  libraryStore.upsertLibraryMediaFile({
    trackId: libraryTrack.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
  });

  const result = await reuseTrackForPlaylist(
    {
      artistName: "Hellyeah",
      trackName: "!",
      albumName: "Unden!able",
      artistMbid: "hellyeah",
      albumMbid: "undeniable",
      trackMbid: "bang",
    },
    "static-playlist",
    { downloadRoot, skipHistory: true },
  );

  assert.equal(result.reused, true);
  assert.equal(result.finalPath, filePath);
  const job = trackedJob(downloadTracker, result.jobId);
  assert.equal(job.externalPath ?? null, null);
  assert.equal(job.reusedLibraryFile, true);
});
