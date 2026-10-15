import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { setupIsolatedBackend, cleanupIsolatedState, createMockHttpServer } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  trackerModule,
  cancellation,
  libraryStore,
  managementStore,
  { registerAlbums },
  { registerDownloads, invalidateAllDownloadStatusesCache },
  { resolveYtdlpStagingRoot },
  { lidarrClient },
  { dbOps },
  { libraryManager },
  { downloadWorker },
  { finishAlbumGrab },
  { scanMusicRoot },
  { resolveDownloadRoot },
  { clearApiCaches },
  { db },
  { resolveReleaseManifest },
] = await setupIsolatedBackend(
  "aurral-album-lifecycle",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/routes/library/handlers/albums.js",
  "backend/routes/library/handlers/downloads.js",
  "backend/services/downloadFolderConfig.js",
  "backend/services/lidarrClient.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryManager.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/albumGrab.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/downloadPaths.js",
  "backend/services/apiClients/clearCache.js",
  "backend/config/db-sqlite.js",
  "backend/services/releaseResolver.js",
);

const { downloadTracker, DownloadTracker } = trackerModule;
const { default: playlistsRouter } = await import("../../backend/routes/playlists/index.js");
const { default: requestsRouter } = await import("../../backend/routes/requests.js");
const history = await import("../../backend/services/aurralHistoryService.js");
let requestUser = { id: 1, role: "admin" };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = requestUser; next(); });
app.use("/api/playlists", playlistsRouter);
app.use("/api/requests", requestsRouter);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
// The payload of a Soulseek folder the release judge verified before download.
async function verifiedGrab(ids) {
  return { jobId: ids[0], albumGrab: true, albumGroupJobIds: ids, source: "slskd", playlistId: "library",
    releaseMbid: (await resolveReleaseManifest(downloadTracker.getJob(ids[0])))?.releaseMbid ?? null,
    candidate: { releaseVerified: true, raw: { user: "peer", files: [] } } };
}

async function apiRequest(route, method = "GET") {
  const response = await fetch(`${baseUrl}${route}`, { method });
  return { status: response.status, body: await response.json() };
}

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
const router = { get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") };
registerAlbums(router);
registerDownloads(router);

async function callRoute(key, params = {}, body = {}, query = {}) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    { params, body, query, user: { role: "admin", permissions: {} } },
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

async function callRouteAsWebProcess(t, ...args) {
  const statement = Object.getPrototypeOf(db.prepare("SELECT 1"));
  const reads = ["all", "get", "iterate"].map((method) => t.mock.method(statement, method));
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await callRoute(...args);
    const jobReads = reads
      .flatMap((read) => read.mock.calls)
      .filter((call) => /\bplaylist_download_jobs\b/.test(call.this.source));
    return { response, jobReads: jobReads.length };
  } finally {
    process.env.NODE_ENV = previousMode;
    for (const read of reads) read.mock.restore();
  }
}

