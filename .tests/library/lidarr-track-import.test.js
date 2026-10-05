import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { lidarrClient },
  { playlistManager },
  { syncPathMappings },
  { importTrackToLidarr },
  libraryStore,
  managementStore,
] = await setupIsolatedBackend(
  "lidarr-track-import",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/lidarrClient.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/pathMappings.js",
  "backend/services/lidarrTrackImport.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
);

const artistMbid = "a1111111-1111-4111-8111-111111111111";
const albumMbid = "a2222222-2222-4222-8222-222222222222";
const trackMbid = "a3333333-3333-4333-8333-333333333333";
const downloadRoot = path.join(isolatedState.baseDir, "aurral-downloads");
const lidarrRoot = path.join(isolatedState.baseDir, "lidarr-music");
const originalClient = { ...lidarrClient };
const fastOptions = { downloadRoot, pollIntervalMs: 0, timeoutMs: 1000 };

function createFakeLidarr({ albumExists = true, candidate = {}, reidentify = null, commandStatus = "completed" } = {}) {
  const calls = { requests: [], addArtist: [], addAlbum: [] };
  const artist = { id: 7, artistName: "Import Artist", foreignArtistId: artistMbid };
  const album = {
    id: 70,
    artistId: 7,
    title: "Import Album",
    foreignAlbumId: albumMbid,
    monitored: false,
    releases: [{ id: 700, monitored: false }, { id: 701, monitored: true }],
  };
  const tracks = [
    { id: 801, title: "Opening", foreignRecordingId: "a4444444-4444-4444-8444-444444444444", trackFileId: 0 },
    { id: 802, title: "Second Song", foreignRecordingId: trackMbid, trackFileId: 0 },
  ];
  const trackFiles = [];
  let albumAdded = albumExists;
  const state = { album, tracks, trackFiles, calls, sourcePath: null };

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtistByMbid = async () => artist;
  lidarrClient.addArtist = async (...args) => {
    calls.addArtist.push(args);
    return artist;
  };
  lidarrClient.getAlbumByMbid = async () => (albumAdded ? album : undefined);
  const single = { id: 71, artistId: 7, title: "Second Song", albumType: "Single", releaseDate: "2019-01-01" };
  state.artistAlbums = [single, { ...album, albumType: "Album", releaseDate: "2020-01-01" }];
  lidarrClient.getAllAlbums = async () => state.artistAlbums;
  lidarrClient.getAlbum = async (id) => (id === single.id ? single : album);
  lidarrClient.addAlbum = async (...args) => {
    calls.addAlbum.push(args);
    albumAdded = true;
    return album;
  };
  lidarrClient.getTracksByAlbumId = async (id) =>
    id === single.id ? [{ id: 811, title: "Second Song", foreignRecordingId: trackMbid }] : tracks;
  lidarrClient.getTrackFilesByAlbumId = async () => trackFiles;
  lidarrClient.request = async (endpoint, method = "GET", body = null) => {
    calls.requests.push({ endpoint, method, body });
    if (endpoint.startsWith("/manualimport?")) {
      return [
        { id: 1, path: "/data/aurral/Other/Other.flac", quality: { quality: { id: 6 } } },
        {
          id: 2,
          path: state.remotePath,
          name: "Second Song",
          quality: { quality: { id: 6, name: "FLAC" }, revision: { version: 1 } },
          releaseGroup: "",
          indexerFlags: 0,
          rejections: [],
          ...candidate,
        },
      ];
    }
    if (endpoint === "/manualimport" && method === "POST") {
      return reidentify ? reidentify(body) : [{ ...body[0], tracks: [] }];
    }
    if (endpoint === "/command" && method === "POST") {
      if (commandStatus === "completed") {
        const file = body.files[0];
        const target = path.join(lidarrRoot, "Import Artist", "Import Album", "02 - Second Song.flac");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(state.sourcePath, target);
        trackFiles.push({ id: 900, path: "/music/Import Artist/Import Album/02 - Second Song.flac" });
        for (const track of tracks) {
          if (file.trackIds.includes(track.id)) track.trackFileId = 900;
        }
      }
      return { id: 55, status: "started" };
    }
    if (endpoint === "/command/55") {
      return { id: 55, status: commandStatus, message: commandStatus === "failed" ? "Permission denied" : "" };
    }
    throw new Error(`Unexpected Lidarr request ${method} ${endpoint}`);
  };
  return state;
}

async function seedFlowJob(state, {
  playlistType = "flow-weekly",
  trackName = "Second Song",
  mbid = trackMbid,
  albumName = "Import Album",
  albumMbidValue = albumMbid,
} = {}) {
  const filePath = path.join(downloadRoot, "_flows", playlistType, "Import Artist", "Import Album", "Second Song.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  const jobId = downloadTracker.addJob({
    artistName: "Import Artist",
    trackName,
    albumName,
    artistMbid,
    albumMbid: albumMbidValue,
    trackMbid: mbid,
    durationMs: 200000,
  }, playlistType);
  downloadTracker.setDone(jobId, filePath, "Import Album");
  state.sourcePath = filePath;
  state.remotePath = `/data/aurral/_flows/${playlistType}/Import Artist/Import Album/Second Song.flac`;
  return { jobId, filePath };
}

