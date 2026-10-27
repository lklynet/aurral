import { test, beforeEach, afterAll, vi, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { LibraryMediaFilesRow, LibraryTracksRow } from "../../backend/db/rows.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "../helpers/backendTestHarness.ts";
import { listen, signedInAs } from "../helpers/honoApp.ts";

const [
  isolatedState,
  trackerModule,
  cancellation,
  libraryStore,
  managementStore,
  { api },
  { invalidateAllDownloadStatusesCache },
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
  { getMetadataBaseUrl },
  { setMetadataProviderCooldown },
] = await setupIsolatedBackend(
  "aurral-album-lifecycle",
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/routes/library/handlers/downloads.ts"),
  () => import("../../backend/services/downloadFolderConfig.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/albumGrab.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/apiClients/clearCache.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/releaseResolver.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/services/metadataProviderBudget.ts"),
);
// Unit tests are offline, so the default metadata provider refuses lookups up front
// instead of making each one wait its turn in the provider's rate limit.
setMetadataProviderCooldown(getMetadataBaseUrl(), 403, Number.MAX_SAFE_INTEGER);

const { downloadTracker, DownloadTracker } = trackerModule;
const history = await import("../../backend/services/aurralHistoryService.ts");
const testUser = (
  id: number,
  role: string,
  permissions: RequestUser["permissions"] = {},
): RequestUser => ({
  id,
  username: "test",
  role,
  permissions,
});
let requestUser = testUser(1, "admin");
const server = await listen(signedInAs(() => requestUser).route("/api", api));
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
// The payload of a Soulseek folder the release judge verified before download.
async function verifiedGrab(ids: string[]) {
  return {
    jobId: ids[0],
    albumGrab: true,
    albumGroupJobIds: ids,
    source: "slskd",
    playlistId: "library",
    releaseMbid: (await resolveReleaseManifest(getJob(ids[0])))?.releaseMbid ?? null,
    candidate: { releaseVerified: true, raw: { user: "peer", files: [] } },
  };
}

async function apiRequest<Body = ApiBody>(route: string, method: string = "GET") {
  const response = await fetch(`${baseUrl}${route}`, { method });
  const body: Body = await response.json();
  return { status: response.status, body };
}

const libraryApp = signedInAs(testUser(1, "admin")).route("/", api);

async function callRoute<Body = RouteBody>(route: string, method: string = "GET", body?: object) {
  const response = await libraryApp.request(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json: Body = await response.json();
  return { status: response.status, body: json };
}

async function callRouteAsWebProcess<Body = RouteBody>(
  _t: TestContext,
  ...args: Parameters<typeof callRoute>
) {
  const statement = Object.getPrototypeOf(db.prepare("SELECT 1"));
  const reads = ["all", "get", "iterate"].map((method) => vi.spyOn(statement, method));
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await callRoute<Body>(...args);
    const jobReads = reads
      .flatMap((read) => read.mock.contexts)
      .filter((statement) => /\bplaylist_download_jobs\b/.test(statement.source));
    return { response, jobReads: jobReads.length };
  } finally {
    process.env.NODE_ENV = previousMode;
    for (const read of reads) read.mockRestore();
  }
}

let albumSequence = 0;
function createLibraryAlbum({
  managedBy = "aurral",
  trackCount = 3,
  availableTracks = 0,
  releaseMbid,
}: {
  trackCount?: number;
  availableTracks?: number;
  managedBy?: string;
  releaseMbid?: string;
} = {}) {
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
    libraryStore.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      trackNumber: index + 1,
    });
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
  const jobFor = (
    index: number,
    job: Partial<Parameters<typeof downloadTracker.addJob>[0]> = {},
    playlistType: string = "library",
  ) => {
    return addJob(
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
  };
  return { album, albumMbid, artistMbid, tracks, jobFor };
}