let albumSequence = 0;
function createLibraryAlbum({ managedBy = "aurral", trackCount = 3, availableTracks = 0, releaseMbid = null } = {}) {
  albumSequence += 1;
  const suffix = String(albumSequence).padStart(12, "0");
  const artistMbid = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  const albumMbid = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: `Lifecycle Artist ${albumSequence}`,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: releaseMbid || albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Lifecycle Album ${albumSequence}`,
  });
  const tracks = Array.from({ length: trackCount }, (_, index) => {
    const trackMbid = `dddddddd-dddd-4ddd-8ddd-${suffix.slice(0, 10)}${String(index).padStart(2, "0")}`;
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `recording:${trackMbid}`,
      mbid: trackMbid,
      title: `Track ${index + 1}`,
      artistName: artist.name,
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    if (index < availableTracks) {
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: managedBy,
        path: path.join(isolatedState.dataDir, `album-${albumSequence}`, `${index + 1}.flac`),
      });
    }
    return { ...track, trackMbid };
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy });
  const requestGroupId = `group-${albumSequence}`;
  const jobFor = (index, job = {}, playlistType = "library") =>
    downloadTracker.addJob(
      {
        artistName: artist.name,
        trackName: tracks[index].title,
        albumName: album.title,
        albumMbid,
        artistMbid,
        trackMbid: tracks[index].trackMbid,
        managedBy: "aurral",
        requestGroupId,
        ...job,
      },
      playlistType,
    );
  return { album, albumMbid, artistMbid, tracks, jobFor };
}

function addAlbumJob(trackName, requestGroupId = "group-1") {
  return downloadTracker.addJob(
    {
      artistName: "Lifecycle Artist",
      trackName,
      albumName: "Lifecycle Album",
      albumMbid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      managedBy: "aurral",
      requestGroupId,
    },
    "library",
  );
}

test.beforeEach(() => {
  downloadTracker.clearAll();
  requestUser = { id: 1, role: "admin" };
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("cancelling one Library download preserves monitoring and rejects finished work", async () => {
  const fixture = createLibraryAlbum();
  const pending = fixture.jobFor(0);
  const untouched = fixture.jobFor(1);
  const cancelled = await apiRequest(`/api/playlists/jobs/${pending}/cancel`, "POST");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(downloadTracker.getJob(pending).status, "cancelled");
  assert.equal(downloadTracker.getJob(untouched).status, "pending");
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(fixture.tracks[0].id).monitored, 1);
  const finished = fixture.jobFor(2);
  downloadTracker.setDone(finished, "/disposable/finished.flac");
  assert.equal((await apiRequest(`/api/playlists/jobs/${finished}/cancel`, "POST")).status, 409);
  assert.equal(downloadTracker.getJob(finished).status, "done");
  assert.equal((await apiRequest(`/api/playlists/flows/library/tracks/${pending}/research`, "POST")).status, 409);
  assert.equal(downloadTracker.getJob(pending).status, "cancelled");
});

test("a Library requester can cancel without flow permission and cannot cancel another requester's song", async () => {
  const fixture = createLibraryAlbum();
  const own = fixture.jobFor(0);
  const other = fixture.jobFor(1);
  history.recordTrackJobQueued(downloadTracker.getJob(own), { id: 3, username: "owner" });
  history.recordTrackJobQueued(downloadTracker.getJob(other), { id: 4, username: "other" });
  history.recordTrackJobSearching(downloadTracker.getJob(own));
  requestUser = { id: 3, role: "user", permissions: {} };
  assert.equal((await apiRequest(`/api/playlists/jobs/${other}/cancel`, "POST")).status, 403);
  assert.equal((await apiRequest("/api/playlists/jobs/unknown-job/cancel", "POST")).status, 404);
  assert.equal((await apiRequest(`/api/playlists/jobs/${own}/cancel`, "POST")).status, 200);
  assert.equal(downloadTracker.getJob(own).status, "cancelled");
  assert.equal(downloadTracker.getJob(other).status, "pending");
});

test("album-grab request rows include canonical ids and request groups", async () => {
  const fixture = createLibraryAlbum({ trackCount: 2 });
  const ids = [fixture.jobFor(0), fixture.jobFor(1)];
  history.recordAlbumRequested({ albumId: fixture.album.id, albumName: fixture.album.title,
    managedBy: "aurral", requestGroupId: downloadTracker.getJob(ids[0]).requestGroupId });
  const { recordAlbumGrabQueued } = await import("../../backend/services/albumGrabActivity.js");
  recordAlbumGrabQueued({ albumGrab: true, jobId: ids[0], albumGroupJobIds: ids }, ids.map((id) => downloadTracker.getJob(id)));
  const response = await apiRequest("/api/requests?refresh=1");
  assert.equal(response.status, 200);
  const rows = response.body.filter((item) => ids.includes(item.jobId));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.canonicalAlbumId, String(fixture.album.id));
    assert.equal(row.albumGrab.canonicalAlbumId, String(fixture.album.id));
    assert.equal(row.requestGroupId, downloadTracker.getJob(row.jobId).requestGroupId);
  }
  const albumRequest = response.body.find((item) => item.kind === "album_requested" && item.albumId === String(fixture.album.id));
  assert.equal(albumRequest.canonicalAlbumId, String(fixture.album.id));
  assert.equal(albumRequest.requestGroupId, downloadTracker.getJob(ids[0]).requestGroupId);
});

test("track cancellation keeps failed provider cleanup pending and succeeds after recovery", async (t) => {
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.setDownloading(id);
  downloadTracker.updateDownloadMetadata(id, { downloadSource: "usenet", downloadClient: "sabnzbd", downloadClientId: "disposable-queue" });
  const first = await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "cancel_requested");
  assert.equal(first.body.cleanupFailed, true);
  const { getDownloadClient } = await import("../../backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("sabnzbd");
  t.mock.method(client, "isConfigured", () => true);
  t.mock.method(client, "deleteQueueItem", async () => true);
  t.mock.method(client, "deleteHistoryItem", async () => true);
  const recovered = await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST");
  assert.equal(recovered.body.status, "cancelled");
  assert.equal(recovered.body.cleanupFailed, false);
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(fixture.tracks[0].id).monitored, 1);
});

test("track cancellation respects private flow ownership", async () => {
  const { flowPlaylistConfig } = await import("../../backend/services/playlists/flowPlaylistConfig.js");
  const flow = flowPlaylistConfig.createFlow({ name: "Private cancellation fixture", ownerUserId: 4 });
  const id = downloadTracker.addJob({ artistName: "Artist", trackName: "Private song" }, flow.id);
  requestUser = { id: 3, role: "user", permissions: { accessFlow: true } };
  assert.equal((await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).status, 404);
  assert.equal(downloadTracker.getJob(id).status, "pending");
  requestUser = { id: 4, role: "user", permissions: { accessFlow: true } };
  assert.equal((await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).status, 200);
});

test("cancelling an album leader keeps its held peer and shared transfer running", async () => {
  const fixture = createLibraryAlbum({ trackCount: 2 });
  const leader = fixture.jobFor(0);
  const peer = fixture.jobFor(1);
  downloadTracker.setDownloading(leader);
  downloadTracker.setDownloading(peer);
  downloadTracker.markSlskdDispatched(leader);
  downloadTracker.updateDownloadMetadata(leader, { downloadSource: "deemix", downloadClientId: "shared-transfer" });
  const honker = await import("../../backend/services/honkerDb.js");
  const payload = { jobId: leader, playlistId: "library", playlistGeneration: 0, phase: "poll", albumGrab: true, albumGroupJobIds: [leader, peer], queueUuid: "shared-transfer" };
  honker.getPipelineQueue().enqueue(payload);
  const response = await apiRequest(`/api/playlists/jobs/${leader}/cancel`, "POST");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "cancelled");
  assert.equal(downloadTracker.getJob(peer).status, "downloading");
  assert.equal(downloadTracker.getJob(peer).downloadClientId, "shared-transfer");
  const { resolveTransferredDownloadPayload } = await import("../../backend/services/downloadJobs/downloadOwnership.js");
  const continued = resolveTransferredDownloadPayload(payload);
  assert.equal(continued.jobId, peer);
  assert.equal(cancellation.isPipelinePayloadActive(continued), true);
  assert.ok(honker.listHonkerJobs("slskd-pipeline").some((row) => row.payload.jobId === peer));
});

test("a cancelled single song can be searched again and the worker takes it", async () => {
  setDownloadSourceConfigured(false);
  const id = downloadTracker.addJob({ artistName: "Single Artist", trackName: "Single song" }, "library");
  assert.equal((await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).body.status, "cancelled");
  const { processPlaylistOperation } = await import("../../backend/services/playlists/playlistOperations.js");
  try {
    const result = await processPlaylistOperation({ kind: "shared-playlist-research-track", playlistId: "library", jobId: id });
    assert.equal(result.success, true);
    const deadline = Date.now() + 5000;
    while (downloadTracker.getJob(id).status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(downloadTracker.getJob(id).status, "failed");
  } finally {
    await downloadWorker.stopAndDrain();
  }
});

test("requeueing a Library job refreshes the cached activity response", async () => {
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.setFailed(id, "No match");
  history.recordTrackJobFailed(downloadTracker.getJob(id), "No match");
  const before = await apiRequest("/api/requests?refresh=1");
  assert.equal(before.body.find((item) => item.jobId === id).status, "failed");
  const { processPlaylistOperation } = await import("../../backend/services/playlists/playlistOperations.js");
  const result = await processPlaylistOperation({ kind: "shared-playlist-research-track", playlistId: "library", jobId: id });
  assert.equal(result.success, true);
  try {
    const after = await apiRequest("/api/requests");
    assert.equal(after.body.find((item) => item.jobId === id).status, "processing");
  } finally {
    await downloadWorker.stopAndDrain();
  }
});

test("the web activity cache notices job changes committed by another process", async () => {
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  history.recordTrackJobQueued(downloadTracker.getJob(id));
  const script = `
    import { createRequire } from 'node:module';
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.prepare("UPDATE playlist_download_jobs SET status = 'done', completed_at = ? WHERE id = ?").run(Date.now(), process.argv[2]);
    db.close();
  `;
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const before = await apiRequest("/api/requests?refresh=1");
    assert.equal(before.body.find((item) => item.jobId === id).status, "pending");
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, isolatedState.dbPath, id]);
    assert.equal(downloadTracker.getJob(id).status, "done");
    const after = await apiRequest("/api/requests");
    assert.equal(after.body.find((item) => item.jobId === id).status, "completed");
  } finally {
    process.env.NODE_ENV = previousMode;
    downloadTracker.reconcileCommittedJobs();
  }
});

test("restart returns interrupted album jobs to pending and never revives cancelled work", () => {
  const pending = addAlbumJob("Pending");
  const interrupted = addAlbumJob("Interrupted");
  const cancelledWhileDownloading = addAlbumJob("Cancelled while downloading");
  const cancelRequested = addAlbumJob("Cancel requested");
  const cancelled = addAlbumJob("Cancelled");

  for (const id of [interrupted, cancelledWhileDownloading, cancelRequested]) {
    downloadTracker.setDownloading(id);
  }
  cancellation.cancelDownloadJobs([cancelledWhileDownloading, cancelRequested, cancelled]);
  downloadTracker.setCancelRequested(cancelRequested);
  downloadTracker.setCancelled(cancelled);

  const restarted = new DownloadTracker();
  const expected = {
    [pending]: "pending",
    [interrupted]: "pending",
    [cancelledWhileDownloading]: "cancelled",
    [cancelRequested]: "cancelled",
    [cancelled]: "cancelled",
  };
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(restarted.getJob(id).status, status, restarted.getJob(id).trackName);
  }
  assert.deepEqual(
    restarted.getPending(10).map((job) => job.id).sort(),
    [pending, interrupted].sort(),
  );

  downloadTracker.resetDownloadingToPending();
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(downloadTracker.getJob(id).status, status, downloadTracker.getJob(id).trackName);
  }
  assert.equal(downloadTracker.getStats().cancelled, 3);
});

test("a cancelled album job ignores late pipeline transitions until it is retried", () => {
  const id = addAlbumJob("Late failure");
  downloadTracker.setDownloading(id);
  cancellation.cancelDownloadJobs([id]);
  downloadTracker.setCancelRequested(id);

  downloadTracker.setFailed(id, "slskd transfer aborted");
  downloadTracker.setPending(id, "retry");
  downloadTracker.setBlocked(id, "needs review");
  assert.equal(downloadTracker.setDone(id, path.join(isolatedState.dataDir, "late.flac")), false);
  assert.equal(downloadTracker.getJob(id).status, "cancel_requested");
  assert.equal(downloadTracker.getJob(id).error, null);

  downloadTracker.setCancelled(id);
  downloadTracker.setDownloading(id);
  assert.equal(downloadTracker.getJob(id).status, "cancelled");
  assert.equal(downloadTracker.getNextPending(), null);

  cancellation.restoreDownloadJobCancellations([id]);
  assert.equal(downloadTracker.setPending(id, "Retrying", { asRetryCycle: true }), true);
  assert.equal(downloadTracker.getJob(id).status, "pending");
  assert.equal(downloadTracker.getNextPending()?.id, id);
});

test("cancelling an Aurral album stops active work, cleans staging, and keeps finished tracks", async () => {
  const originalRequest = lidarrClient.request;
  const lidarrCalls = [];
  lidarrClient.request = async (...args) => {
    lidarrCalls.push(args);
    throw new Error("Lidarr must not be called");
  };
  const { album, jobFor } = createLibraryAlbum({ availableTracks: 1 });
  const doneJob = jobFor(0);
  downloadTracker.setDone(doneJob, path.join(isolatedState.dataDir, "done.flac"), album.title);
  const downloadingJob = jobFor(1);
  downloadTracker.setDownloading(downloadingJob);
  downloadTracker.updateDownloadMetadata(downloadingJob, { downloadClient: "ytdlp" });
  const pendingJob = jobFor(2);
  const stagingPath = path.join(resolveYtdlpStagingRoot(""), "ytdlp", downloadingJob);
  await fs.mkdir(stagingPath, { recursive: true });
  await fs.writeFile(path.join(stagingPath, "partial.m4a"), "partial download");

  try {
    const cancelled = await callRoute(
      "POST /albums/aurral/:canonicalId/cancel",
      { canonicalId: String(album.id) },
    );
    assert.equal(cancelled.statusCode, 200);
    assert.deepEqual(cancelled.body.cancelledJobIds.sort(), [downloadingJob, pendingJob].sort());
    assert.equal(downloadTracker.getJob(doneJob).status, "done");
    assert.equal(downloadTracker.getJob(downloadingJob).status, "cancelled");
    assert.equal(downloadTracker.getJob(pendingJob).status, "cancelled");
    assert.equal(downloadTracker.getJob(downloadingJob).error, null);
    await assert.rejects(fs.access(stagingPath));
    assert.equal(downloadTracker.getNextPending(), null);

    const repeated = await callRoute(
      "POST /albums/aurral/:canonicalId/cancel",
      { canonicalId: String(album.id) },
    );
    assert.equal(repeated.statusCode, 200);
    assert.deepEqual(repeated.body.cancelledJobIds, []);
    assert.equal(lidarrCalls.length, 0);
  } finally {
    lidarrClient.request = originalRequest;
    await fs.rm(stagingPath, { recursive: true, force: true });
  }
});

test("album cancellation rejects unknown, malformed, and Lidarr-managed albums", async () => {
  const { album: lidarrAlbum, jobFor } = createLibraryAlbum({ managedBy: "lidarr", availableTracks: 1 });
  const lidarrJob = jobFor(1);

  const missing = await callRoute("POST /albums/aurral/:canonicalId/cancel", { canonicalId: "999999" });
  assert.equal(missing.statusCode, 404);
  const malformed = await callRoute("POST /albums/aurral/:canonicalId/cancel", { canonicalId: "12abc" });
  assert.equal(malformed.statusCode, 400);
  const conflict = await callRoute(
    "POST /albums/aurral/:canonicalId/cancel",
    { canonicalId: String(lidarrAlbum.id) },
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "album_owner_conflict");
  assert.equal(conflict.body.managedBy, "lidarr");
  assert.equal(downloadTracker.getJob(lidarrJob).status, "pending");
});

test("album cancellation waits on provider cleanup without reviving the job", async () => {
  const { album, jobFor } = createLibraryAlbum();
  const jobId = jobFor(0);
  downloadTracker.setDownloading(jobId);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "unconfigured-sabnzbd-item",
  });

  const cancelled = await callRoute(
    "POST /albums/aurral/:canonicalId/cancel",
    { canonicalId: String(album.id) },
  );
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.cleanupFailed, true);
  assert.equal(downloadTracker.getJob(jobId).status, "cancel_requested");

  downloadTracker.setFailed(jobId, "late provider error");
  assert.equal(downloadTracker.getJob(jobId).status, "cancel_requested");
  assert.equal(new DownloadTracker().getJob(jobId).status, "cancelled");
});

function setDownloadSourceConfigured(configured) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      slskd: configured
        ? { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" }
        : { enabled: false },
      ytdlp: { enabled: false },
    },
  });
}

test("album status aggregates library availability and per-track jobs", async (t) => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalRequest = lidarrClient.request;
  const lidarrCalls = [];
  lidarrClient.isConfigured = () => false;
  lidarrClient.request = async (...args) => {
    lidarrCalls.push(args);
    throw new Error("Lidarr must not be called");
  };
  setDownloadSourceConfigured(true);

  const scenarios = [
    { name: "complete", availableTracks: 3, jobs: [], status: "complete" },
    { name: "queued", jobs: ["pending", "pending", "pending"], status: "queued" },
    { name: "downloading", jobs: ["downloading", "pending", "pending"], status: "downloading" },
    { name: "cancelling", jobs: ["cancel_requested", "cancelled", "cancelled"], status: "downloading" },
    { name: "cancelled", availableTracks: 1, jobs: [null, "cancelled", "cancelled"], status: "cancelled" },
    { name: "blocked", jobs: ["blocked", "failed", "failed"], status: "blocked", recovery: "review_required" },
    { name: "failed", jobs: ["failed", "failed", "failed"], status: "failed", recovery: "source_failed" },
    { name: "partial", availableTracks: 2, jobs: [null, null, "failed"], status: "partial", recovery: "source_failed" },
    { name: "missing", jobs: [], status: "missing" },
    { name: "no source", jobs: [], status: "blocked", recovery: "download_source_missing", sourceConfigured: false },
  ];

  try {
    for (const scenario of scenarios) {
      setDownloadSourceConfigured(scenario.sourceConfigured !== false);
      const { album, jobFor } = createLibraryAlbum({ availableTracks: scenario.availableTracks || 0 });
      scenario.key = `aurral:${album.id}`;
      scenario.jobs.forEach((jobStatus, index) => {
        if (!jobStatus) return;
        const jobId = jobFor(index);
        if (jobStatus === "downloading" || jobStatus === "cancel_requested") {
          downloadTracker.setDownloading(jobId);
        }
        if (jobStatus === "cancel_requested") downloadTracker.setCancelRequested(jobId);
        if (jobStatus === "cancelled") downloadTracker.setCancelled(jobId);
        if (jobStatus === "failed") downloadTracker.setFailed(jobId, "No matching source result");
        if (jobStatus === "blocked") downloadTracker.setBlocked(jobId, "Low confidence match");
      });

      const response = await callRoute(
        "GET /albums/aurral/:canonicalId/status",
        { canonicalId: String(album.id) },
      );
      assert.equal(response.statusCode, 200, scenario.name);
      assert.equal(response.body.status, scenario.status, scenario.name);
      assert.equal(response.body.managedBy, "aurral", scenario.name);
      assert.equal(response.body.counts.total, 3, scenario.name);
      assert.equal(response.body.recovery?.code ?? null, scenario.recovery ?? null, scenario.name);
      if (scenario.recovery) assert.ok(response.body.recovery.message, scenario.name);
    }

    setDownloadSourceConfigured(true);
    const { album: lidarrAlbum } = createLibraryAlbum({ managedBy: "lidarr" });
    const polled = scenarios.filter((scenario) => scenario.sourceConfigured !== false);
    const query = {
      albumIds: [...polled.map((scenario) => scenario.key), `aurral:${lidarrAlbum.id}`, "aurral:not-a-number"].join(","),
    };
    const batch = await callRoute("GET /downloads/status", {}, {}, query);
    assert.equal(batch.statusCode, 200);
    assert.deepEqual(Object.keys(batch.body).sort(), polled.map((scenario) => scenario.key).sort());
    for (const scenario of polled) {
      assert.equal(batch.body[scenario.key].status, scenario.status, scenario.name);
      assert.equal(batch.body[scenario.key].recovery?.code ?? null, scenario.recovery ?? null, scenario.name);
    }
    const { response: webBatch } = await callRouteAsWebProcess(t, "GET /downloads/status", {}, {}, query);
    assert.deepEqual(webBatch.body, batch.body);
    assert.equal(lidarrCalls.length, 0);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.request = originalRequest;
    setDownloadSourceConfigured(false);
  }
});

test("a download status poll finds album jobs under either album ID in any spelling and reads jobs once", async (t) => {
  setDownloadSourceConfigured(true);
  try {
    const legacy = createLibraryAlbum({ trackCount: 2, releaseMbid: "abcdabcd-abcd-4bcd-8bcd-000000000001" });
    const releaseMbid = legacy.album.mbid;
    const olderJobs = [
      legacy.jobFor(0, { albumMbid: releaseMbid }),
      legacy.jobFor(1),
    ];
    const newerJobs = [
      legacy.jobFor(0),
      legacy.jobFor(1, { albumMbid: releaseMbid }),
    ];
    olderJobs.forEach((jobId) => downloadTracker.setFailed(jobId, "No matching source result"));

    const spelled = createLibraryAlbum({ trackCount: 2 });
    const paddedJob = spelled.jobFor(0, { albumMbid: spelled.albumMbid.toUpperCase() });
    spelled.jobFor(1, { albumMbid: spelled.albumMbid.toUpperCase() });
    downloadTracker.setDownloading(paddedJob);

    const untouched = createLibraryAlbum({ trackCount: 2 });
    untouched.jobFor(0, { managedBy: "lidarr" });
    untouched.jobFor(1, {}, "discover");

    db.prepare("UPDATE playlist_download_jobs SET created_at = created_at - 60000 WHERE id IN (?, ?)").run(...olderJobs);
    db.prepare("UPDATE playlist_download_jobs SET album_mbid = ? WHERE id = ?")
      .run(` ${spelled.albumMbid.toUpperCase()}\t`, paddedJob);
    downloadTracker.reconcileCommittedJobs();

    const keys = [legacy, spelled, untouched].map(({ album }) => `aurral:${album.id}`);
    const query = { albumIds: keys.join(",") };
    const expected = {
      [keys[0]]: { status: "queued", pending: 2, failed: 0 },
      [keys[1]]: { status: "downloading", pending: 1, downloading: 1 },
      [keys[2]]: { status: "missing", missing: 2, pending: 0 },
    };
    const poll = await callRoute("GET /downloads/status", {}, {}, query);
    const webPoll = await callRouteAsWebProcess(t, "GET /downloads/status", {}, {}, query);
    const singleAlbumPoll = await callRouteAsWebProcess(t, "GET /downloads/status", {}, {}, { albumIds: keys[0] });

    for (const [key, { status, ...counts }] of Object.entries(expected)) {
      assert.equal(poll.body[key].status, status, key);
      for (const [name, count] of Object.entries(counts)) {
        assert.equal(poll.body[key].counts[name], count, `${key} ${name}`);
      }
    }
    assert.deepEqual(webPoll.response.body, poll.body);
    assert.equal(webPoll.jobReads, 1);
    assert.equal(singleAlbumPoll.jobReads, 1);
  } finally {
    setDownloadSourceConfigured(false);
  }
});

test("re-requesting an Aurral album waits for a download source and retries cancelled tracks in place", async () => {
  const originalWorkerStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  const { album, albumMbid, artistMbid } = createLibraryAlbum();
  const albumJobs = () => downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);
  const request = () =>
    libraryManager.addAlbum(artistMbid, albumMbid, album.title, { managedBy: "aurral" });

  try {
    setDownloadSourceConfigured(false);
    const blocked = await request();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.albumStatus.status, "blocked");
    assert.equal(blocked.albumStatus.recovery.code, "download_source_missing");
    assert.deepEqual(blocked.jobIds, []);
    assert.equal(albumJobs().length, 0);

    setDownloadSourceConfigured(true);
    const queued = await request();
    assert.equal(queued.albumStatus.status, "queued");
    assert.equal(queued.jobIds.length, 3);

    downloadTracker.setDownloading(queued.jobIds[0]);
    downloadTracker.setFailed(queued.jobIds[1], "No matching source result");
    await libraryManager.cancelAurralAlbum(album.id);
    assert.equal(downloadTracker.getJob(queued.jobIds[0]).status, "cancelled");
    assert.equal(downloadTracker.getJob(queued.jobIds[1]).status, "failed");

    const retried = await request();
    assert.deepEqual([...retried.jobIds].sort(), [...queued.jobIds].sort());
    assert.equal(albumJobs().length, 3);
    for (const jobId of queued.jobIds) {
      assert.equal(downloadTracker.getJob(jobId).status, "pending");
    }
    assert.equal(retried.albumStatus.status, "queued");

    downloadTracker.setFailed(queued.jobIds[0], "Source failed after retry");
    assert.equal(downloadTracker.getJob(queued.jobIds[0]).status, "failed");
  } finally {
    downloadWorker.start = originalWorkerStart;
    setDownloadSourceConfigured(false);
  }
});

test("re-requesting a missing completed file reports a missing download source", async () => {
  const { album, albumMbid, artistMbid, jobFor } = createLibraryAlbum({ trackCount: 1 });
  const jobId = jobFor(0);
  downloadTracker.setDone(jobId, path.join(isolatedState.dataDir, "deleted.flac"));
  setDownloadSourceConfigured(false);

  const result = await libraryManager.addAlbum(artistMbid, albumMbid, album.title, { managedBy: "aurral" });
  assert.equal(result.status, "blocked");
  assert.equal(result.albumStatus.status, "blocked");
  assert.equal(result.albumStatus.recovery?.code, "download_source_missing");
  assert.equal(downloadTracker.getJob(jobId).status, "failed");
});

test("active downloads list in-flight albums, artists, and tracks so buttons survive a reload", async (t) => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalRequest = lidarrClient.request;
  lidarrClient.isConfigured = () => true;
  lidarrClient.request = async (endpoint) => {
    if (endpoint.startsWith("/queue")) {
      return [{ albumId: 7, status: "downloading", size: 100, sizeleft: 40 }];
    }
    if (endpoint.startsWith("/history")) return { records: [] };
    if (endpoint.startsWith("/command")) return [];
    if (endpoint.startsWith("/album")) {
      return [
        { id: 7, foreignAlbumId: "lidarr-album", artist: { foreignArtistId: "lidarr-artist" } },
        { id: 8, foreignAlbumId: "lidarr-idle-album", artist: { foreignArtistId: "lidarr-idle-artist" } },
      ];
    }
    return [];
  };
  invalidateAllDownloadStatusesCache();

  try {
    const queuedAlbum = createLibraryAlbum();
    const downloadingTrack = queuedAlbum.jobFor(0);
    downloadTracker.setDownloading(downloadingTrack);
    queuedAlbum.jobFor(1);
    downloadTracker.setFailed(queuedAlbum.jobFor(2), "No matching source result");

    const finishedAlbum = createLibraryAlbum();
    downloadTracker.setCancelled(finishedAlbum.jobFor(0));
    downloadTracker.setDone(finishedAlbum.jobFor(1), path.join(isolatedState.dataDir, "done.flac"));

    downloadTracker.addJob(
      {
        artistName: "Single Artist",
        trackName: "Single Track",
        albumMbid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        artistMbid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        trackMbid: "single-track-mbid",
      },
      "library",
    );
    downloadTracker.addJob(
      { artistName: "Flow Artist", trackName: "Flow Track", trackMbid: "flow-track-mbid" },
      "discover",
    );

    const response = await callRoute("GET /downloads/active");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      [...response.body.albums].sort(),
      [queuedAlbum.albumMbid, "lidarr-album"].sort(),
    );
    assert.deepEqual(
      [...response.body.artists].sort(),
      [queuedAlbum.artistMbid, "lidarr-artist"].sort(),
    );
    assert.deepEqual(
      response.body.tracks.map((track) => track.mbid).sort(),
      [queuedAlbum.tracks[0].trackMbid, queuedAlbum.tracks[1].trackMbid, "single-track-mbid"].sort(),
    );
    const { response: webResponse } = await callRouteAsWebProcess(t, "GET /downloads/active");
    assert.deepEqual(webResponse.body, response.body);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.request = originalRequest;
    invalidateAllDownloadStatusesCache();
  }
});

test("an album asks for its most common edition and a shorter download leaves its missing tracks wanted", async (t) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000001";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000002";
  const recording = (index) => `eeeeeeee-eeee-4eee-8eee-10000000000${index}`;
  const release = (id, count, perDisc = count) => ({ id, status: "Official",
    tracks: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`, recordingid: recording(index + 1), trackname: `Edition Song ${index + 1}`,
      artistid: artistMbid, durationms: 1000, trackposition: (index % perDisc) + 1,
      mediumnumber: Math.floor(index / perDisc) + 1,
    })) });
  const standard = { id: "standard", status: "Official", tracks: release("standard", 3).tracks.slice(1)
    .map((track, index) => ({ ...track, trackposition: index + 1 })) };
  const misprint = { id: "misprint", status: "Official", tracks: release("misprint", 3).tracks.reverse()
    .map((track, index) => ({ ...track, trackposition: index + 1 })) };
  const releases = [standard, misprint, release("deluxe-vinyl", 3, 2), release("deluxe", 3), release("box-set", 4)];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url, "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ id: albumMbid, title: "Edition Album", artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Edition Artist" }],
      releases }));
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({ ...originalSettings, integrations: { ...originalSettings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadata.url, enableNarrowFallbacks: false } } });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.after(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute("POST /albums/request", {}, { albumMbid, albumName: "Edition Album",
    artistMbid, artistName: "Edition Artist", managedBy: "aurral" });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  const ids = requested.body.jobIds;
  assert.deepEqual(ids.map((id) => [downloadTracker.getJob(id).trackNumber, downloadTracker.getJob(id).trackName]),
    [[1, "Edition Song 1"], [2, "Edition Song 2"], [3, "Edition Song 3"]]);

  const folder = path.join(isolatedState.baseDir, "edition-download");
  await fs.mkdir(folder, { recursive: true });
  const writeSong = async (song, position) => {
    const filePath = path.join(folder, `0${position} Edition Song ${song}.flac`);
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", `title=Edition Song ${song}`,
      "-metadata", "artist=Edition Artist", "-metadata", `track=${position}`, filePath]);
    return filePath;
  };
  const grab = await verifiedGrab(ids);
  assert.equal(grab.releaseMbid, "deluxe");
  const shorter = [await writeSong(2, 1), await writeSong(3, 2)];
  await finishAlbumGrab({ ...grab, source: "usenet", candidate: { raw: { release: { guid: "shorter" } } } },
    { filePaths: shorter, source: "usenet" });
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).status), ["pending", "pending", "pending"]);
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).deniedRemoteSources), ids.map(() => [["usenet", "shorter"]]));

  for (const id of ids) downloadTracker.setDownloading(id);
  const next = await finishAlbumGrab(grab, { filePaths: [await writeSong(2, 2), await writeSong(3, 3)],
    source: "soulseek" });
  assert.deepEqual([next.jobId, next.albumGrab, next.phase], [ids[0], false, "search"]);
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).status), ["downloading", "done", "done"]);
  assert.deepEqual(ids.slice(1).map((id) => path.basename(downloadTracker.getJob(id).finalPath)),
    ["02 - Edition Song 2.flac", "03 - Edition Song 3.flac"]);
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE mbid = ?").pluck().get(recording(1)), 1);

  await scanMusicRoot({ rootPath: resolveDownloadRoot(), source: "aurral" });
  invalidateAllDownloadStatusesCache();
  const status = await callRoute("GET /albums/aurral/:canonicalId/status",
    { canonicalId: String(requested.body.album.id) });
  assert.notEqual(status.body.status, "complete");
  assert.equal(status.body.counts.total, 3);
});

