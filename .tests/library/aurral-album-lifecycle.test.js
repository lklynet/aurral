import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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
  { clearMetadataProviderCaches },
  { db },
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
  "backend/services/providers/brainzmashProvider.js",
  "backend/config/db-sqlite.js",
);

const { downloadTracker, DownloadTracker } = trackerModule;

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

let albumSequence = 0;
function createLibraryAlbum({ managedBy = "aurral", trackCount = 3, availableTracks = 0 } = {}) {
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
    mbid: albumMbid,
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
  const jobFor = (index, requestGroupId = `group-${albumSequence}`) =>
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
      },
      "library",
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
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
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

test("album status aggregates library availability and per-track jobs", async () => {
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
    const { album } = createLibraryAlbum();
    const batch = await callRoute(
      "GET /downloads/status",
      {},
      {},
      { albumIds: `aurral:${album.id},aurral:not-a-number` },
    );
    assert.equal(batch.statusCode, 200);
    assert.equal(batch.body[`aurral:${album.id}`].status, "missing");
    assert.equal(batch.body["aurral:not-a-number"], undefined);
    assert.equal(lidarrCalls.length, 0);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.request = originalRequest;
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

test("active downloads list in-flight albums, artists, and tracks so buttons survive a reload", async () => {
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
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.request = originalRequest;
    invalidateAllDownloadStatusesCache();
  }
});

test("an album asks for its most common edition and a whole shorter edition completes it", async (t) => {
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
  clearMetadataProviderCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.after(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearMetadataProviderCaches();
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
  const filePaths = [];
  for (const [song, position] of [[2, 1], [3, 2]]) {
    const filePath = path.join(folder, `0${position} Edition Song ${song}.flac`);
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac", "-metadata", `title=Edition Song ${song}`,
      "-metadata", "artist=Edition Artist", "-metadata", `track=${position}`, "-metadata", `disc=${position}`,
      filePath]);
    filePaths.push(filePath);
  }
  await finishAlbumGrab({ jobId: ids[0], albumGrab: true, albumGroupJobIds: ids, source: "slskd",
    playlistId: "library" }, { filePaths, source: "soulseek" });
  assert.deepEqual(ids.map((id) => downloadTracker.getJob(id).status), ["cancelled", "done", "done"]);
  assert.deepEqual(ids.slice(1).map((id) => path.basename(downloadTracker.getJob(id).finalPath)),
    ["01 - Edition Song 2.flac", "02 - Edition Song 3.flac"]);

  await scanMusicRoot({ rootPath: resolveDownloadRoot(), source: "aurral" });
  invalidateAllDownloadStatusesCache();
  const status = await callRoute("GET /albums/aurral/:canonicalId/status",
    { canonicalId: String(requested.body.album.id) });
  assert.equal(status.body.status, "complete");
  assert.equal(status.body.counts.total, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM library_album_tracks WHERE album_id = ?")
    .get(requested.body.album.id).count, 3);
});

test("settling an album on an edition leaves a track another album has monitored", () => {
  const albumMbid = "ffffffff-ffff-4fff-8fff-000000000001";
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "mbid:ffffffff-ffff-4fff-8fff-000000000002",
    mbid: "ffffffff-ffff-4fff-8fff-000000000002", name: "Shared Artist" });
  const albumFor = (identityKey, title, mbid = null) => libraryStore.upsertLibraryAlbum({
    identityKey, mbid, releaseGroupMbid: mbid, artistId: artist.id, title });
  const album = albumFor(`release-group:${albumMbid}`, "Shared Album", albumMbid);
  const single = albumFor("release-group:ffffffff-ffff-4fff-8fff-000000000003", "Shared Single");
  const tracks = [1, 2].map((index) => libraryStore.upsertLibraryTrack({
    identityKey: `recording:ffffffff-ffff-4fff-8fff-10000000000${index}`,
    mbid: `ffffffff-ffff-4fff-8fff-10000000000${index}`, title: `Shared Song ${index}`,
  }));
  tracks.forEach((track, index) => libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id,
    trackNumber: index + 1 }));
  libraryStore.linkLibraryAlbumTrack({ albumId: single.id, trackId: tracks[1].id, trackNumber: 1 });
  libraryManager.unmonitorAlbumOnlyTracks(albumMbid, tracks.map((track) => track.mbid));
  const monitored = (track) => db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(track.id).monitored;
  assert.deepEqual(tracks.map(monitored), [0, 1]);
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