function addAlbumJob(trackName: string, requestGroupId = "group-1") {
  return addJob(
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

beforeEach(() => {
  downloadTracker.clearAll();
  requestUser = testUser(1, "admin");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

test("cancelling one Library download preserves monitoring and rejects finished work", async () => {
  const fixture = createLibraryAlbum();
  const pending = fixture.jobFor(0);
  const untouched = fixture.jobFor(1);
  const cancelled = await apiRequest(`/api/playlists/jobs/${pending}/cancel`, "POST");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(getJob(pending).status, "cancelled");
  assert.equal(getJob(untouched).status, "pending");
  assert.equal(
    db
      .prepare<unknown[], Pick<LibraryTracksRow, "monitored">>(
        "SELECT monitored FROM library_tracks WHERE id = ?",
      )
      .get(fixture.tracks[0].id)?.monitored,
    1,
  );
  const finished = fixture.jobFor(2);
  downloadTracker.setDone(finished, "/disposable/finished.flac");
  assert.equal((await apiRequest(`/api/playlists/jobs/${finished}/cancel`, "POST")).status, 409);
  assert.equal(getJob(finished).status, "done");
  assert.equal(
    (await apiRequest(`/api/playlists/flows/library/tracks/${pending}/research`, "POST")).status,
    409,
  );
  assert.equal(getJob(pending).status, "cancelled");
});

test("a Library requester can cancel without flow permission and cannot cancel another requester's song", async () => {
  const fixture = createLibraryAlbum();
  const own = fixture.jobFor(0);
  const other = fixture.jobFor(1);
  history.recordTrackJobQueued(getJob(own), { id: 3, username: "owner", role: "user" });
  history.recordTrackJobQueued(getJob(other), { id: 4, username: "other", role: "user" });
  history.recordTrackJobSearching(getJob(own));
  requestUser = testUser(3, "user");
  assert.equal((await apiRequest(`/api/playlists/jobs/${other}/cancel`, "POST")).status, 403);
  assert.equal((await apiRequest("/api/playlists/jobs/unknown-job/cancel", "POST")).status, 404);
  assert.equal((await apiRequest(`/api/playlists/jobs/${own}/cancel`, "POST")).status, 200);
  assert.equal(getJob(own).status, "cancelled");
  assert.equal(getJob(other).status, "pending");
});

test("a Library requester can retry failed and stalled downloads without duplicating active work", async () => {
  await downloadWorker.stopAndDrain();
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const fixture = createLibraryAlbum();
  const failed = fixture.jobFor(0);
  const stalled = fixture.jobFor(1);
  const other = fixture.jobFor(2);
  history.recordTrackJobQueued(getJob(failed), { id: 3, username: "owner", role: "user" });
  history.recordTrackJobQueued(getJob(stalled), { id: 3, username: "owner", role: "user" });
  history.recordTrackJobQueued(getJob(other), { id: 4, username: "other", role: "user" });
  downloadTracker.setDownloading(failed);
  downloadTracker.setFailed(failed, "Provider lost the request");
  history.recordTrackJobFailed(getJob(failed), "Provider lost the request");
  downloadTracker.setDownloading(stalled);
  history.recordTrackJobDownloading(getJob(stalled));

  requestUser = testUser(3, "user");
  assert.equal((await apiRequest(`/api/playlists/jobs/${other}/retry`, "POST")).status, 403);

  const failedRetry = await apiRequest(`/api/playlists/jobs/${failed}/retry`, "POST");
  assert.deepEqual(failedRetry.body, { jobId: failed, status: "pending", retried: true });
  assert.equal(getJob(failed).status, "pending");
  assert.equal(getJob(failed).retryCycle, true);
  assert.equal(cancellation.isDownloadJobCancelled(failed), false);

  const stalledRetry = await apiRequest(`/api/playlists/jobs/${stalled}/retry`, "POST");
  assert.deepEqual(stalledRetry.body, { jobId: stalled, status: "pending", retried: true });
  assert.equal(getJob(stalled).status, "pending");
  assert.equal(getJob(stalled).retryCycle, true);
  assert.equal(cancellation.isDownloadJobCancelled(stalled), false);

  const activity = await apiRequest<ActivityRow[]>("/api/requests?refresh=1");
  for (const jobId of [failed, stalled]) {
    const row = activityFor(activity.body, jobId);
    assert.equal(row.status, "processing");
    assert.equal(row.statusLabel, "Searching");
  }
});

test("album-grab request rows include canonical ids and request groups", async () => {
  const fixture = createLibraryAlbum({ trackCount: 2 });
  const ids = [fixture.jobFor(0), fixture.jobFor(1)];
  history.recordAlbumRequested({
    albumId: fixture.album.id,
    albumName: fixture.album.title,
    managedBy: "aurral",
    requestGroupId: getJob(ids[0]).requestGroupId,
  });
  const { recordAlbumGrabQueued } = await import("../../backend/services/albumGrabActivity.ts");
  recordAlbumGrabQueued(
    { albumGrab: true, jobId: ids[0], albumGroupJobIds: ids },
    ids.map((id) => getJob(id)),
  );
  const response = await apiRequest<ActivityRow[]>("/api/requests?refresh=1");
  assert.equal(response.status, 200);
  const rows = response.body.filter((item) => ids.some((id) => id === item.jobId));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.canonicalAlbumId, String(fixture.album.id));
    assert.equal(row.albumGrab.canonicalAlbumId, String(fixture.album.id));
    assert.equal(row.requestGroupId, getJob(row.jobId).requestGroupId);
  }
  const albumRequest = response.body.find(
    (item) => item.kind === "album_requested" && item.albumId === String(fixture.album.id),
  );
  assert.ok(albumRequest);
  assert.equal(albumRequest.canonicalAlbumId, String(fixture.album.id));
  assert.equal(albumRequest.requestGroupId, getJob(ids[0]).requestGroupId);
});

test("track cancellation keeps failed provider cleanup pending and succeeds after recovery", async () => {
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.setDownloading(id);
  downloadTracker.updateDownloadMetadata(id, {
    downloadSource: "usenet",
    downloadClient: "sabnzbd",
    downloadClientId: "disposable-queue",
  });
  const first = await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "cancel_requested");
  assert.equal(first.body.cleanupFailed, true);
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("sabnzbd");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  vi.spyOn(client, "deleteQueueItem").mockImplementation(async () => true);
  vi.spyOn(client, "deleteHistoryItem").mockImplementation(async () => true);
  const recovered = await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST");
  assert.equal(recovered.body.status, "cancelled");
  assert.equal(recovered.body.cleanupFailed, false);
  assert.equal(
    db
      .prepare<unknown[], Pick<LibraryTracksRow, "monitored">>(
        "SELECT monitored FROM library_tracks WHERE id = ?",
      )
      .get(fixture.tracks[0].id)?.monitored,
    1,
  );
});

test("retry keeps a cancelled queued job blocked until provider cleanup succeeds", async () => {
  await downloadWorker.stopAndDrain();
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.updateDownloadMetadata(id, {
    downloadSource: "usenet",
    downloadClient: "sabnzbd",
    downloadClientId: "disposable-queue",
  });

  const cancelled = await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST");
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.cleanupFailed, true);

  const blockedRetry = await apiRequest(`/api/playlists/jobs/${id}/retry`, "POST");
  assert.equal(blockedRetry.status, 409);
  assert.equal(blockedRetry.body.cleanupFailed, true);
  assert.equal(getJob(id).status, "cancelled");
  assert.equal(cancellation.isDownloadJobCancelled(id), true);

  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("sabnzbd");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  vi.spyOn(client, "deleteQueueItem").mockImplementation(async () => true);
  vi.spyOn(client, "deleteHistoryItem").mockImplementation(async () => true);

  const recoveredRetry = await apiRequest(`/api/playlists/jobs/${id}/retry`, "POST");
  assert.deepEqual(recoveredRetry.body, { jobId: id, status: "pending", retried: true });
  assert.equal(getJob(id).status, "pending");
  assert.equal(cancellation.isDownloadJobCancelled(id), false);
});

test("retry keeps a failed job blocked until its provider request is cleaned up", async () => {
  await downloadWorker.stopAndDrain();
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.setDownloading(id);
  downloadTracker.updateDownloadMetadata(id, {
    downloadSource: "usenet",
    downloadClient: "sabnzbd",
    downloadClientId: "still-running-nzb",
  });
  downloadTracker.setFailed(id, "Usenet client remained unreadable");

  const blockedRetry = await apiRequest(`/api/playlists/jobs/${id}/retry`, "POST");
  assert.equal(blockedRetry.status, 409);
  assert.equal(blockedRetry.body.cleanupFailed, true);
  assert.equal(getJob(id).status, "failed");
  assert.equal(cancellation.isDownloadJobCancelled(id), true);

  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("sabnzbd");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  vi.spyOn(client, "deleteQueueItem").mockImplementation(async () => true);
  vi.spyOn(client, "deleteHistoryItem").mockImplementation(async () => true);

  const recoveredRetry = await apiRequest(`/api/playlists/jobs/${id}/retry`, "POST");
  assert.deepEqual(recoveredRetry.body, { jobId: id, status: "pending", retried: true });
  assert.equal(getJob(id).status, "pending");
  assert.equal(cancellation.isDownloadJobCancelled(id), false);
});

test("track cancellation respects private flow ownership", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const flow = flowPlaylistConfig.createFlow({
    name: "Private cancellation fixture",
    ownerUserId: 4,
  });
  const id = addJob({ artistName: "Artist", trackName: "Private song" }, flow.id);
  requestUser = testUser(3, "user", { accessFlow: true });
  assert.equal((await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).status, 404);
  assert.equal(getJob(id).status, "pending");
  requestUser = testUser(4, "user", { accessFlow: true });
  assert.equal((await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).status, 200);
});