test("an album that wants the expanded edition keeps wanting the extra track a download lacks", async (t) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000021";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000022";
  const release = (id, count) => ({ id, status: "Official", tracks: Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`, recordingid: `eeeeeeee-eeee-4eee-8eee-30000000000${index + 1}`,
    trackname: `Expanded Song ${index + 1}`, artistid: artistMbid, durationms: 1000,
    trackposition: index + 1, mediumnumber: 1,
  })) });
  const releases = [release("cd", 2), release("digital", 2), release("deluxe", 3), release("box-set", 7)];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url, "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ id: albumMbid, title: "Expanded Album", artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Expanded Artist" }], releases }));
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({ ...originalSettings, integrations: { ...originalSettings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadata.url, enableNarrowFallbacks: false } } });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  const defaults = libraryManager.getMonitoringDefaultsState().rules;
  libraryManager.setMonitoringDefaults({ ...defaults, edition: "expanded" });
  let ids = [];
  t.after(async () => {
    for (const id of ids) {
      if (downloadTracker.getJob(id)?.status === "pending") downloadTracker.setCancelled(id);
    }
    libraryManager.setMonitoringDefaults(defaults);
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute("POST /albums/request", {}, { albumMbid, albumName: "Expanded Album",
    artistMbid, artistName: "Expanded Artist", managedBy: "aurral" });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  ids = requested.body.jobIds;
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).trackName),
    ["Expanded Song 1", "Expanded Song 2", "Expanded Song 3"]);
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).releaseMbid), ["deluxe", "deluxe", "deluxe"]);

  const folder = path.join(isolatedState.baseDir, "expanded-download");
  await fs.mkdir(folder, { recursive: true });
  const filePaths = [];
  for (const song of [1, 2]) {
    const filePath = path.join(folder, `0${song} Expanded Song ${song}.flac`);
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", `title=Expanded Song ${song}`,
      "-metadata", "artist=Expanded Artist", "-metadata", `track=${song}`, filePath]);
    filePaths.push(filePath);
  }
  await finishAlbumGrab(await verifiedGrab(ids), { filePaths, source: "soulseek" });
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).status), ["done", "done", "pending"]);
  const missing = db.prepare("SELECT monitored FROM library_tracks WHERE mbid = ?")
    .get("eeeeeeee-eeee-4eee-8eee-300000000003");
  assert.equal(missing.monitored, 1);
});

test("a two-disc album downloads a title it repeats on each disc to two names", async (t) => {
  const artistMbid = "dddddddd-dddd-4ddd-8ddd-000000000001";
  const albumMbid = "dddddddd-dddd-4ddd-8ddd-000000000002";
  const tracklist = [[1, 1, "Bomb"], [1, 2, "Swim"], [2, 1, "Bomb"], [2, 2, "Little Things"]];
  const recording = (index) => `dddddddd-dddd-4ddd-8ddd-10000000000${index}`;
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url, "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ id: albumMbid, title: "Disc Album", artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Disc Artist" }],
      releases: [{ id: "two-disc", status: "Official", tracks: tracklist.map(([disc, position, title], index) => ({
        id: `two-disc-${index}`, recordingid: recording(index), trackname: title, artistid: artistMbid,
        durationms: 1000, trackposition: position, mediumnumber: disc })) }] }));
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({ ...originalSettings, integrations: { ...originalSettings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadata.url, enableNarrowFallbacks: false } } });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.after(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute("POST /albums/request", {}, { albumMbid, albumName: "Disc Album",
    artistMbid, artistName: "Disc Artist", managedBy: "aurral" });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  const ids = requested.body.jobIds;
  assert.deepEqual(ids.map((id) => [downloadTracker.getJob(id).discNumber, downloadTracker.getJob(id).trackNumber]),
    tracklist.map(([disc, position]) => [disc, position]));

  const folder = path.join(isolatedState.baseDir, "two-disc-download");
  await fs.mkdir(folder, { recursive: true });
  const filePaths = [];
  for (const [index, [disc, position, title]] of tracklist.entries()) {
    const filePath = path.join(folder, `${disc}-0${position} ${title}.flac`);
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", `title=${title}`,
      "-metadata", "artist=Disc Artist", "-metadata", `track=${position}`, "-metadata", `disc=${disc}`,
      "-metadata", `MUSICBRAINZ_TRACKID=${recording(index)}`, filePath]);
    filePaths.push(filePath);
  }
  await finishAlbumGrab(await verifiedGrab(ids), { filePaths, source: "soulseek" });
  assert.deepEqual(ids.map((id) => [downloadTracker.getJob(id).status, path.basename(downloadTracker.getJob(id).finalPath)]), [
    ["done", "01 - Bomb.flac"],
    ["done", "02 - Swim.flac"],
    ["done", "2-01 - Bomb.flac"],
    ["done", "2-02 - Little Things.flac"],
  ]);
});

test("an album asks for its release's own lengths and fills a missing one from pressings of the same recordings", async (t) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000011";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000012";
  const pressing = (id, lengths, recording = 2) => ({ id, status: "Official", tracks: lengths.map((durationms, index) => ({
    id: `${id}-${index}`, recordingid: `eeeeeeee-eeee-4eee-8eee-${recording}0000000000${index + 1}`,
    trackname: `Pressing Song ${index + 1}`, artistid: artistMbid, durationms,
    trackposition: index + 1, mediumnumber: 1,
  })) });
  const releases = [pressing("vinyl", [296000, null]), pressing("cd", [301106, 254893]),
    pressing("digital", [301000, 254000]), pressing("rerecorded", [247000, 208000], 3)];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url, "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ id: albumMbid, title: "Pressing Album", artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Pressing Artist" }], releases }));
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({ ...originalSettings, integrations: { ...originalSettings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadata.url, enableNarrowFallbacks: false } } });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.after(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute("POST /albums/request", {}, { albumMbid, albumName: "Pressing Album",
    artistMbid, artistName: "Pressing Artist", managedBy: "aurral" });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  assert.deepEqual(requested.body.jobIds.map((id) => downloadTracker.getJob(id).durationMs), [296000, 254447]);
});

test("asking for an album downloads the missing tracks of the edition its track list shows", async (t) => {
  const artistMbid = "1a1a1a1a-1a1a-4a1a-8a1a-000000000011";
  const albumMbid = "1a1a1a1a-1a1a-4a1a-8a1a-000000000012";
  const recording = (index) => `1a1a1a1a-1a1a-4a1a-8a1a-20000000000${index}`;
  const release = (id, recordings) => ({ id, status: "Official",
    tracks: recordings.map((recordingIndex, index) => ({
      id: `${id}-${index}`, recordingid: recording(recordingIndex), trackname: `Listed Song ${index + 1}`,
      artistid: recordingIndex === 3 ? "1a1a1a1a-1a1a-4a1a-8a1a-000000000013" : artistMbid, durationms: 1000,
      trackposition: index + 1, mediumnumber: 1,
    })) });
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url, "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ id: albumMbid, title: "Listed Album", artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Listed Artist" },
        { id: "1a1a1a1a-1a1a-4a1a-8a1a-000000000013", artistname: "Listed Guest" }],
      releases: [release("listed-standard", [1, 4]), release("listed-reissue", [1, 4]), release("listed-deluxe", [1, 2, 3])] }));
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({ ...originalSettings, integrations: { ...originalSettings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadata.url, enableNarrowFallbacks: false } } });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.after(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });
  const artist = libraryStore.upsertLibraryArtist({ identityKey: `mbid:${artistMbid}`, mbid: artistMbid, name: "Listed Artist" });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${albumMbid}`, mbid: "listed-deluxe",
    releaseGroupMbid: albumMbid, artistId: artist.id, title: "Listed Album", metadata: { monitored: false } });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const owned = libraryStore.upsertLibraryTrack({ identityKey: `recording:${recording(1)}`, mbid: recording(1),
    title: "Listed Song 1", monitored: false });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: owned.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({ trackId: owned.id, albumId: album.id, source: "aurral",
    path: path.join(isolatedState.baseDir, "listed", "01 Listed Song 1.flac") });
  libraryStore.storeLibraryAlbumTrackList(album.id, { release: { id: "listed-deluxe",
    tracks: [1, 2, 3].map((index) => ({ recordingId: recording(index), title: `Listed Song ${index}`, mediumNumber: 1, trackPosition: index })) } });

  const requested = await callRoute("POST /albums/request", {}, { albumMbid, albumName: "Listed Album",
    artistMbid, artistName: "Listed Artist", managedBy: "aurral" });

  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  assert.deepEqual(requested.body.jobIds.map((id) => downloadTracker.getJob(id).trackName), ["Listed Song 2", "Listed Song 3"]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM library_album_tracks WHERE album_id = ?").pluck().get(album.id), 3);
  assert.deepEqual(requested.body.jobIds.map((id) => downloadTracker.getJob(id).releaseMbid), ["listed-deluxe", "listed-deluxe"]);
  assert.equal(db.prepare("SELECT artist_name FROM library_tracks WHERE mbid = ?").pluck().get(recording(3)), "Listed Guest");

  db.prepare("UPDATE library_albums SET metadata_json = json_set(metadata_json, '$.trackList.release', 'listed-standard') WHERE id = ?")
    .run(album.id);
  const job = downloadTracker.getJob(requested.body.jobIds[1]);
  const manifest = await resolveReleaseManifest({ ...job, releaseMbid: null });
  assert.equal(manifest.releaseMbid, "listed-deluxe");
  assert.deepEqual(manifest.tracks.map((track) => track.artists), [["Listed Artist"], ["Listed Artist"], ["Listed Guest"]]);
  assert.equal(await resolveReleaseManifest({ ...job, releaseMbid: null, trackName: "Listed Song 4", trackMbid: recording(4),
    trackNumber: 2 }), null);
});

