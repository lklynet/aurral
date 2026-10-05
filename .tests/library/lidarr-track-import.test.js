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
  { findFinishedTrackJob, importTrackToLidarr, importWhenDownloaded },
  libraryStore,
  managementStore,
  { dbOps },
  { downloadWorker },
  { registerDownloads },
  { flowPlaylistConfig },
  { reuseTrackForPlaylist },
  { logger },
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
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/routes/library/handlers/downloads.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/fileReuse.js",
  "backend/services/logger.js",
);

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
registerDownloads({ get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") });

async function addTrackToLibrary(body, user = { role: "admin", permissions: {} }) {
  const response = { statusCode: 200, body: null };
  await routes.get("POST /downloads/track")(
    { params: {}, body, query: {}, user },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
    },
  );
  return response;
}

const useTestPathMappings = () =>
  syncPathMappings([
    { source: "lidarr", remote: "/data/aurral", local: downloadRoot },
    { source: "lidarr", remote: "/music", local: lidarrRoot },
  ]);

// Reading settings re-syncs path mappings from the database, so save the test mappings too.
function setImportOnAdd(enabled) {
  dbOps.updateSettings({
    integrations: { lidarr: { importOnAddToLibrary: enabled } },
    pathMappings: [
      { source: "lidarr", remote: "/data/aurral", local: downloadRoot },
      { source: "lidarr", remote: "/music", local: lidarrRoot },
    ],
  });
}

const artistMbid = "a1111111-1111-4111-8111-111111111111";
const albumMbid = "a2222222-2222-4222-8222-222222222222";
const trackMbid = "a3333333-3333-4333-8333-333333333333";
const downloadRoot = path.join(isolatedState.baseDir, "aurral-downloads");
const lidarrRoot = path.join(isolatedState.baseDir, "lidarr-music");
const originalClient = { ...lidarrClient };
const fastOptions = { downloadRoot, pollIntervalMs: 0, timeoutMs: 1000, lidarrWaitTimeoutMs: 50 };

function createFakeLidarr({
  albumExists = true,
  candidate = {},
  reidentify = null,
  commandStatus = "completed",
  immediate = false,
  pendingPolls = 0,
  extraCandidates = [],
} = {}) {
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

  const finishedCommand = () => ({
    id: 55,
    status: commandStatus,
    message: commandStatus === "failed" ? "Permission denied" : "",
  });
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
        ...extraCandidates,
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
    if (endpoint === "/command" && method === "POST" && body.name === "RefreshArtist") {
      return { id: 56, status: "queued" };
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
      return immediate ? finishedCommand() : { id: 55, status: "started" };
    }
    if (endpoint === "/command/55") {
      state.commandPolls = (state.commandPolls || 0) + 1;
      return state.commandPolls > pendingPolls ? finishedCommand() : { id: 55, status: "started" };
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
  downloadTracker.setDone(jobId, filePath, albumName);
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
  useTestPathMappings();
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  t.mock.method(downloadWorker, "start", async () => null);
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

  const [precheck, scan] = state.calls.requests
    .filter((call) => call.endpoint.startsWith("/manualimport?"))
    .map((call) => new URLSearchParams(call.endpoint.split("?")[1]));
  for (const query of [precheck, scan]) {
    assert.equal(query.get("folder"), "/data/aurral/_flows/flow-weekly/Import Artist/Import Album");
    assert.equal(query.get("filterExistingFiles"), "false");
  }
  assert.equal(precheck.has("artistId"), false);
  assert.equal(scan.get("artistId"), "7");

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
  const scheduledScan = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key = 'pendingLibraryScanJob'").get().value,
  );
  assert.equal(scheduledScan.includeLidarr, true);
  assert.ok(scheduledScan.changedPaths.includes(path.resolve(filePath)));
  assert.ok(scheduledScan.changedPaths.includes(path.resolve(lidarrFile)));
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

test("a file Lidarr cannot see is reported before anything is added to Lidarr", async () => {
  const state = createFakeLidarr({ albumExists: false });
  const artist = await lidarrClient.getArtistByMbid();
  lidarrClient.getArtistByMbid = async () => (state.calls.addArtist.length ? artist : null);
  const { jobId } = await seedFlowJob(state);
  state.remotePath = "/somewhere/else.flac";

  await assert.rejects(importTrackToLidarr({ jobId }, fastOptions), (error) => {
    assert.equal(error.statusCode, 422);
    assert.match(error.message, /\/data\/aurral\/_flows\/flow-weekly\/Import Artist\/Import Album\/Second Song\.flac/);
    return true;
  });
  assert.equal(state.calls.addArtist.length, 0);
  assert.equal(state.calls.addAlbum.length, 0);
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

const addBody = { artistName: "Import Artist", trackName: "Second Song", albumName: "Import Album", trackMbid };
const ownerUserId = 1;
let flowCount = 0;

async function seedOwnedFlowJob(state) {
  flowCount += 1;
  const flow = flowPlaylistConfig.createFlow({ name: `Import Flow ${flowCount}`, ownerUserId });
  return seedFlowJob(state, { playlistType: flow.id });
}

test("Add to library leaves a finished track alone while importing on add is off", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedOwnedFlowJob(state);
  setImportOnAdd(false);

  const response = await addTrackToLibrary(addBody);

  assert.equal(response.body.importedToLidarr, undefined);
  assert.equal(state.calls.requests.some((call) => call.endpoint === "/command"), false);
  assert.equal(downloadTracker.getJob(jobId).externalPath, null);
  assert.equal(response.body.reused, true);
});

test("Add to library imports a finished flow track into Lidarr when importing on add is on", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedOwnedFlowJob(state);
  setImportOnAdd(true);

  const response = await addTrackToLibrary(addBody);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.importedToLidarr, true);
  assert.equal(response.body.jobId, jobId);
  assert.equal(response.body.lidarrAlbumId, 70);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.equal(command.body.importMode, "move");
  assert.equal(downloadTracker.getJob(jobId).externalPath, response.body.trackFile);
  assert.equal(downloadTracker.getByPlaylistType("library").length, 0);
});

test("Add to library queues a download for Lidarr when importing on add is on but no file exists", async () => {
  const state = createFakeLidarr({ immediate: true });
  setImportOnAdd(true);

  const response = await addTrackToLibrary(addBody);

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.queued, true);
  assert.equal(response.body.willImportToLidarr, true);
  assert.equal(state.calls.requests.length, 0);
  assert.equal(downloadTracker.getJob(response.body.jobId).playlistType, "library");
});