test("cancelling an album leader keeps its held peer and shared transfer running", async () => {
  const fixture = createLibraryAlbum({ trackCount: 2 });
  const leader = fixture.jobFor(0);
  const peer = fixture.jobFor(1);
  downloadTracker.setDownloading(leader);
  downloadTracker.setDownloading(peer);
  downloadTracker.markSlskdDispatched(leader);
  downloadTracker.updateDownloadMetadata(leader, {
    downloadSource: "deemix",
    downloadClientId: "shared-transfer",
  });
  const honker = await import("../../backend/services/honkerDb.ts");
  const payload = {
    jobId: leader,
    playlistId: "library",
    playlistGeneration: 0,
    phase: "poll",
    albumGrab: true,
    albumGroupJobIds: [leader, peer],
    queueUuid: "shared-transfer",
  };
  honker.getPipelineQueue().enqueue(payload);
  const response = await apiRequest(`/api/playlists/jobs/${leader}/cancel`, "POST");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "cancelled");
  assert.equal(getJob(peer).status, "downloading");
  assert.equal(getJob(peer).downloadClientId, "shared-transfer");
  const { resolveTransferredDownloadPayload } =
    await import("../../backend/services/downloadJobs/downloadOwnership.ts");
  const continued = resolveTransferredDownloadPayload(payload);
  assert.equal(continued.jobId, peer);
  assert.equal(cancellation.isPipelinePayloadActive(continued), true);
  assert.ok(honker.listHonkerJobs("slskd-pipeline").some((row) => row.payload?.jobId === peer));
});

test("restarting a held album track detaches it from the previous shared attempt", async () => {
  await downloadWorker.stopAndDrain();
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const fixture = createLibraryAlbum({ trackCount: 2 });
  const leader = fixture.jobFor(0);
  const peer = fixture.jobFor(1);
  downloadTracker.setDownloading(leader);
  downloadTracker.setDownloading(peer);
  const attempt = cancellation.beginDownloadAttempt(leader);
  cancellation.setActiveDownloadAttemptId(peer, attempt);
  const honker = await import("../../backend/services/honkerDb.ts");
  const payload = {
    jobId: leader,
    playlistId: "library",
    playlistGeneration: 0,
    downloadAttemptId: attempt,
    phase: "poll",
    albumGrab: true,
    albumGroupJobIds: [leader, peer],
  };
  honker.getPipelineQueue().enqueue(payload);

  const retried = await apiRequest(`/api/playlists/jobs/${peer}/retry`, "POST");
  assert.deepEqual(retried.body, { jobId: peer, status: "pending", retried: true });
  assert.equal(cancellation.getActiveDownloadAttemptId(peer), null);
  const { heldAlbumGrabJobs } = await import("../../backend/services/albumGrab.ts");
  assert.deepEqual(
    heldAlbumGrabJobs(payload).map((job) => job.id),
    [leader],
  );
});

test("a cancelled single song can be searched again and the worker takes it", async () => {
  setDownloadSourceConfigured(false);
  const id = addJob({ artistName: "Single Artist", trackName: "Single song" }, "library");
  assert.equal(
    (await apiRequest(`/api/playlists/jobs/${id}/cancel`, "POST")).body.status,
    "cancelled",
  );
  const { processPlaylistOperation } =
    await import("../../backend/services/playlists/playlistOperations.ts");
  try {
    const result = await processPlaylistOperation({
      kind: "shared-playlist-research-track",
      playlistId: "library",
      jobId: id,
    });
    assert.partialDeepStrictEqual(result, { success: true });
    await downloadWorker.waitForIdle();
    assert.equal(getJob(id).status, "failed");
  } finally {
    await downloadWorker.stopAndDrain();
  }
});

test("requeueing a Library job refreshes the cached activity response", async () => {
  await downloadWorker.stopAndDrain();
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  downloadTracker.setFailed(id, "No match");
  history.recordTrackJobFailed(getJob(id), "No match");
  const before = await apiRequest<ActivityRow[]>("/api/requests?refresh=1");
  assert.equal(activityFor(before.body, id).status, "failed");
  const { processPlaylistOperation } =
    await import("../../backend/services/playlists/playlistOperations.ts");
  const result = await processPlaylistOperation({
    kind: "shared-playlist-research-track",
    playlistId: "library",
    jobId: id,
  });
  assert.partialDeepStrictEqual(result, { success: true });
  try {
    const after = await apiRequest<ActivityRow[]>("/api/requests");
    assert.equal(activityFor(after.body, id).status, "processing");
  } finally {
    await downloadWorker.stopAndDrain();
  }
});

test("the web activity cache notices job changes committed by another process", async () => {
  const fixture = createLibraryAlbum();
  const id = fixture.jobFor(0);
  history.recordTrackJobQueued(getJob(id));
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
    const before = await apiRequest<ActivityRow[]>("/api/requests?refresh=1");
    assert.equal(activityFor(before.body, id).status, "pending");
    await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      isolatedState.dbPath,
      id,
    ]);
    assert.equal(getJob(id).status, "done");
    const after = await apiRequest<ActivityRow[]>("/api/requests");
    assert.equal(activityFor(after.body, id).status, "completed");
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
    const job = restarted.getJob(id);
    assert.ok(job);
    assert.equal(job.status, status, job.trackName ?? "");
  }
  assert.deepEqual(
    restarted
      .getPending(10)
      .map((job) => job.id)
      .sort(),
    [pending, interrupted].sort(),
  );

  downloadTracker.resetDownloadingToPending();
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(getJob(id).status, status, getJob(id).trackName ?? "");
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
  assert.equal(getJob(id).status, "cancel_requested");
  assert.equal(getJob(id).error, null);

  downloadTracker.setCancelled(id);
  downloadTracker.setDownloading(id);
  assert.equal(getJob(id).status, "cancelled");
  assert.equal(downloadTracker.getNextPending(), null);

  cancellation.restoreDownloadJobCancellations([id]);
  assert.equal(downloadTracker.setPending(id, "Retrying", { asRetryCycle: true }), true);
  assert.equal(getJob(id).status, "pending");
  assert.equal(downloadTracker.getNextPending()?.id, id);
});

test("cancelling an Aurral album stops active work, cleans staging, and keeps finished tracks", async () => {
  const lidarrCalls: unknown[][] = [];
  vi.spyOn(lidarrClient, "request").mockImplementation(async (...args) => {
    lidarrCalls.push(args);
    throw new Error("Lidarr must not be called");
  });
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
    const cancelled = await callRoute(`/library/albums/aurral/${album.id}/cancel`, "POST");
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body.cancelledJobIds.sort(), [downloadingJob, pendingJob].sort());
    assert.equal(getJob(doneJob).status, "done");
    assert.equal(getJob(downloadingJob).status, "cancelled");
    assert.equal(getJob(pendingJob).status, "cancelled");
    assert.equal(getJob(downloadingJob).error, null);
    await assert.rejects(fs.access(stagingPath));
    assert.equal(downloadTracker.getNextPending(), null);

    const repeated = await callRoute(`/library/albums/aurral/${album.id}/cancel`, "POST");
    assert.equal(repeated.status, 200);
    assert.deepEqual([...repeated.body.cancelledJobIds], []);
    assert.equal(lidarrCalls.length, 0);
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true });
  }
});