test("an album scanned with its release ID stays one album through downloads and scans", async () => {
  setDownloadSourceConfigured(true);
  const releaseGroup = "abababab-abab-4bab-8bab-000000000001";
  const release = "abababab-abab-4bab-8bab-000000000002";
  const recording = (index) => `abababab-abab-4bab-8bab-10000000000${index}`;
  const root = path.join(isolatedState.baseDir, "release-keyed");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "mbid:abababab-abab-4bab-8bab-000000000003",
    mbid: "abababab-abab-4bab-8bab-000000000003", name: "Release Artist" });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${releaseGroup}`, mbid: release,
    releaseGroupMbid: releaseGroup, artistId: artist.id, title: "Release Album" });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const tracks = [1, 2].map((index) => libraryStore.upsertLibraryTrack({ identityKey: `recording:${recording(index)}`,
    mbid: recording(index), title: `Release Song ${index}`, artistName: artist.name }));
  tracks.forEach((track, index) => libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id,
    trackNumber: index + 1 }));
  libraryStore.upsertLibraryMediaFile({ trackId: tracks[0].id, albumId: album.id, source: "aurral",
    path: path.join(root, "Release Artist", "Release Album", "01 - Release Song 1.flac") });
  const jobId = downloadTracker.addJob({ artistName: artist.name, trackName: "Release Song 2", albumName: "Release Album",
    albumMbid: release, trackMbid: recording(2), managedBy: "aurral", requestGroupId: "release-keyed" }, "library");
  downloadTracker.setDone(jobId, path.join(root, "elsewhere.flac"));
  const status = async () => (await callRoute("GET /albums/aurral/:canonicalId/status",
    { canonicalId: String(album.id) })).body.status;

  const duplicate = libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${release}`, mbid: release,
    releaseGroupMbid: release, artistId: artist.id, title: "Release Album" });
  libraryStore.linkLibraryAlbumTrack({ albumId: duplicate.id, trackId: tracks[1].id, trackNumber: 2 });
  const filePath = path.join(root, "Release Artist", "Release Album", "02 - Release Song 2.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", "title=Release Song 2",
    "-metadata", "artist=Release Artist", "-metadata", "album=Release Album",
    "-metadata", `MUSICBRAINZ_RELEASEGROUPID=${release}`, "-metadata", `MUSICBRAINZ_ALBUMID=${release}`,
    "-metadata", `MUSICBRAINZ_TRACKID=${recording(2)}`, filePath]);
  await scanMusicRoot({ rootPath: root, filePaths: [filePath], source: "aurral" });
  invalidateAllDownloadStatusesCache();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM library_albums WHERE identity_key = ?")
    .get(`release-group:${release}`).count, 0);
  assert.equal(db.prepare("SELECT album_id FROM library_media_files WHERE path = ?").get(filePath).album_id, album.id);
  assert.equal(await status(), "complete");
});