// Simulates the download pipeline finishing a library job.
async function completeLibraryDownload(state, jobId) {
  const filePath = path.join(downloadRoot, "Import Artist", "Import Album", "Second Song.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  state.sourcePath = filePath;
  state.remotePath = "/data/aurral/Import Artist/Import Album/Second Song.flac";
  const { recordPipelineJobSuccess } = await importFromRepo("backend/services/pipelineHelpers.js");
  await recordPipelineJobSuccess({
    downloadTracker,
    job: downloadTracker.getJob(jobId),
    committedFinalPath: filePath,
    album: "Import Album",
  });
  return filePath;
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

test("a track queued by Add to library is imported into Lidarr once it is downloaded", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  setImportOnAdd(true);
  const { body } = await addTrackToLibrary({ ...addBody, artistMbid, albumMbid });

  await completeLibraryDownload(state, body.jobId);

  assert.equal(await waitFor(() => Boolean(downloadTracker.getJob(body.jobId).externalPath)), true);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.equal(command.body.importMode, "move");
});

test("a finished library download is left alone when importing on add is off", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const jobId = downloadTracker.addJob({ ...addBody, artistMbid, albumMbid }, "library");

  const filePath = await completeLibraryDownload(state, jobId);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.calls.requests.length, 0);
  assert.equal(downloadTracker.getJob(jobId).finalPath, filePath);
});

test("a failed import after download keeps the file in the Downloads Folder", async () => {
  const state = createFakeLidarr({
    immediate: true,
    commandStatus: "failed",
    candidate: { album: { id: 70 }, tracks: [{ id: 802 }] },
  });
  setImportOnAdd(true);
  const { body } = await addTrackToLibrary({ ...addBody, artistMbid, albumMbid });

  const filePath = await completeLibraryDownload(state, body.jobId);

  assert.equal(await waitFor(() => state.calls.requests.some((call) => call.endpoint === "/command")), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await fs.readFile(filePath, "utf8"), "audio");
  assert.equal(downloadTracker.getJob(body.jobId).finalPath, filePath);
  assert.equal(downloadTracker.getJob(body.jobId).externalPath, null);
});