test.beforeEach(async (t) => {
  await resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  managementStore.invalidateLibraryManagementCache();
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
  await fs.rm(lidarrRoot, { recursive: true, force: true });
  syncPathMappings([
    { source: "lidarr", remote: "/data/aurral", local: downloadRoot },
    { source: "lidarr", remote: "/music", local: lidarrRoot },
  ]);
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);
});

test.after(async () => {
  Object.assign(lidarrClient, originalClient);
  syncPathMappings([]);
  const { downloadWorker } = await importFromRepo("backend/services/downloadJobs/downloadWorker.js");
  await downloadWorker.stopAndDrain();
  await cleanupIsolatedState(isolatedState);
});

test("a flow track Lidarr already matched is moved into Lidarr and the flow follows the file", async () => {
  const state = createFakeLidarr({
    candidate: { album: { id: 70 }, albumReleaseId: 701, tracks: [{ id: 802 }] },
  });
  const { jobId, filePath } = await seedFlowJob(state);
  const otherJobId = downloadTracker.addJob({ artistName: "Import Artist", trackName: "Second Song" }, "flow-other");
  downloadTracker.setDone(otherJobId, filePath, "Import Album");

  const result = await importTrackToLidarr({ jobId }, fastOptions);

  const scan = state.calls.requests.find((call) => call.endpoint.startsWith("/manualimport?"));
  const query = new URLSearchParams(scan.endpoint.split("?")[1]);
  assert.equal(query.get("folder"), "/data/aurral/_flows/flow-weekly/Import Artist/Import Album");
  assert.equal(query.get("artistId"), "7");
  assert.equal(query.get("filterExistingFiles"), "false");

  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.deepEqual(command.body, {
    name: "ManualImport",
    files: [{
      path: state.remotePath,
      artistId: 7,
      albumId: 70,
      albumReleaseId: 701,
      trackIds: [802],
      quality: { quality: { id: 6, name: "FLAC" }, revision: { version: 1 } },
      releaseGroup: "",
      indexerFlags: 0,
      downloadId: undefined,
      disableReleaseSwitching: true,
    }],
    importMode: "move",
    replaceExistingFiles: false,
  });
  assert.equal(state.calls.requests.some((call) => call.endpoint === "/manualimport"), false);
  assert.equal(state.calls.addAlbum.length, 0);

  const lidarrFile = path.join(lidarrRoot, "Import Artist", "Import Album", "02 - Second Song.flac");
  assert.equal(result.success, true);
  assert.equal(result.lidarrAlbumId, 70);
  assert.equal(result.trackFile, "/music/Import Artist/Import Album/02 - Second Song.flac");
  assert.equal(result.jobsUpdated, 2);
  for (const id of [jobId, otherJobId]) {
    const job = downloadTracker.getJob(id);
    assert.equal(path.resolve(job.finalPath), path.resolve(lidarrFile));
    assert.equal(job.externalPath, result.trackFile);
  }
  const refreshed = playlistManager.refreshPlaylist.mock.calls.map((call) => call.arguments[0]).sort();
  assert.deepEqual(refreshed, ["flow-other", "flow-weekly"]);
  await assert.rejects(importTrackToLidarr({ jobId }, fastOptions), /already in Lidarr/);
});

test("a candidate without tracks is re-identified against the album before importing", async () => {
  const state = createFakeLidarr({
    candidate: { album: null, tracks: [], rejections: [{ reason: "Couldn't find similar album" }] },
    reidentify: (items) => [{ ...items[0], albumReleaseId: 701, tracks: [{ id: 802 }] }],
  });
  const { jobId } = await seedFlowJob(state);

  await importTrackToLidarr({ jobId }, fastOptions);

  const reidentify = state.calls.requests.find((call) => call.endpoint === "/manualimport");
  assert.equal(reidentify.method, "POST");
  assert.equal(reidentify.body[0].albumId, 70);
  assert.equal(reidentify.body[0].albumReleaseId, 701);
  assert.equal(reidentify.body[0].artistId, 7);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.deepEqual(command.body.files[0].trackIds, [802]);
});

test("Lidarr album tracks are matched by recording MBID and then by title", async () => {
  const state = createFakeLidarr({ candidate: { album: null, tracks: [] } });
  const { jobId } = await seedFlowJob(state);
  await importTrackToLidarr({ jobId }, fastOptions);
  let command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.deepEqual(command.body.files[0].trackIds, [802]);
  assert.equal(command.body.files[0].albumReleaseId, 701);

  downloadTracker.clearAll();
  await fs.rm(lidarrRoot, { recursive: true, force: true });
  const byTitle = createFakeLidarr({ candidate: { album: null, tracks: [] } });
  const titled = await seedFlowJob(byTitle, { trackName: "Second Song (Remastered)", mbid: null });
  await importTrackToLidarr({ jobId: titled.jobId }, fastOptions);
  command = byTitle.calls.requests.find((call) => call.endpoint === "/command");
  assert.deepEqual(command.body.files[0].trackIds, [802]);
});