test("an album scanned with its release ID queues by release group and cancels its older jobs", async () => {
  const releaseGroup = "cdcdcdcd-cdcd-4dcd-8dcd-000000000001";
  const release = "cdcdcdcd-cdcd-4dcd-8dcd-000000000002";
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "mbid:cdcdcdcd-cdcd-4dcd-8dcd-000000000003",
    mbid: "cdcdcdcd-cdcd-4dcd-8dcd-000000000003", name: "Legacy Artist" });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${releaseGroup}`, mbid: release,
    releaseGroupMbid: releaseGroup, artistId: artist.id, title: "Legacy Album" });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const track = libraryStore.upsertLibraryTrack({ identityKey: "recording:cdcdcdcd-cdcd-4dcd-8dcd-100000000001",
    mbid: "cdcdcdcd-cdcd-4dcd-8dcd-100000000001", title: "Legacy Song", artistName: artist.name });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  setDownloadSourceConfigured(true);
  const originalWorkerStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const queued = await libraryManager.searchAurralAlbumMissingTracks(album.id);
    assert.deepEqual(queued.jobIds.map((id) => downloadTracker.getJob(id).albumMbid), [releaseGroup]);
  } finally {
    downloadWorker.start = originalWorkerStart;
    setDownloadSourceConfigured(false);
  }
  const legacyJobId = downloadTracker.addJob({ artistName: artist.name, trackName: "Legacy Song",
    albumName: "Legacy Album", albumMbid: release, trackMbid: track.mbid, managedBy: "aurral",
    requestGroupId: "legacy" }, "library");

  const cancelled = await callRoute("POST /albums/aurral/:canonicalId/cancel", { canonicalId: String(album.id) });
  assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));
  assert.equal(downloadTracker.getJob(legacyJobId).status, "cancelled");
});