test("Add to library reports a failed Lidarr import instead of moving the file", async () => {
  const state = createFakeLidarr({
    immediate: true,
    commandStatus: "failed",
    candidate: { album: { id: 70 }, tracks: [{ id: 802 }] },
  });
  const { jobId, filePath } = await seedOwnedFlowJob(state);
  setImportOnAdd(true);

  const response = await addTrackToLibrary(addBody);

  assert.equal(response.statusCode, 502);
  assert.match(response.body.error, /Permission denied/);
  assert.equal(await fs.readFile(filePath, "utf8"), "audio");
  assert.equal(downloadTracker.getJob(jobId).finalPath, filePath);
  assert.equal(downloadTracker.getByPlaylistType("library").length, 0);
});

test("Add to library only imports finished tracks the user can access", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedOwnedFlowJob(state);
  setImportOnAdd(true);

  const response = await addTrackToLibrary(addBody, { id: ownerUserId + 1, role: "user", permissions: {} });

  // The other user's flow job is never imported directly; Add to library goes through its own library job.
  assert.equal(response.body.importedToLidarr, undefined);
  assert.notEqual(response.body.jobId, jobId);
  assert.equal(downloadTracker.getJob(response.body.jobId).playlistType, "library");
});

const refreshCommands = (state) =>
  state.calls.requests.filter((call) => call.endpoint === "/command" && call.body?.name === "RefreshArtist");

test("the import waits for Lidarr to load a new artist's tracks and nudges a stalled refresh once", async () => {
  const state = createFakeLidarr({ candidate: { album: null, tracks: [] } });
  const loaded = [...state.tracks];
  state.tracks.length = 0;
  const getTracks = lidarrClient.getTracksByAlbumId;
  let polls = 0;
  lidarrClient.getTracksByAlbumId = async (id) => {
    polls += 1;
    if (refreshCommands(state).length > 0 && polls > 3 && state.tracks.length === 0) state.tracks.push(...loaded);
    return getTracks(id);
  };
  const { jobId } = await seedFlowJob(state);

  await importTrackToLidarr({ jobId }, { ...fastOptions, pollIntervalMs: 5, lidarrWaitTimeoutMs: 1000 });

  assert.equal(refreshCommands(state).length, 1);
  assert.deepEqual(refreshCommands(state)[0].body, { name: "RefreshArtist", artistId: 7, artistIds: [7] });
  const command = state.calls.requests.find((call) => call.endpoint === "/command" && call.body?.name === "ManualImport");
  assert.deepEqual(command.body.files[0].trackIds, [802]);
});

test("an album whose tracks never load is named in the error", async () => {
  const state = createFakeLidarr({
    candidate: { album: null, tracks: [], rejections: [{ reason: "Couldn't find similar album" }] },
  });
  state.album.releaseDate = "2021-05-07T00:00:00Z";
  state.tracks.length = 0;
  const { jobId } = await seedFlowJob(state);

  await assert.rejects(
    importTrackToLidarr({ jobId }, { ...fastOptions, pollIntervalMs: 1, lidarrWaitTimeoutMs: 40 }),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.message, 'No matching track in Lidarr album "Import Album" (2021)');
      assert.deepEqual(error.rejections, ["Couldn't find similar album"]);
      return true;
    },
  );
  assert.equal(refreshCommands(state).length, 1);
  assert.equal(state.calls.requests.some((call) => call.body?.name === "ManualImport"), false);
});