test("album cancellation rejects unknown, malformed, and Lidarr-managed albums", async () => {
  const { album: lidarrAlbum, jobFor } = createLibraryAlbum({
    managedBy: "lidarr",
    availableTracks: 1,
  });
  const lidarrJob = jobFor(1);

  const missing = await callRoute("/library/albums/aurral/999999/cancel", "POST");
  assert.equal(missing.status, 404);
  const malformed = await callRoute("/library/albums/aurral/12abc/cancel", "POST");
  assert.equal(malformed.status, 400);
  const conflict = await callRoute(`/library/albums/aurral/${lidarrAlbum.id}/cancel`, "POST");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "album_owner_conflict");
  assert.equal(conflict.body.managedBy, "lidarr");
  assert.equal(getJob(lidarrJob).status, "pending");
});

test("album cancellation waits on provider cleanup without reviving the job", async () => {
  const { album, jobFor } = createLibraryAlbum();
  const jobId = jobFor(0);
  downloadTracker.setDownloading(jobId);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "unconfigured-sabnzbd-item",
  });

  const cancelled = await callRoute(`/library/albums/aurral/${album.id}/cancel`, "POST");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cleanupFailed, true);
  assert.equal(getJob(jobId).status, "cancel_requested");

  downloadTracker.setFailed(jobId, "late provider error");
  assert.equal(getJob(jobId).status, "cancel_requested");
  assert.equal(new DownloadTracker().getJob(jobId)!.status, "cancelled");
});

function setDownloadSourceConfigured(configured: boolean) {
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
  const lidarrCalls: unknown[][] = [];
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => false);
  vi.spyOn(lidarrClient, "request").mockImplementation(async (...args) => {
    lidarrCalls.push(args);
    throw new Error("Lidarr must not be called");
  });
  setDownloadSourceConfigured(true);

  type Scenario = {
    name: string;
    jobs: (string | null)[];
    status: string;
    availableTracks?: number;
    recovery?: string;
    sourceConfigured?: boolean;
  };
  const albumKeys = new Map<string, string>();
  const keyFor = (scenario: Scenario) => {
    const key = albumKeys.get(scenario.name);
    assert.ok(key);
    return key;
  };
  const scenarios: Scenario[] = [
    { name: "complete", availableTracks: 3, jobs: [], status: "complete" },
    { name: "queued", jobs: ["pending", "pending", "pending"], status: "queued" },
    { name: "downloading", jobs: ["downloading", "pending", "pending"], status: "downloading" },
    {
      name: "cancelling",
      jobs: ["cancel_requested", "cancelled", "cancelled"],
      status: "downloading",
    },
    {
      name: "cancelled",
      availableTracks: 1,
      jobs: [null, "cancelled", "cancelled"],
      status: "cancelled",
    },
    {
      name: "blocked",
      jobs: ["blocked", "failed", "failed"],
      status: "blocked",
      recovery: "review_required",
    },
    {
      name: "failed",
      jobs: ["failed", "failed", "failed"],
      status: "failed",
      recovery: "source_failed",
    },
    {
      name: "partial",
      availableTracks: 2,
      jobs: [null, null, "failed"],
      status: "partial",
      recovery: "source_failed",
    },
    { name: "missing", jobs: [], status: "missing" },
    {
      name: "no source",
      jobs: [],
      status: "blocked",
      recovery: "download_source_missing",
      sourceConfigured: false,
    },
  ];

  try {
    for (const scenario of scenarios) {
      setDownloadSourceConfigured(scenario.sourceConfigured !== false);
      const { album, jobFor } = createLibraryAlbum({
        availableTracks: scenario.availableTracks || 0,
      });
      albumKeys.set(scenario.name, `aurral:${album.id}`);
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

      const response = await callRoute(`/library/albums/aurral/${album.id}/status`);
      assert.equal(response.status, 200, scenario.name);
      assert.equal(response.body.status, scenario.status, scenario.name);
      assert.equal(response.body.managedBy, "aurral", scenario.name);
      assert.equal(response.body.counts.total, 3, scenario.name);
      assert.equal(response.body.recovery?.code ?? null, scenario.recovery ?? null, scenario.name);
      if (scenario.recovery) assert.ok(response.body.recovery?.message, scenario.name);
    }

    setDownloadSourceConfigured(true);
    const { album: lidarrAlbum } = createLibraryAlbum({ managedBy: "lidarr" });
    const polled = scenarios.filter((scenario) => scenario.sourceConfigured !== false);
    const query = new URLSearchParams({
      albumIds: [
        ...polled.map((scenario) => keyFor(scenario)),
        `aurral:${lidarrAlbum.id}`,
        "aurral:not-a-number",
      ].join(","),
    });
    const batch = await callRoute<AlbumStatuses>(`/library/downloads/status?${query}`);
    assert.equal(batch.status, 200);
    assert.deepEqual(
      Object.keys(batch.body).sort(),
      polled.map((scenario) => keyFor(scenario)).sort(),
    );
    for (const scenario of polled) {
      assert.equal(batch.body[keyFor(scenario)].status, scenario.status, scenario.name);
      assert.equal(
        batch.body[keyFor(scenario)].recovery?.code ?? null,
        scenario.recovery ?? null,
        scenario.name,
      );
    }
    const { response: webBatch } = await callRouteAsWebProcess<AlbumStatuses>(
      t,
      `/library/downloads/status?${query}`,
    );
    assert.deepEqual(webBatch.body, batch.body);
    assert.equal(lidarrCalls.length, 0);
  } finally {
    setDownloadSourceConfigured(false);
  }
});

