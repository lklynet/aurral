import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { downloadTracker },
  { downloadWorker },
  { registerJobs },
] = await setupIsolatedBackend(
  "aurral-wanted-monitoring",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/routes/playlists/handlers/jobs.js",
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { role: "admin" };
  next();
});
const router = express.Router();
registerJobs(router);
app.use(router);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const managedRoot = path.join(isolatedState.baseDir, "managed");
let sequence = 0;

async function createLibraryJob({
  state = "done",
  albumMonitored = true,
  trackMonitored = albumMonitored,
  inLibrary = true,
  jobHasAlbum = true,
  fileHasAlbum = true,
} = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const albumMbid = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  const trackMbid = `dddddddd-dddd-4ddd-8ddd-${suffix}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    mbid: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    name: `Wanted Artist ${sequence}`,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Wanted Album ${sequence}`,
    metadata: { monitored: albumMonitored },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
    monitorMode: albumMonitored ? null : "unmonitored",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: `Wanted Track ${sequence}`,
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  if (!trackMonitored) db.prepare("UPDATE library_tracks SET monitored = 0 WHERE id = ?").run(track.id);

  const jobId = downloadTracker.addJob(
    {
      artistName: artist.name,
      trackName: track.title,
      albumName: album.title,
      albumMbid: jobHasAlbum ? albumMbid : null,
      trackMbid,
      managedBy: "aurral",
    },
    "library",
  );
  if (state === "failed") {
    downloadTracker.setFailed(jobId, "No matching source result");
    return jobId;
  }
  const filePath = path.join(managedRoot, artist.name, album.title, `${track.title}.mp3`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  if (inLibrary) {
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: fileHasAlbum ? album.id : null,
      source: "aurral",
      path: filePath,
    });
  }
  downloadTracker.setDone(jobId, filePath, album.title);
  downloadTracker.updateQuality(jobId, { tier: "mp3-128", format: "mp3" });
  return jobId;
}

async function request(route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const upgradedJobIds = () =>
  new Set(downloadTracker.getAll().filter((job) => job.upgradeForJobId).map((job) => job.upgradeForJobId));

const originalSettings = dbOps.getSettings();
const originalWorkerStart = downloadWorker.start;

test.before(async () => {
  await fs.mkdir(managedRoot, { recursive: true });
  downloadWorker.start = async () => {};
});

test.beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  dbOps.updateSettings({
    ...originalSettings,
    downloadFolderPath: managedRoot,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    },
  });
});

test.after(async () => {
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("Wanted reports jobs by their track's monitoring, whatever the album's", async () => {
  const monitoredMissing = await createLibraryJob({ state: "failed" });
  const missingInUnmonitoredAlbum = await createLibraryJob({ state: "failed", albumMonitored: false });
  const missingUnmonitoredTrack = await createLibraryJob({ state: "failed", trackMonitored: false });
  const monitoredFile = await createLibraryJob();
  const fileInUnmonitoredAlbum = await createLibraryJob({ albumMonitored: false });
  const unindexedUnmonitoredTrack = await createLibraryJob({ trackMonitored: false, inLibrary: false });
  const monitoredTrackInUnmonitoredAlbum = await createLibraryJob({
    state: "failed",
    albumMonitored: false,
    trackMonitored: true,
  });

  const monitoredById = new Map((await request("/jobs")).map((job) => [job.id, job.monitored]));

  assert.deepEqual(
    [
      monitoredMissing,
      missingInUnmonitoredAlbum,
      missingUnmonitoredTrack,
      monitoredFile,
      fileInUnmonitoredAlbum,
      unindexedUnmonitoredTrack,
      monitoredTrackInUnmonitoredAlbum,
    ].map((jobId) => monitoredById.get(jobId)),
    [true, false, false, true, false, false, true],
  );
});

test("Search all in Wanted skips unmonitored tracks and keeps monitored tracks of unmonitored albums", async () => {
  const monitoredMissing = await createLibraryJob({ state: "failed" });
  const missingInUnmonitoredAlbum = await createLibraryJob({ state: "failed", albumMonitored: false });
  const missingUnmonitoredTrack = await createLibraryJob({ state: "failed", trackMonitored: false });
  const monitoredFile = await createLibraryJob();
  const fileInUnmonitoredAlbum = await createLibraryJob({ albumMonitored: false });
  const fileOfUnmonitoredTrack = await createLibraryJob({ trackMonitored: false });
  const fileOutsideLibrary = await createLibraryJob({ inLibrary: false });
  const olderJobOfUnmonitoredTrack = await createLibraryJob({ trackMonitored: false, jobHasAlbum: false });
  const olderFileInUnmonitoredAlbum = await createLibraryJob({
    albumMonitored: false,
    jobHasAlbum: false,
    fileHasAlbum: false,
  });
  const fileOfMonitoredTrackInUnmonitoredAlbum = await createLibraryJob({
    albumMonitored: false,
    trackMonitored: true,
  });

  const missing = await request("/research-missing", { method: "POST" });
  const upgrades = await request("/quality-upgrades", { method: "POST" });

  assert.equal(missing.requeued, 1);
  assert.deepEqual(
    [monitoredMissing, missingInUnmonitoredAlbum, missingUnmonitoredTrack]
      .map((jobId) => downloadTracker.getJob(jobId).status),
    ["pending", "failed", "failed"],
  );
  const upgraded = upgradedJobIds();
  assert.equal(upgrades.queued, 3);
  assert.deepEqual(
    [
      monitoredFile,
      fileInUnmonitoredAlbum,
      fileOfUnmonitoredTrack,
      fileOutsideLibrary,
      olderJobOfUnmonitoredTrack,
      olderFileInUnmonitoredAlbum,
      fileOfMonitoredTrackInUnmonitoredAlbum,
    ].map((jobId) => upgraded.has(jobId)),
    [true, false, false, true, false, false, true],
  );
});