test("an import Lidarr finishes after the request timeout is followed in the background", async () => {
  const state = createFakeLidarr({ pendingPolls: 3, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedFlowJob(state);
  const options = { ...fastOptions, pollIntervalMs: 5, timeoutMs: 0, backgroundTimeoutMs: 1000 };

  const error = await importTrackToLidarr({ jobId }, options).catch((caught) => caught);
  assert.equal(error.statusCode, 202);
  assert.equal(error.stillImporting, true);
  assert.match(error.message, /Lidarr is still importing Second Song/);
  assert.equal(await importTrackToLidarr({ jobId }, options).catch((caught) => caught), error);
  assert.equal(downloadTracker.getJob(jobId).externalPath, null);

  await error.background;

  assert.equal(downloadTracker.getJob(jobId).externalPath, "/music/Import Artist/Import Album/02 - Second Song.flac");
  await assert.rejects(importTrackToLidarr({ jobId }, options), /already in Lidarr/);
});

test("without a recording MBID only finished tracks from the same album match", async () => {
  const state = createFakeLidarr();
  const { jobId } = await seedFlowJob(state, { mbid: null });
  const track = { artistName: "Import Artist", trackName: "Second Song" };
  const find = async (extra) => (await findFinishedTrackJob({ ...track, ...extra }, { downloadRoot }))?.id ?? null;

  assert.equal(await find({}), jobId);
  assert.equal(await find({ albumName: "import album" }), jobId);
  assert.equal(await find({ albumName: "Other Album" }), null);
  assert.equal(await find({ albumMbid: "a9999999-9999-4999-8999-999999999999", albumName: "Import Album" }), null);
});

test("an exact Lidarr path wins over a case-only duplicate, and two case-only matches are ambiguous", async () => {
  const state = createFakeLidarr({
    candidate: { album: { id: 70 }, tracks: [{ id: 802 }] },
    extraCandidates: [{ id: 3, path: "/data/aurral/_flows/flow-weekly/IMPORT ARTIST/Import Album/Second Song.flac" }],
  });
  const { jobId } = await seedFlowJob(state);
  await importTrackToLidarr({ jobId }, fastOptions);
  const command = state.calls.requests.find((call) => call.endpoint === "/command");
  assert.equal(command.body.files[0].path, state.remotePath);

  downloadTracker.clearAll();
  const ambiguous = createFakeLidarr({
    extraCandidates: [{ id: 3, path: "/data/aurral/_flows/flow-weekly/IMPORT ARTIST/Import Album/Second Song.flac" }],
  });
  const second = await seedFlowJob(ambiguous);
  ambiguous.remotePath = "/data/aurral/_flows/flow-weekly/import artist/Import Album/Second Song.flac";
  await assert.rejects(importTrackToLidarr({ jobId: second.jobId }, fastOptions), /Lidarr can't see the file/);
});

test("a library job finished by reuse is imported when Add to library marked it", async () => {
  const state = createFakeLidarr({ immediate: true, candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  await seedFlowJob(state);
  setImportOnAdd(true);
  const track = { artistName: "Import Artist", trackName: "Second Song", albumName: "Import Album", artistMbid, albumMbid, trackMbid };
  const libraryJobId = downloadTracker.addJob(track, "library");
  importWhenDownloaded(libraryJobId);
  state.sourcePath = path.join(downloadRoot, "Import Artist", "Import Album", "Second Song.flac");
  state.remotePath = "/data/aurral/Import Artist/Import Album/Second Song.flac";

  const reuse = await reuseTrackForPlaylist(track, "library", {
    existingFileMode: "reuse",
    downloadRoot,
    existingJobId: libraryJobId,
    targetPlaylistType: "library",
    skipHistory: true,
  });

  assert.equal(reuse.reused, true);
  const job = await waitFor(() => downloadTracker.getJob(libraryJobId).externalPath && downloadTracker.getJob(libraryJobId));
  assert.equal(job.externalPath, "/music/Import Artist/Import Album/02 - Second Song.flac");
});

test("jobs follow an imported file Aurral can't read, with a warning about the path mapping", async (t) => {
  const state = createFakeLidarr({ candidate: { album: { id: 70 }, tracks: [{ id: 802 }] } });
  const { jobId } = await seedFlowJob(state);
  syncPathMappings([{ source: "lidarr", remote: "/data/aurral", local: downloadRoot }]);
  const warn = t.mock.method(logger, "warn");

  const result = await importTrackToLidarr({ jobId }, fastOptions);

  assert.equal(result.localPathReadable, false);
  assert.equal(downloadTracker.getJob(jobId).finalPath, path.resolve("/music/Import Artist/Import Album/02 - Second Song.flac"));
  const warning = warn.mock.calls.find((call) => /path mapping/.test(call.arguments[1]));
  assert.deepEqual(warning.arguments[2], {
    remotePath: "/music/Import Artist/Import Album/02 - Second Song.flac",
    localPath: path.resolve("/music/Import Artist/Import Album/02 - Second Song.flac"),
  });
});