test("a download status poll finds album jobs under either album ID in any spelling and reads jobs once", async (t) => {
  setDownloadSourceConfigured(true);
  try {
    const legacy = createLibraryAlbum({
      trackCount: 2,
      releaseMbid: "abcdabcd-abcd-4bcd-8bcd-000000000001",
    });
    const releaseMbid = legacy.album.mbid;
    const olderJobs = [legacy.jobFor(0, { albumMbid: releaseMbid }), legacy.jobFor(1)];
    legacy.jobFor(0);
    legacy.jobFor(1, { albumMbid: releaseMbid });
    olderJobs.forEach((jobId) => downloadTracker.setFailed(jobId, "No matching source result"));

    const spelled = createLibraryAlbum({ trackCount: 2 });
    const paddedJob = spelled.jobFor(0, { albumMbid: spelled.albumMbid.toUpperCase() });
    spelled.jobFor(1, { albumMbid: spelled.albumMbid.toUpperCase() });
    downloadTracker.setDownloading(paddedJob);

    const untouched = createLibraryAlbum({ trackCount: 2 });
    untouched.jobFor(0, { managedBy: "lidarr" });
    untouched.jobFor(1, {}, "discover");

    db.prepare(
      "UPDATE playlist_download_jobs SET created_at = created_at - 60000 WHERE id IN (?, ?)",
    ).run(...olderJobs);
    db.prepare("UPDATE playlist_download_jobs SET album_mbid = ? WHERE id = ?").run(
      ` ${spelled.albumMbid.toUpperCase()}\t`,
      paddedJob,
    );
    downloadTracker.reconcileCommittedJobs();

    const keys = [legacy, spelled, untouched].map(({ album }) => `aurral:${album.id}`);
    const query = new URLSearchParams({ albumIds: keys.join(",") });
    const expected = {
      [keys[0]]: { status: "queued", pending: 2, failed: 0 },
      [keys[1]]: { status: "downloading", pending: 1, downloading: 1 },
      [keys[2]]: { status: "missing", missing: 2, pending: 0 },
    };
    const poll = await callRoute<AlbumStatuses>(`/library/downloads/status?${query}`);
    const webPoll = await callRouteAsWebProcess<AlbumStatuses>(
      t,
      `/library/downloads/status?${query}`,
    );
    const singleAlbumPoll = await callRouteAsWebProcess<AlbumStatuses>(
      t,
      `/library/downloads/status?${new URLSearchParams({ albumIds: keys[0] })}`,
    );

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
  const request = () => addAurralAlbum(artistMbid, albumMbid, album.title);

  try {
    setDownloadSourceConfigured(false);
    const blocked = await request();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.albumStatus.status, "blocked");
    assert.equal(blocked.albumStatus.recovery?.code, "download_source_missing");
    assert.deepEqual([...blocked.jobIds], []);
    assert.equal(albumJobs().length, 0);

    setDownloadSourceConfigured(true);
    const queued = await request();
    assert.equal(queued.albumStatus.status, "queued");
    assert.equal(queued.jobIds.length, 3);

    downloadTracker.setDownloading(queued.jobIds[0]);
    downloadTracker.setFailed(queued.jobIds[1], "No matching source result");
    await libraryManager.cancelAurralAlbum(album.id);
    assert.equal(getJob(queued.jobIds[0]).status, "cancelled");
    assert.equal(getJob(queued.jobIds[1]).status, "failed");

    const retried = await request();
    assert.deepEqual([...retried.jobIds].sort(), [...queued.jobIds].sort());
    assert.equal(albumJobs().length, 3);
    for (const jobId of queued.jobIds) {
      assert.equal(getJob(jobId).status, "pending");
    }
    assert.equal(retried.albumStatus.status, "queued");

    downloadTracker.setFailed(queued.jobIds[0], "Source failed after retry");
    assert.equal(getJob(queued.jobIds[0]).status, "failed");
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

  const result = await addAurralAlbum(artistMbid, albumMbid, album.title);
  assert.equal(result.status, "blocked");
  assert.equal(result.albumStatus.status, "blocked");
  assert.equal(result.albumStatus.recovery?.code, "download_source_missing");
  assert.equal(getJob(jobId).status, "failed");
});

test("active downloads list in-flight albums, artists, and tracks so buttons survive a reload", async (t) => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "request").mockImplementation(async (endpoint) => {
    if (endpoint.startsWith("/queue")) {
      return [{ albumId: 7, status: "downloading", size: 100, sizeleft: 40 }];
    }
    if (endpoint.startsWith("/history")) return { records: [] };
    if (endpoint.startsWith("/command")) return [];
    if (endpoint.startsWith("/album")) {
      return [
        { id: 7, foreignAlbumId: "lidarr-album", artist: { foreignArtistId: "lidarr-artist" } },
        {
          id: 8,
          foreignAlbumId: "lidarr-idle-album",
          artist: { foreignArtistId: "lidarr-idle-artist" },
        },
      ];
    }
    return [];
  });
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

    addJob(
      {
        artistName: "Single Artist",
        trackName: "Single Track",
        albumMbid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        artistMbid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        trackMbid: "single-track-mbid",
      },
      "library",
    );
    addJob(
      { artistName: "Flow Artist", trackName: "Flow Track", trackMbid: "flow-track-mbid" },
      "discover",
    );

    const response = await callRoute<ActiveDownloadsBody>("/library/downloads/active");
    assert.equal(response.status, 200);
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
      [
        queuedAlbum.tracks[0].trackMbid,
        queuedAlbum.tracks[1].trackMbid,
        "single-track-mbid",
      ].sort(),
    );
    const { response: webResponse } = await callRouteAsWebProcess<ActiveDownloadsBody>(
      t,
      "/library/downloads/active",
    );
    assert.deepEqual(webResponse.body, response.body);
  } finally {
    invalidateAllDownloadStatusesCache();
  }
});