test("a missing Lidarr album is added unmonitored without a search", async () => {
  const state = createFakeLidarr({
    albumExists: false,
    candidate: { album: { id: 70 }, albumReleaseId: 701, tracks: [{ id: 802 }] },
  });
  const { jobId } = await seedFlowJob(state);

  await importTrackToLidarr({ jobId }, fastOptions);

  assert.deepEqual(state.calls.addAlbum, [[7, albumMbid, "Import Album", { monitored: false, triggerSearch: false }]]);
  assert.equal(state.calls.requests.some((call) => call.body?.name === "AlbumSearch"), false);
});

test("a missing Lidarr artist is added without monitoring or searching", async () => {
  const state = createFakeLidarr({ candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const artist = await lidarrClient.getArtistByMbid();
  lidarrClient.getArtistByMbid = async () => (state.calls.addArtist.length ? artist : null);
  const { jobId } = await seedFlowJob(state);

  await importTrackToLidarr({ jobId }, fastOptions);

  assert.deepEqual(state.calls.addArtist, [[
    artistMbid,
    "Import Artist",
    { albumOnly: true, monitorOption: "none", triggerSearch: false },
  ]]);
});

test("importing needs Lidarr", async () => {
  createFakeLidarr();
  lidarrClient.isConfigured = () => false;
  await assert.rejects(importTrackToLidarr({ jobId: "anything" }, fastOptions), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /Lidarr is not configured/);
    return true;
  });
});

test("a failed Lidarr import leaves the Aurral file and jobs alone", async () => {
  const state = createFakeLidarr({
    commandStatus: "failed",
    candidate: { album: { id: 70 }, tracks: [{ id: 802 }] },
  });
  const { jobId, filePath } = await seedFlowJob(state);

  await assert.rejects(importTrackToLidarr({ jobId }, fastOptions), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /Permission denied/);
    return true;
  });

  assert.equal(await fs.readFile(filePath, "utf8"), "audio");
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.finalPath, filePath);
  assert.equal(job.externalPath, null);
  assert.equal(playlistManager.refreshPlaylist.mock.callCount(), 0);
});

test("a file Lidarr cannot see reports the path it looked for", async () => {
  const state = createFakeLidarr();
  const { jobId } = await seedFlowJob(state);
  state.remotePath = "/somewhere/else.flac";

  await assert.rejects(importTrackToLidarr({ jobId }, fastOptions), (error) => {
    assert.equal(error.statusCode, 422);
    assert.match(error.message, /\/data\/aurral\/_flows\/flow-weekly\/Import Artist\/Import Album\/Second Song\.flac/);
    return true;
  });
});

test("double submits for the same track share one import", async () => {
  const state = createFakeLidarr({ candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedFlowJob(state);

  const [first, second] = await Promise.all([
    importTrackToLidarr({ jobId }, fastOptions),
    importTrackToLidarr({ jobId }, fastOptions),
  ]);

  assert.equal(first, second);
  assert.equal(state.calls.requests.filter((call) => call.endpoint === "/command").length, 1);
});

test("importing a track from an Aurral album hands the album to Lidarr", async () => {
  const state = createFakeLidarr({ candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Import Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: "Import Album",
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const { jobId, filePath } = await seedFlowJob(state, { playlistType: "library" });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: "Second Song",
    artistName: "Import Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 2 });
  libraryStore.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: filePath });

  await importTrackToLidarr({ jobId }, fastOptions);

  assert.equal(managementStore.getManagedBy("album", album.id), "lidarr");
  assert.equal(downloadTracker.getJob(jobId).externalPath, "/music/Import Artist/Import Album/02 - Second Song.flac");
});

test("without an album MBID the Lidarr album is found by title", async () => {
  const state = createFakeLidarr({ candidate: { album: null, tracks: [] } });
  const { jobId } = await seedFlowJob(state, { albumMbidValue: null });

  const result = await importTrackToLidarr({ jobId }, fastOptions);

  assert.equal(result.lidarrAlbumId, 70);
  assert.equal(state.calls.addAlbum.length, 0);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.equal(command.body.files[0].albumId, 70);
  assert.deepEqual(command.body.files[0].trackIds, [802]);
});

test("without an album name the Lidarr album containing the track is preferred over a single", async () => {
  const state = createFakeLidarr({ candidate: { album: null, tracks: [] } });
  const { jobId } = await seedFlowJob(state, { albumMbidValue: null, albumName: null });

  const result = await importTrackToLidarr({ jobId }, fastOptions);

  assert.equal(result.lidarrAlbumId, 70);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.equal(command.body.files[0].albumId, 70);
  assert.deepEqual(command.body.files[0].trackIds, [802]);

  downloadTracker.clearAll();
  const none = createFakeLidarr();
  none.artistAlbums = [none.artistAlbums[1]];
  lidarrClient.getTracksByAlbumId = async () => [];
  const missing = await seedFlowJob(none, { albumMbidValue: null, albumName: null });
  await assert.rejects(importTrackToLidarr({ jobId: missing.jobId }, fastOptions), (error) => {
    assert.equal(error.statusCode, 422);
    return true;
  });
});
