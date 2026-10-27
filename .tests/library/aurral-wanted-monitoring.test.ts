import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { downloadTracker },
  { downloadWorker },
  { registerJobs },
  { handToHono },
  { getMetadataBaseUrl },
  { setMetadataProviderCooldown },
] = await setupIsolatedBackend(
  "aurral-wanted-monitoring",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/routes/playlists/handlers/jobs.ts"),
  () => import("../../backend/routes/shared/expressHandoff.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/services/metadataProviderBudget.ts"),
);
// Unit tests are offline, so the default metadata provider refuses lookups up front
// instead of making each one wait its turn in the provider's rate limit.
setMetadataProviderCooldown(getMetadataBaseUrl(), 403, Number.MAX_SAFE_INTEGER);

const app = express();
app.use((req, _res, next) => {
  req.user = { id: 1, username: "test", role: "admin", permissions: {} };
  next();
});
app.use("/api/library", handToHono);
app.use(express.json());
const router = express.Router();
registerJobs(router);
app.use(router);
const server = await new Promise<import("node:http").Server>((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

const managedRoot = path.join(isolatedState.baseDir, "managed");
let sequence = 0;

async function createLibraryJob({
  state = "done",
  albumMonitored = true,
  trackMonitored = albumMonitored,
  inLibrary = true,
  jobHasAlbum = true,
  fileHasAlbum = true,
}: {
  state?: string;
  albumMonitored?: boolean;
  trackMonitored?: boolean;
  inLibrary?: boolean;
  jobHasAlbum?: boolean;
  fileHasAlbum?: boolean;
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
  if (!trackMonitored)
    db.prepare("UPDATE library_tracks SET monitored = 0 WHERE id = ?").run(track.id);

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
  assert.ok(jobId != null);
  if (state === "failed") {
    downloadTracker.setFailed(jobId, "No matching source result");
    return jobId;
  }
  const filePath = path.join(managedRoot, artist.name, album.title, `${track.title}.mp3`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  if (inLibrary) {
    libraryStore.upsertLibraryMediaFile({
      scanId: undefined,
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

async function request<Body = never>(route: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body: Body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const keepFile = (jobId: string | null) => {
  const { id } = db
    .prepare<unknown[], { id: import("../../backend/db/rows.ts").LibraryTracksRow["id"] }>(
      "SELECT id FROM library_tracks WHERE mbid = ?",
    )
    .get(getJob(jobId).trackMbid)!;
  return request<{ keepFile: boolean; cancelledJobIds: string[] }>(
    `/api/library/tracks/aurral/${id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepFile: true }),
    },
  );
};

const upgradeJobsOf = (jobId: string | null) =>
  downloadTracker.getAll().filter((job) => job.upgradeForJobId === jobId);

const upgradedJobIds = () =>
  new Set(
    downloadTracker
      .getAll()
      .filter((job) => job.upgradeForJobId)
      .map((job) => job.upgradeForJobId),
  );

const originalSettings = dbOps.getSettings();
const originalWorkerStart = downloadWorker.start;

beforeAll(async () => {
  await fs.mkdir(managedRoot, { recursive: true });
  downloadWorker.start = async () => {};
});

beforeEach(() => {
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

afterAll(async () => {
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

test("Wanted reports jobs by their track's monitoring, whatever the album's", async () => {
  const monitoredMissing = await createLibraryJob({ state: "failed" });
  const missingInUnmonitoredAlbum = await createLibraryJob({
    state: "failed",
    albumMonitored: false,
  });
  const missingUnmonitoredTrack = await createLibraryJob({
    state: "failed",
    trackMonitored: false,
  });
  const monitoredFile = await createLibraryJob();
  const fileInUnmonitoredAlbum = await createLibraryJob({ albumMonitored: false });
  const unindexedUnmonitoredTrack = await createLibraryJob({
    trackMonitored: false,
    inLibrary: false,
  });
  const monitoredTrackInUnmonitoredAlbum = await createLibraryJob({
    state: "failed",
    albumMonitored: false,
    trackMonitored: true,
  });

  const monitoredById = new Map(
    (await request<{ id: string; monitored: boolean }[]>("/jobs")).map((job) => [
      job.id,
      job.monitored,
    ]),
  );

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
  const missingInUnmonitoredAlbum = await createLibraryJob({
    state: "failed",
    albumMonitored: false,
  });
  const missingUnmonitoredTrack = await createLibraryJob({
    state: "failed",
    trackMonitored: false,
  });
  const monitoredFile = await createLibraryJob();
  const fileInUnmonitoredAlbum = await createLibraryJob({ albumMonitored: false });
  const fileOfUnmonitoredTrack = await createLibraryJob({ trackMonitored: false });
  const fileOutsideLibrary = await createLibraryJob({ inLibrary: false });
  const olderJobOfUnmonitoredTrack = await createLibraryJob({
    trackMonitored: false,
    jobHasAlbum: false,
  });
  const olderFileInUnmonitoredAlbum = await createLibraryJob({
    albumMonitored: false,
    jobHasAlbum: false,
    fileHasAlbum: false,
  });
  const fileOfMonitoredTrackInUnmonitoredAlbum = await createLibraryJob({
    albumMonitored: false,
    trackMonitored: true,
  });

  const missing = await request<{ requeued: number }>("/research-missing", { method: "POST" });
  const upgrades = await request<{ queued: number }>("/quality-upgrades", { method: "POST" });

  assert.equal(missing.requeued, 1);
  assert.deepEqual(
    [monitoredMissing, missingInUnmonitoredAlbum, missingUnmonitoredTrack].map(
      (jobId) => getJob(jobId).status,
    ),
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

test("Keep this file stops upgrades of that file and cancels the upgrade already queued", async () => {
  const kept = await createLibraryJob();
  const other = await createLibraryJob();
  const keptBeforeCheck = await createLibraryJob();
  const keptLibraryFile = await createLibraryJob();
  assert.ok(keptLibraryFile != null);
  const keptLibraryFileMbid = getJob(keptLibraryFile).trackMbid;
  await keepFile(keptBeforeCheck);
  await keepFile(keptLibraryFile);
  downloadTracker.removeJob(keptLibraryFile);

  const first = await request<{ queued: number }>("/quality-upgrades", { method: "POST" });
  assert.equal(first.queued, 2);
  assert.deepEqual(
    [kept, other, keptBeforeCheck].map((jobId) => upgradeJobsOf(jobId).length),
    [1, 1, 0],
  );
  assert.deepEqual(
    downloadTracker.getAll().filter((job) => job.trackMbid === keptLibraryFileMbid),
    [],
  );

  const result = await keepFile(kept);
  assert.equal(result.keepFile, true);
  assert.deepEqual(result.cancelledJobIds, [upgradeJobsOf(kept)[0].id]);
  assert.ok(
    ["cancelled", "cancel_requested"].includes(upgradeJobsOf(kept)[0].status),
    upgradeJobsOf(kept)[0].status,
  );
  assert.notEqual(upgradeJobsOf(other)[0].status, "cancelled");
  assert.equal(getJob(kept).status, "done");

  const second = await request<{ queued: number }>("/quality-upgrades", { method: "POST" });
  assert.equal(second.queued, 0);
  assert.equal(upgradeJobsOf(kept).length, 1);

  const direct = await fetch(`${baseUrl}/quality-upgrades/library/${kept}`, { method: "POST" });
  assert.equal(direct.status, 409);
  assert.equal((await direct.json()).code, "kept_file");
  assert.equal(upgradeJobsOf(kept).length, 1);
});

function getJob(id: Parameters<typeof downloadTracker.getJob>[0]) {
  const job = downloadTracker.getJob(id);
  assert.ok(job, `Expected download job ${id}`);
  return job;
}