test("an album asks for its most common edition and a shorter download leaves its missing tracks wanted", async (t: TestContext) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000001";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000002";
  const recording = (index: number) => `eeeeeeee-eeee-4eee-8eee-10000000000${index}`;
  const release = (id: string, count: number, perDisc: number = count) => ({
    id,
    status: "Official",
    tracks: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      recordingid: recording(index + 1),
      trackname: `Edition Song ${index + 1}`,
      artistid: artistMbid,
      durationms: 1000,
      trackposition: (index % perDisc) + 1,
      mediumnumber: Math.floor(index / perDisc) + 1,
    })),
  });
  const standard = {
    id: "standard",
    status: "Official",
    tracks: release("standard", 3)
      .tracks.slice(1)
      .map((track, index) => ({ ...track, trackposition: index + 1 })),
  };
  const misprint = {
    id: "misprint",
    status: "Official",
    tracks: release("misprint", 3)
      .tracks.reverse()
      .map((track, index) => ({ ...track, trackposition: index + 1 })),
  };
  const releases = [
    standard,
    misprint,
    release("deluxe-vinyl", 3, 2),
    release("deluxe", 3),
    release("box-set", 4),
  ];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: albumMbid,
        title: "Edition Album",
        artistid: artistMbid,
        artists: [{ id: artistMbid, artistname: "Edition Artist" }],
        releases,
      }),
    );
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadata.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.onTestFinished(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute<RequestedAlbumBody>("/library/albums/request", "POST", {
    albumMbid,
    albumName: "Edition Album",
    artistMbid,
    artistName: "Edition Artist",
    managedBy: "aurral",
  });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  const ids = requested.body.jobIds;
  assert.deepEqual(
    ids.map((id) => [getJob(id).trackNumber, getJob(id).trackName]),
    [
      [1, "Edition Song 1"],
      [2, "Edition Song 2"],
      [3, "Edition Song 3"],
    ],
  );

  const folder = path.join(isolatedState.baseDir, "edition-download");
  await fs.mkdir(folder, { recursive: true });
  const writeSong = async (song: number, position: number) => {
    const filePath = path.join(folder, `0${position} Edition Song ${song}.flac`);
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "flac",
      "-metadata",
      `title=Edition Song ${song}`,
      "-metadata",
      "artist=Edition Artist",
      "-metadata",
      `track=${position}`,
      filePath,
    ]);
    return filePath;
  };
  const grab = await verifiedGrab(ids);
  assert.equal(grab.releaseMbid, "deluxe");
  const shorter = [await writeSong(2, 1), await writeSong(3, 2)];
  await finishAlbumGrab(
    { ...grab, source: "usenet", candidate: { raw: { release: { guid: "shorter" } } } },
    { filePaths: shorter, source: "usenet" },
  );
  assert.deepEqual(
    ids.map((id) => getJob(id).status),
    ["pending", "pending", "pending"],
  );
  assert.deepEqual(
    ids.map((id) => getJob(id).deniedRemoteSources),
    ids.map(() => [["usenet", "shorter"]]),
  );

  for (const id of ids) downloadTracker.setDownloading(id);
  const next = await finishAlbumGrab(grab, {
    filePaths: [await writeSong(2, 2), await writeSong(3, 3)],
    source: "soulseek",
  });
  assert.ok(next != null);
  assert.deepEqual([next.jobId, next.albumGrab, next.phase], [ids[0], false, "search"]);
  assert.deepEqual(
    ids.map((id) => getJob(id).status),
    ["downloading", "done", "done"],
  );
  assert.deepEqual(
    ids.slice(1).map((id) => finalName(id)),
    ["02 - Edition Song 2.flac", "03 - Edition Song 3.flac"],
  );
  assert.equal(
    db
      .prepare<unknown[], Pick<LibraryTracksRow, "monitored">>(
        "SELECT monitored FROM library_tracks WHERE mbid = ?",
      )
      .pluck()
      .get(recording(1)),
    1,
  );

  await scanMusicRoot({ rootPath: resolveDownloadRoot(), source: "aurral" });
  invalidateAllDownloadStatusesCache();
  const status = await callRoute(`/library/albums/aurral/${requested.body.album.id}/status`);
  assert.notEqual(status.body.status, "complete");
  assert.equal(status.body.counts.total, 3);
});

test("an album that wants the expanded edition keeps wanting the extra track a download lacks", async (t: TestContext) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000021";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000022";
  const release = (id: string, count: number) => ({
    id,
    status: "Official",
    tracks: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      recordingid: `eeeeeeee-eeee-4eee-8eee-30000000000${index + 1}`,
      trackname: `Expanded Song ${index + 1}`,
      artistid: artistMbid,
      durationms: 1000,
      trackposition: index + 1,
      mediumnumber: 1,
    })),
  });
  const releases = [
    release("cd", 2),
    release("digital", 2),
    release("deluxe", 3),
    release("box-set", 7),
  ];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: albumMbid,
        title: "Expanded Album",
        artistid: artistMbid,
        artists: [{ id: artistMbid, artistname: "Expanded Artist" }],
        releases,
      }),
    );
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadata.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  const defaults = libraryManager.getMonitoringDefaultsState().rules;
  libraryManager.setMonitoringDefaults({ ...defaults, edition: "expanded" });
  let ids: string[] = [];
  t.onTestFinished(async () => {
    for (const id of ids) {
      if (getJob(id)?.status === "pending") downloadTracker.setCancelled(id);
    }
    libraryManager.setMonitoringDefaults(defaults);
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute<RequestedAlbumBody>("/library/albums/request", "POST", {
    albumMbid,
    albumName: "Expanded Album",
    artistMbid,
    artistName: "Expanded Artist",
    managedBy: "aurral",
  });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  ids = requested.body.jobIds;
  assert.deepEqual(
    ids.map((id) => getJob(id).trackName),
    ["Expanded Song 1", "Expanded Song 2", "Expanded Song 3"],
  );
  assert.deepEqual(
    ids.map((id) => getJob(id).releaseMbid),
    ["deluxe", "deluxe", "deluxe"],
  );

  const folder = path.join(isolatedState.baseDir, "expanded-download");
  await fs.mkdir(folder, { recursive: true });
  const filePaths: string[] = [];
  for (const song of [1, 2]) {
    const filePath = path.join(folder, `0${song} Expanded Song ${song}.flac`);
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "flac",
      "-metadata",
      `title=Expanded Song ${song}`,
      "-metadata",
      "artist=Expanded Artist",
      "-metadata",
      `track=${song}`,
      filePath,
    ]);
    filePaths.push(filePath);
  }
  await finishAlbumGrab(await verifiedGrab(ids), { filePaths, source: "soulseek" });
  assert.deepEqual(
    ids.map((id) => getJob(id).status),
    ["done", "done", "pending"],
  );
  const missing = db
    .prepare<unknown[], Pick<LibraryTracksRow, "monitored">>(
      "SELECT monitored FROM library_tracks WHERE mbid = ?",
    )
    .get("eeeeeeee-eeee-4eee-8eee-300000000003");
  assert.equal(missing?.monitored, 1);
});

test("a two-disc album downloads a title it repeats on each disc to two names", async (t: TestContext) => {
  const artistMbid = "dddddddd-dddd-4ddd-8ddd-000000000001";
  const albumMbid = "dddddddd-dddd-4ddd-8ddd-000000000002";
  const tracklist = [
    [1, 1, "Bomb"],
    [1, 2, "Swim"],
    [2, 1, "Bomb"],
    [2, 2, "Little Things"],
  ];
  const recording = (index: number) => `dddddddd-dddd-4ddd-8ddd-10000000000${index}`;
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: albumMbid,
        title: "Disc Album",
        artistid: artistMbid,
        artists: [{ id: artistMbid, artistname: "Disc Artist" }],
        releases: [
          {
            id: "two-disc",
            status: "Official",
            tracks: tracklist.map(([disc, position, title], index) => ({
              id: `two-disc-${index}`,
              recordingid: recording(index),
              trackname: title,
              artistid: artistMbid,
              durationms: 1000,
              trackposition: position,
              mediumnumber: disc,
            })),
          },
        ],
      }),
    );
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadata.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.onTestFinished(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute<RequestedAlbumBody>("/library/albums/request", "POST", {
    albumMbid,
    albumName: "Disc Album",
    artistMbid,
    artistName: "Disc Artist",
    managedBy: "aurral",
  });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  const ids = requested.body.jobIds;
  assert.deepEqual(
    ids.map((id) => [getJob(id).discNumber, getJob(id).trackNumber]),
    tracklist.map(([disc, position]) => [disc, position]),
  );

  const folder = path.join(isolatedState.baseDir, "two-disc-download");
  await fs.mkdir(folder, { recursive: true });
  const filePaths: string[] = [];
  for (const [index, [disc, position, title]] of tracklist.entries()) {
    const filePath = path.join(folder, `${disc}-0${position} ${title}.flac`);
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "flac",
      "-metadata",
      `title=${title}`,
      "-metadata",
      "artist=Disc Artist",
      "-metadata",
      `track=${position}`,
      "-metadata",
      `disc=${disc}`,
      "-metadata",
      `MUSICBRAINZ_TRACKID=${recording(index)}`,
      filePath,
    ]);
    filePaths.push(filePath);
  }
  await finishAlbumGrab(await verifiedGrab(ids), { filePaths, source: "soulseek" });
  assert.deepEqual(
    ids.map((id) => [getJob(id).status, finalName(id)]),
    [
      ["done", "01 - Bomb.flac"],
      ["done", "02 - Swim.flac"],
      ["done", "2-01 - Bomb.flac"],
      ["done", "2-02 - Little Things.flac"],
    ],
  );
});

test("an album asks for its release's own lengths and fills a missing one from pressings of the same recordings", async (t: TestContext) => {
  const artistMbid = "eeeeeeee-eeee-4eee-8eee-000000000011";
  const albumMbid = "eeeeeeee-eeee-4eee-8eee-000000000012";
  const pressing = (id: string, lengths: (number | null)[], recording: number = 2) => ({
    id,
    status: "Official",
    tracks: lengths.map((durationms, index) => ({
      id: `${id}-${index}`,
      recordingid: `eeeeeeee-eeee-4eee-8eee-${recording}0000000000${index + 1}`,
      trackname: `Pressing Song ${index + 1}`,
      artistid: artistMbid,
      durationms,
      trackposition: index + 1,
      mediumnumber: 1,
    })),
  });
  const releases = [
    pressing("vinyl", [296000, null]),
    pressing("cd", [301106, 254893]),
    pressing("digital", [301000, 254000]),
    pressing("rerecorded", [247000, 208000], 3),
  ];
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: albumMbid,
        title: "Pressing Album",
        artistid: artistMbid,
        artists: [{ id: artistMbid, artistname: "Pressing Artist" }],
        releases,
      }),
    );
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadata.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.onTestFinished(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });

  const requested = await callRoute<RequestedAlbumBody>("/library/albums/request", "POST", {
    albumMbid,
    albumName: "Pressing Album",
    artistMbid,
    artistName: "Pressing Artist",
    managedBy: "aurral",
  });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.deepEqual(
    requested.body.jobIds.map((id) => getJob(id).durationMs),
    [296000, 254447],
  );
});

test("asking for an album downloads the missing tracks of the edition its track list shows", async (t: TestContext) => {
  const artistMbid = "1a1a1a1a-1a1a-4a1a-8a1a-000000000011";
  const albumMbid = "1a1a1a1a-1a1a-4a1a-8a1a-000000000012";
  const recording = (index: number) => `1a1a1a1a-1a1a-4a1a-8a1a-20000000000${index}`;
  const release = (id: string, recordings: number[]) => ({
    id,
    status: "Official",
    tracks: recordings.map((recordingIndex, index) => ({
      id: `${id}-${index}`,
      recordingid: recording(recordingIndex),
      trackname: `Listed Song ${index + 1}`,
      artistid: recordingIndex === 3 ? "1a1a1a1a-1a1a-4a1a-8a1a-000000000013" : artistMbid,
      durationms: 1000,
      trackposition: index + 1,
      mediumnumber: 1,
    })),
  });
  const metadata = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== `/album/${albumMbid}`) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: albumMbid,
        title: "Listed Album",
        artistid: artistMbid,
        artists: [
          { id: artistMbid, artistname: "Listed Artist" },
          { id: "1a1a1a1a-1a1a-4a1a-8a1a-000000000013", artistname: "Listed Guest" },
        ],
        releases: [
          release("listed-standard", [1, 4]),
          release("listed-reissue", [1, 4]),
          release("listed-deluxe", [1, 2, 3]),
        ],
      }),
    );
  });
  const originalSettings = dbOps.getSettings();
  const originalWorkerStart = downloadWorker.start;
  const originalIsConfigured = lidarrClient.isConfigured;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadata.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => false;
  t.onTestFinished(async () => {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearApiCaches();
    await metadata.close();
  });
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Listed Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: "listed-deluxe",
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: "Listed Album",
    metadata: { monitored: false },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
  });
  const owned = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${recording(1)}`,
    mbid: recording(1),
    title: "Listed Song 1",
    monitored: false,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: owned.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: owned.id,
    albumId: album.id,
    source: "aurral",
    path: path.join(isolatedState.baseDir, "listed", "01 Listed Song 1.flac"),
  });
  libraryStore.storeLibraryAlbumTrackList(album.id, {
    release: {
      id: "listed-deluxe",
      tracks: [1, 2, 3].map((index) => ({
        id: `listed-deluxe-${index}`,
        recordingId: recording(index),
        oldRecordingIds: [],
        title: `Listed Song ${index}`,
        mediumNumber: 1,
        trackNumber: index,
        trackPosition: index,
        durationMs: null,
        artistId: null,
      })),
    },
  });

  const requested = await callRoute<RequestedAlbumBody>("/library/albums/request", "POST", {
    albumMbid,
    albumName: "Listed Album",
    artistMbid,
    artistName: "Listed Artist",
    managedBy: "aurral",
  });

  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.deepEqual(
    requested.body.jobIds.map((id) => getJob(id).trackName),
    ["Listed Song 2", "Listed Song 3"],
  );
  assert.equal(
    db
      .prepare<unknown[], number>("SELECT COUNT(*) FROM library_album_tracks WHERE album_id = ?")
      .pluck()
      .get(album.id),
    3,
  );
  assert.deepEqual(
    requested.body.jobIds.map((id) => getJob(id).releaseMbid),
    ["listed-deluxe", "listed-deluxe"],
  );
  assert.equal(
    db
      .prepare<unknown[], Pick<LibraryTracksRow, "artist_name">>(
        "SELECT artist_name FROM library_tracks WHERE mbid = ?",
      )
      .pluck()
      .get(recording(3)),
    "Listed Guest",
  );

  db.prepare(
    "UPDATE library_albums SET metadata_json = json_set(metadata_json, '$.trackList.release', 'listed-standard') WHERE id = ?",
  ).run(album.id);
  const job = getJob(requested.body.jobIds[1]);
  const manifest = await resolveReleaseManifest({ ...job, releaseMbid: null });
  assert.ok(manifest != null);
  assert.equal(manifest.releaseMbid, "listed-deluxe");
  assert.deepEqual(
    manifest.tracks.map((track) => track.artists),
    [["Listed Artist"], ["Listed Artist"], ["Listed Guest"]],
  );
  assert.equal(
    await resolveReleaseManifest({
      ...job,
      releaseMbid: null,
      trackName: "Listed Song 4",
      trackMbid: recording(4),
      trackNumber: 2,
    }),
    null,
  );
});

test("an album scanned with its release ID stays one album through downloads and scans", async () => {
  setDownloadSourceConfigured(true);
  const releaseGroup = "abababab-abab-4bab-8bab-000000000001";
  const release = "abababab-abab-4bab-8bab-000000000002";
  const recording = (index: number) => `abababab-abab-4bab-8bab-10000000000${index}`;
  const root = path.join(isolatedState.baseDir, "release-keyed");
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:abababab-abab-4bab-8bab-000000000003",
    mbid: "abababab-abab-4bab-8bab-000000000003",
    name: "Release Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${releaseGroup}`,
    mbid: release,
    releaseGroupMbid: releaseGroup,
    artistId: artist.id,
    title: "Release Album",
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
  });
  const tracks = [1, 2].map((index) =>
    libraryStore.upsertLibraryTrack({
      identityKey: `recording:${recording(index)}`,
      mbid: recording(index),
      title: `Release Song ${index}`,
      artistName: artist.name,
    }),
  );
  tracks.forEach((track, index) =>
    libraryStore.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      trackNumber: index + 1,
    }),
  );
  libraryStore.upsertLibraryMediaFile({
    trackId: tracks[0].id,
    albumId: album.id,
    source: "aurral",
    path: path.join(root, "Release Artist", "Release Album", "01 - Release Song 1.flac"),
  });
  const jobId = addJob(
    {
      artistName: artist.name,
      trackName: "Release Song 2",
      albumName: "Release Album",
      albumMbid: release,
      trackMbid: recording(2),
      managedBy: "aurral",
      requestGroupId: "release-keyed",
    },
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, path.join(root, "elsewhere.flac"));
  const status = async () =>
    (await callRoute(`/library/albums/aurral/${album.id}/status`)).body.status;

  const duplicate = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${release}`,
    mbid: release,
    releaseGroupMbid: release,
    artistId: artist.id,
    title: "Release Album",
  });
  libraryStore.linkLibraryAlbumTrack({
    albumId: duplicate.id,
    trackId: tracks[1].id,
    trackNumber: 2,
  });
  const filePath = path.join(root, "Release Artist", "Release Album", "02 - Release Song 2.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    "1",
    "-c:a",
    "flac",
    "-metadata",
    "title=Release Song 2",
    "-metadata",
    "artist=Release Artist",
    "-metadata",
    "album=Release Album",
    "-metadata",
    `MUSICBRAINZ_RELEASEGROUPID=${release}`,
    "-metadata",
    `MUSICBRAINZ_ALBUMID=${release}`,
    "-metadata",
    `MUSICBRAINZ_TRACKID=${recording(2)}`,
    filePath,
  ]);
  await scanMusicRoot({ rootPath: root, filePaths: [filePath], source: "aurral" });
  invalidateAllDownloadStatusesCache();
  assert.equal(
    db
      .prepare<unknown[], { count: number }>(
        "SELECT COUNT(*) AS count FROM library_albums WHERE identity_key = ?",
      )
      .get(`release-group:${release}`)!.count,
    0,
  );
  assert.equal(
    db
      .prepare<unknown[], Pick<LibraryMediaFilesRow, "album_id">>(
        "SELECT album_id FROM library_media_files WHERE path = ?",
      )
      .get(filePath)!.album_id,
    album.id,
  );
  assert.equal(await status(), "complete");
});

test("an album scanned with its release ID queues by release group and cancels its older jobs", async () => {
  const releaseGroup = "cdcdcdcd-cdcd-4dcd-8dcd-000000000001";
  const release = "cdcdcdcd-cdcd-4dcd-8dcd-000000000002";
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:cdcdcdcd-cdcd-4dcd-8dcd-000000000003",
    mbid: "cdcdcdcd-cdcd-4dcd-8dcd-000000000003",
    name: "Legacy Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${releaseGroup}`,
    mbid: release,
    releaseGroupMbid: releaseGroup,
    artistId: artist.id,
    title: "Legacy Album",
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "recording:cdcdcdcd-cdcd-4dcd-8dcd-100000000001",
    mbid: "cdcdcdcd-cdcd-4dcd-8dcd-100000000001",
    title: "Legacy Song",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  setDownloadSourceConfigured(true);
  const originalWorkerStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const queued = await libraryManager.searchAurralAlbumMissingTracks(album.id);
    assert.ok(queued.jobIds);
    assert.deepEqual(
      queued.jobIds.map((id) => getJob(id).albumMbid),
      [releaseGroup],
    );
  } finally {
    downloadWorker.start = originalWorkerStart;
    setDownloadSourceConfigured(false);
  }
  const legacyJobId = addJob(
    {
      artistName: artist.name,
      trackName: "Legacy Song",
      albumName: "Legacy Album",
      albumMbid: release,
      trackMbid: track.mbid,
      managedBy: "aurral",
      requestGroupId: "legacy",
    },
    "library",
  );

  const cancelled = await callRoute(`/library/albums/aurral/${album.id}/cancel`, "POST");
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(getJob(legacyJobId).status, "cancelled");
});

async function addAurralAlbum(artistMbid: string, albumMbid: string, albumName: string) {
  const result = await libraryManager.addAlbum(artistMbid, albumMbid, albumName, {
    managedBy: "aurral",
  });
  const { albumStatus, jobIds } = result;
  assert.ok(albumStatus && jobIds, JSON.stringify(result));
  return { ...result, albumStatus, jobIds };
}

function addJob(...args: Parameters<typeof downloadTracker.addJob>) {
  const jobId = downloadTracker.addJob(...args);
  assert.ok(jobId);
  return jobId;
}

function finalName(id: string) {
  return path.basename(getJob(id).finalPath ?? "");
}

function activityFor(rows: ActivityRow[], jobId: string) {
  const row = rows.find((item) => item.jobId === jobId);
  assert.ok(row, `Expected activity row for ${jobId}`);
  return row;
}

function getJob(id: string) {
  const job = downloadTracker.getJob(id);
  assert.ok(job, `Expected download job ${id}`);
  return job;
}

type ApiBody = { status: string; cleanupFailed: boolean };
type ActivityRow = {
  jobId: string;
  kind: string;
  status: string;
  statusLabel: string;
  albumId: string;
  canonicalAlbumId: string;
  requestGroupId: string;
  albumGrab: { canonicalAlbumId: string };
};
type RouteBody = {
  status: string;
  managedBy: string;
  code: string;
  counts: Record<string, number>;
  recovery?: { code: string; message: string } | null;
  cancelledJobIds: string[];
  cleanupFailed: boolean;
};
type AlbumStatuses = Record<string, RouteBody>;
type RequestedAlbumBody = { album: { id: number }; jobIds: string[] };
type ActiveDownloadsBody = { albums: string[]; artists: string[]; tracks: { mbid: string }[] };
