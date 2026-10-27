import { audioMetadata } from "./fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import express from "express";
import { NavidromeClient } from "../../backend/services/navidrome.ts";
import { createPlaybackPlaylistSnapshot } from "../../backend/services/playback/playbackDestination.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { downloadTracker },
  cancellationModule,
  { flowPlaylistConfig },
  { playlistManager },
  { downloadWorker },
  { queueQualityUpgrade },
  { handToHono },
  { processPlaylistOperation },
  libraryStore,
  downloadUtils,
  { hasApprovalFollowUps },
  { processPipelineJob },
  { withPlaylistMutationLock },
  { scanMusicRoot },
  { getPlaybackTaskQueue, listHonkerJobs },
  { processSystemTask },
] = await setupIsolatedBackend(
  "approved-import-path",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/qualityProfileService.ts"),
  () => import("../../backend/routes/shared/expressHandoff.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/downloadUtils.ts"),
  () => import("../../backend/services/downloadJobs/blockedJobReview.ts"),
  () => import("../../backend/services/downloadPipelineWorker.ts"),
  () => import("../../backend/services/downloadJobs/mutationGuards.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
);

function takePlaylistSyncs() {
  const jobs = listHonkerJobs("playback").filter(
    (job) => job.payload!.kind === "playback-playlist-sync",
  );
  for (const job of jobs) getPlaybackTaskQueue().cancel(job.id);
  return jobs.map((job) => job.payload);
}

const {
  activatePlaylistDownloadGeneration,
  cancelPlaylistDownloadGeneration,
  getPlaylistDownloadGeneration,
  isPipelinePayloadActive,
  withPipelineCommitLock,
  clearDownloadProviderWork,
  listDownloadProviderWork,
  registerDownloadProviderWork,
} = cancellationModule;

const app = express();
type ListedJob = {
  id: string;
  artistName: string;
  trackName: string;
  status: string;
  libraryOwned?: boolean;
  qualityOwned?: boolean;
  qualityState?: string | null;
  upgradeForJobId?: string | null;
};

const admin: RequestUser = { id: 1, username: "admin", role: "admin", permissions: {} };
let requestUser = admin;
app.use((req, _res, next) => {
  req.user = requestUser;
  next();
});
app.use("/api/playlists", handToHono);
const server = await new Promise<
  import("node:http").Server<
    typeof import("node:http").IncomingMessage,
    typeof import("node:http").ServerResponse
  >
>((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${listeningAddress(server).port}/api/playlists`;

playlistManager.navidromeDestination.client = Object.assign(
  new NavidromeClient("http://navidrome.test", "user", "password"),
  {
    isConfigured: () => true,
    async ensureAurralLibrary() {
      return null;
    },
    async getPlaylists() {
      return [];
    },
    async getPlaylistTrackPaths() {
      return [];
    },
    async findSong() {
      return { id: "reviewed-song" };
    },
    async createPlaylist(name: string) {
      return { id: name, name };
    },
    async updatePlaylist() {},
    async deletePlaylist() {
      return {};
    },
    async scanLibrary() {
      return null;
    },
  },
);

async function waitForApprovalFollowUps() {
  while (hasApprovalFollowUps()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

afterEach(waitForApprovalFollowUps);

beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.mkdir(process.env.DOWNLOAD_FOLDER!, { recursive: true });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {},
    downloadFolderPath: process.env.DOWNLOAD_FOLDER!,
    playlistArtwork: { style: "aurral" },
  });
});

test("playlist jobs annotate tracks that are already in the library", async () => {
  const playlistId = "library-ownership-annotation";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Library ownership",
    tracks: [
      { artistName: "Owned Artist", trackName: "Owned Track", trackMbid: "owned-mbid" },
      { artistName: "Owned Artist", trackName: "Featured Track" },
      { artistName: "Owned Artist feat. Guest", trackName: "Featured Track" },
      { artistName: "Missing Artist", trackName: "Missing Track", trackMbid: "missing-mbid" },
    ],
  });
  const ownedArtist = libraryStore.upsertLibraryArtist({
    identityKey: "owned-playlist-artist",
    name: "Owned Artist",
  });
  const ownedAlbum = libraryStore.upsertLibraryAlbum({
    identityKey: "owned-playlist-album",
    artistId: ownedArtist.id,
    title: "Owned Album",
  });
  const ownedTrack = libraryStore.upsertLibraryTrack({
    identityKey: "owned-playlist-track",
    mbid: "owned-mbid",
    title: "Owned Track",
    artistName: "Owned Artist",
  });
  libraryStore.linkLibraryAlbumTrack({
    albumId: ownedAlbum.id,
    trackId: ownedTrack.id,
    trackNumber: 1,
  });
  libraryStore.upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: ownedAlbum.id,
    source: "aurral",
    path: "/library/Owned Artist/Owned Album/Owned Track.flac",
    available: true,
  });
  const root = path.join(isolatedState.baseDir, "featured-library");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "01.flac"), "featured audio");
  await scanMusicRoot({
    rootPath: root,
    source: "lidarr",
    metadataReader: async () =>
      audioMetadata({
        common: {
          albumartist: "Owned Artist",
          artist: "Owned Artist feat. Guest",
          album: "Featured Album",
          title: "Featured Track",
        },
      }),
  });
  downloadTracker.addJobs(
    [
      { artistName: "Owned Artist", trackName: "Owned Track", trackMbid: "owned-mbid" },
      { artistName: "Owned Artist", trackName: "Featured Track" },
      { artistName: "Owned Artist feat. Guest", trackName: "Featured Track" },
      { artistName: "Missing Artist", trackName: "Missing Track", trackMbid: "missing-mbid" },
    ],
    playlistId,
  );

  const response = await fetch(`${baseUrl}/jobs/${playlistId}`);
  const payload: ListedJob[] = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(
    payload.map((job) => [job.artistName, job.trackName, job.libraryOwned]),
    [
      ["Owned Artist", "Owned Track", true],
      ["Owned Artist", "Featured Track", true],
      ["Owned Artist feat. Guest", "Featured Track", true],
      ["Missing Artist", "Missing Track", false],
    ],
  );
});

test("playlist job file paths are only returned to admins", async (t: import("vite-plus/test").TestContext) => {
  const playlistId = "job-file-paths";
  flowPlaylistConfig.createStaticPlaylist({ id: playlistId, name: "File paths", tracks: [] });
  const [jobId] = downloadTracker.addJobs(
    [{ artistName: "Path Artist", trackName: "Path Track" }],
    playlistId,
  );
  const finalPath = path.join(process.env.DOWNLOAD_FOLDER!, "Path Artist", "Path Track.FLAC");
  downloadTracker.setDownloading(jobId, path.join(process.env.DOWNLOAD_FOLDER!, "staging.flac"));
  downloadTracker.setDone(jobId, finalPath, "Path Album");
  t.onTestFinished(() => {
    requestUser = admin;
  });

  const listed = await (await fetch(`${baseUrl}/jobs/${playlistId}`)).json();
  const [allListed] = await (await fetch(`${baseUrl}/jobs`)).json();
  for (const job of [listed[0], allListed]) {
    assert.equal(job.id, jobId);
    assert.equal(job.streamFormat, "flac");
    assert.deepEqual(
      Object.keys(job).filter((key) => /path$/i.test(key)),
      [],
    );
  }

  const adminResponse = await fetch(`${baseUrl}/jobs/${jobId}/files`);
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(await adminResponse.json(), { paths: [finalPath] });

  requestUser = { id: 2, username: "listener", role: "user", permissions: { accessFlow: true } };
  const userResponse = await fetch(`${baseUrl}/jobs/${jobId}/files`);
  assert.equal(userResponse.status, 403);
  assert.equal(JSON.stringify(await userResponse.json()).includes(finalPath), false);

  requestUser = admin;
  assert.equal((await fetch(`${baseUrl}/jobs/missing-job/files`)).status, 404);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("approving a reviewed download commits it inside the managed playlist library", async () => {
  const playlistId = "40ae99ad-92b0-48c6-93e7-7b39e76703ea";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Reviewed",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Album" }],
  });
  const sourcePath = path.join(isolatedState.baseDir, "review", "Track.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", sourcePath);

  const response = await fetch(`${baseUrl}/jobs/${jobId}/approve`, { method: "POST" });
  const payload = await response.json();
  const expectedPath = path.join(process.env.DOWNLOAD_FOLDER!, "Artist", "Album", "Track.flac");

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.path, expectedPath);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "reviewed audio");
  await waitForApprovalFollowUps();
  await assert.rejects(fs.access(path.join(playlistManager.libraryRoot, "Reviewed.m3u")));
});

test("approving a reviewed download queues its playlist sync instead of waiting on the media server", async () => {
  takePlaylistSyncs();
  const playlistId = "reviewed-slow-publish";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Reviewed slow publish",
    tracks: [{ artistName: "Artist", trackName: "Slow Track", albumName: "Album" }],
  });
  const sourcePath = path.join(isolatedState.baseDir, "review", "Slow Track.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Slow Track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", sourcePath);
  const serverCalls = vi
    .spyOn(playlistManager.navidromeDestination.client!, "getPlaylists")
    .mockImplementation(() => new Promise(() => {}));

  const response = await fetch(`${baseUrl}/jobs/${jobId}/approve`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  await waitForApprovalFollowUps();
  let changed = false;
  await withPlaylistMutationLock(playlistId, () => {
    changed = true;
  });

  assert.equal(changed, true);
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
  assert.equal(serverCalls.mock.calls.length, 0);
  assert.deepEqual(takePlaylistSyncs(), [
    { kind: "playback-playlist-sync", entityIds: [playlistId], attempt: 0 },
  ]);
});

test("approving a library track does not wait for another library track's download step", async (t: import("vite-plus/test").TestContext) => {
  const sourcePath = path.join(isolatedState.baseDir, "review", "Library review.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  const searchingJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Still searching", albumName: "Album" },
    "library",
  );
  const reviewedJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Library review", albumName: "Album" },
    "library",
  );
  assert.ok(reviewedJobId != null);
  downloadTracker.setBlocked(reviewedJobId, "blocked-duration-mismatch", sourcePath);
  const stepStarted = Promise.withResolvers<void>();
  const releaseStep = Promise.withResolvers<void>();
  t.onTestFinished(() => releaseStep.resolve());
  const step = processPipelineJob(
    {
      phase: "search",
      jobId: searchingJobId,
      playlistId: "library",
      playlistGeneration: trackedJob(downloadTracker, searchingJobId).playlistGeneration,
    },
    {
      async processPipelinePayload() {
        stepStarted.resolve();
        await releaseStep.promise;
        return null;
      },
      async continuePipeline() {},
    },
  );

  try {
    await stepStarted.promise;
    const response = await fetch(`${baseUrl}/jobs/${reviewedJobId}/approve`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(downloadTracker.getJob(reviewedJobId)?.status, "done");
    assert.equal(
      await fs.readFile(trackedJob(downloadTracker, reviewedJobId).finalPath!, "utf8"),
      "reviewed audio",
    );
  } finally {
    releaseStep.resolve();
    await step;
  }
});

test("a track committed after an approved review joins the same pending playlist sync", async () => {
  const playlistId = "reviewed-concurrent-commit";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Reviewed concurrent commit",
    tracks: [
      { artistName: "Artist", trackName: "Reviewed", albumName: "Album" },
      { artistName: "Artist", trackName: "Pipeline", albumName: "Album" },
      { artistName: "Artist", trackName: "Still pending", albumName: "Album" },
    ],
  });
  const sourcePath = path.join(isolatedState.baseDir, "review", "Reviewed.flac");
  const pipelinePath = path.join(process.env.DOWNLOAD_FOLDER!, "Artist", "Album", "Pipeline.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(pipelinePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  await fs.writeFile(pipelinePath, "pipeline audio");
  const reviewedJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Reviewed", albumName: "Album" },
    playlistId,
  );
  assert.ok(reviewedJobId != null);
  const pipelineJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Pipeline", albumName: "Album" },
    playlistId,
  );
  assert.ok(pipelineJobId != null);
  createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Still pending", albumName: "Album" },
    playlistId,
  );
  downloadTracker.setBlocked(reviewedJobId, "blocked-duration-mismatch", sourcePath);

  takePlaylistSyncs();
  const published: string[][] = [];
  vi.spyOn(playlistManager.navidromeDestination, "publishPlaylist").mockImplementation(
    async (snapshot) => {
      assert.ok(snapshot != null);
      if (snapshot.entityId === playlistId) assert.ok(snapshot != null);
      published.push(createPlaybackPlaylistSnapshot(snapshot).tracks.map((track) => track.path));
      return { ok: true };
    },
  );

  const response = await fetch(`${baseUrl}/jobs/${reviewedJobId}/approve`, { method: "POST" });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  await waitForApprovalFollowUps();
  downloadTracker.setDownloading(pipelineJobId, pipelinePath);
  downloadTracker.setDone(pipelineJobId, pipelinePath, "Album");
  playlistManager.requestPlaylistSync([playlistId]);
  const syncs = takePlaylistSyncs();
  assert.deepEqual(syncs, [
    { kind: "playback-playlist-sync", entityIds: [playlistId], attempt: 0 },
  ]);
  await processSystemTask(syncs[0]);

  assert.equal(published.length, 1);
  assert.ok(published[0].includes(pipelinePath), JSON.stringify(published));
  const reviewedPath = trackedJob(downloadTracker, reviewedJobId).finalPath;
  assert.ok(reviewedPath != null);
  assert.ok(published[0].includes(reviewedPath), JSON.stringify(published));
});

test("approval cannot commit an orphaned job into a recreated playlist", async () => {
  const playlistId = "reviewed-stale-generation";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Reviewed stale generation",
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  cancelPlaylistDownloadGeneration(playlistId);
  const cancelledGeneration = getPlaylistDownloadGeneration(playlistId);

  const sourcePath = path.join(isolatedState.baseDir, "review", "Stale Track.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Stale Track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", sourcePath);

  assert.equal(activatePlaylistDownloadGeneration(playlistId), cancelledGeneration + 1);

  const response = await fetch(`${baseUrl}/jobs/${jobId}/approve`, { method: "POST" });
  const payload = await response.json();
  const expectedPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "Artist",
    "Album",
    "Stale Track.flac",
  );

  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(downloadTracker.getJob(jobId)?.status, "blocked");
  assert.equal(await fs.readFile(sourcePath, "utf8"), "reviewed audio");
  await assert.rejects(fs.access(expectedPath));
});

test("clearing all jobs waits for an in-flight playlist import to finish", async () => {
  const playlistId = "clear-all-import-race";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  const payload = {
    jobId,
    playlistId,
    playlistGeneration: trackedJob(downloadTracker, jobId).playlistGeneration,
  };
  const sourcePath = path.join(isolatedState.baseDir, "clear-all-race", "Track.flac");
  const finalPath = path.join(process.env.DOWNLOAD_FOLDER!, "clear-all-race", "Track.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "downloaded audio");

  let enterCommit!: () => void;
  let releaseCommit!: () => void;
  const commitEntered = new Promise<void>((resolve) => {
    enterCommit = resolve;
  });
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const commitPromise = withPipelineCommitLock(payload, async () => {
    enterCommit();
    await commitGate;
    const committedPath = await downloadUtils.commitDownloadedFile(sourcePath, finalPath);
    assert.equal(downloadTracker.setDone(jobId, committedPath, "Album"), true);
    return committedPath;
  });
  await commitEntered;

  const clearPromise = fetch(`${baseUrl}/jobs/all`, { method: "DELETE" });
  let concurrentJobId: string | null;
  let watching = true;
  try {
    const state = await Promise.race([
      (async () => {
        while (watching) {
          if (!isPipelinePayloadActive(payload)) return "cancelled";
          if (!downloadTracker.getJob(jobId)) return "deleted";
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })(),
      clearPromise.then(() => "responded"),
    ]);

    assert.equal(state, "cancelled");
    assert.ok(trackedJob(downloadTracker, jobId));
    concurrentJobId = createTrackedJob(
      downloadTracker,
      { artistName: "Another Artist", trackName: "Another Track" },
      "created-during-clear",
    );
  } finally {
    watching = false;
    releaseCommit();
    await Promise.allSettled([commitPromise, clearPromise]);
  }

  const [commitResult, clearResponse] = await Promise.all([commitPromise, clearPromise]);
  const clearPayload = await clearResponse.json();

  assert.equal(commitResult.cancelled, false);
  assert.equal(clearResponse.status, 200, JSON.stringify(clearPayload));
  assert.equal(await fs.readFile(finalPath, "utf8"), "downloaded audio");
  assert.equal(downloadTracker.getJob(jobId), null);
  assert.ok(trackedJob(downloadTracker, concurrentJobId));
  downloadTracker.removeJob(concurrentJobId);
});

test("failed clear-all leaves jobs stopped and visible so provider cleanup can be retried", async () => {
  const playlistId = "clear-all-provider-failure";
  const originalSettings = dbOps.getSettings();
  let providerStatus = 503;
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(providerStatus);
    response.end();
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Provider failure song" },
    playlistId,
  );
  assert.ok(jobId != null);
  registerDownloadProviderWork({
    jobId,
    playlistId,
    provider: "slskd-search",
    workId: "clear-all-retry-search",
  });
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
    },
  });

  try {
    const failedResponse = await fetch(`${baseUrl}/jobs/all`, { method: "DELETE" });
    const failedPayload = await failedResponse.json();
    const stoppedJob = downloadTracker.getJob(jobId);
    assert.ok(stoppedJob != null);

    assert.equal(failedResponse.status, 500);
    assert.match(failedPayload.error, /stopped in Aurral and marked failed/i);
    assert.equal(stoppedJob.status, "failed");
    assert.match(stoppedJob.error!, /provider cancellation pending/i);
    assert.equal(isPipelinePayloadActive({ jobId, playlistId, playlistGeneration: 0 }), false);
    assert.equal(listDownloadProviderWork({ jobIds: [jobId] }).length, 1);

    providerStatus = 204;
    const retryResponse = await fetch(`${baseUrl}/jobs/all`, { method: "DELETE" });
    const retryPayload = await retryResponse.json();
    assert.equal(retryResponse.status, 200, JSON.stringify(retryPayload));
    assert.equal(retryPayload.cleared, 1);
    assert.equal(downloadTracker.getJob(jobId), null);
    assert.equal(listDownloadProviderWork({ jobIds: [jobId] }).length, 0);
  } finally {
    dbOps.updateSettings(originalSettings);
    clearDownloadProviderWork({ provider: "slskd-search", workId: "clear-all-retry-search" });
    downloadTracker.removeJob(jobId);
    await mock.close();
  }
});

test("approving a reviewed upgrade replaces the source playlist file", async () => {
  const scan = vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);
  const flow = flowPlaylistConfig.createFlow({
    name: "Reviewed upgrade flow",
    size: 10,
    mix: { discover: 100 },
    scheduleDays: [1],
  });
  const originalPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "_flows",
    flow.id,
    "Artist",
    "Album",
    "Track.mp3",
  );
  const candidatePath = path.join(isolatedState.baseDir, "review", "Track.flac");
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.writeFile(originalPath, "original audio");
  await fs.writeFile(candidatePath, "upgrade audio");

  const sourceJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    flow.id,
  );
  assert.ok(sourceJobId != null);
  downloadTracker.setDone(sourceJobId, originalPath, "Album");
  downloadTracker.updateQuality(sourceJobId, { tier: "mp3-128", format: "mp3" });
  const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, sourceJobId));
  assert.ok(upgradeJobId != null);
  downloadTracker.setBlocked(upgradeJobId, "blocked-duration-mismatch", candidatePath);

  const response = await fetch(`${baseUrl}/jobs/${upgradeJobId}/approve`, { method: "POST" });
  const payload = await response.json();
  const expectedPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "_flows",
    flow.id,
    "Artist",
    "Album",
    "Track.flac",
  );

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.path, expectedPath);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(downloadTracker.getJob(sourceJobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "upgrade audio");
  await assert.rejects(fs.access(originalPath));
  assert.equal(scan.mock.calls.length, 1);
});

test("reports when an upgrade search is already queued for a track", async () => {
  const playlistId = "c79c1598-699a-4ab3-b8cd-4e570f001f18";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Upgrades",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Album" }],
  });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });
  const finalPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "aurral-weekly-flow",
    playlistId,
    "Artist",
    "Album",
    "Track.mp3",
  );
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "audio");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, finalPath, "Album");
  downloadTracker.updateQuality(jobId, { tier: "mp3-128", format: "mp3" });

  const first = await fetch(`${baseUrl}/quality-upgrades/${playlistId}/${jobId}`, {
    method: "POST",
  });
  const second = await fetch(`${baseUrl}/quality-upgrades/${playlistId}/${jobId}`, {
    method: "POST",
  });
  const payload = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, JSON.stringify(payload));
  assert.equal(payload.alreadyQueued, true);
  assert.equal(payload.queued, 0);
});

test("records queued upgrade history if the pipeline removes the live job immediately", async () => {
  const playlistId = "e6be4cd3-10b0-4744-baa1-7e960a41ca54";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Fast failure",
    tracks: [{ artistName: "Artist", trackName: "Fast failure track", albumName: "Album" }],
  });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });
  const finalPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "aurral-weekly-flow",
    playlistId,
    "Artist",
    "Album",
    "Fast failure track.mp3",
  );
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "audio");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Fast failure track", albumName: "Album" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, finalPath, "Album");
  downloadTracker.updateQuality(jobId, { tier: "mp3-128", format: "mp3" });

  const originalEnqueue = downloadTracker.enqueueDownloadPipeline;
  downloadTracker.enqueueDownloadPipeline = (upgradeJobId) => {
    downloadTracker.removeJob(upgradeJobId);
    return true;
  };
  try {
    assert.equal(await queueQualityUpgrade(trackedJob(downloadTracker, jobId)), "queued");
    assert.equal(
      dbOps.getAurralHistory().some((entry) => entry.metadata?.trackName === "Fast failure track"),
      true,
    );
  } finally {
    downloadTracker.enqueueDownloadPipeline = originalEnqueue;
  }
});

test("search all stays within the requesting user's playlist access", async () => {
  const ownedPlaylistId = "c0de1f39-226f-4ab8-8f37-09d8adf47b5a";
  const otherPlaylistId = "a2b9ae35-7fb7-474e-a0d4-8ac4bdb8d9e6";
  const owner = userOps.createUser("search-all-owner", "hash");
  assert.ok(owner != null);
  const other = userOps.createUser("search-all-other", "hash");
  assert.ok(other != null);
  flowPlaylistConfig.createStaticPlaylist({
    id: ownedPlaylistId,
    name: "Owned wanted",
    ownerUserId: owner.id,
    tracks: [{ artistName: "Artist", trackName: "Missing", albumName: "Album" }],
  });
  flowPlaylistConfig.createStaticPlaylist({
    id: otherPlaylistId,
    name: "Other wanted",
    ownerUserId: other.id,
    tracks: [{ artistName: "Artist", trackName: "Private", albumName: "Album" }],
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Missing", albumName: "Album" },
    ownedPlaylistId,
  );
  assert.ok(jobId != null);
  const otherJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Private", albumName: "Album" },
    otherPlaylistId,
  );
  assert.ok(otherJobId != null);
  downloadTracker.setFailed(jobId, "No source");
  downloadTracker.setFailed(otherJobId, "No source");

  const ownedPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "aurral-weekly-flow",
    ownedPlaylistId,
    "Artist",
    "Album",
    "Owned.mp3",
  );
  const otherPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "aurral-weekly-flow",
    otherPlaylistId,
    "Artist",
    "Album",
    "Private.mp3",
  );
  await fs.mkdir(path.dirname(ownedPath), { recursive: true });
  await fs.mkdir(path.dirname(otherPath), { recursive: true });
  await fs.writeFile(ownedPath, "audio");
  await fs.writeFile(otherPath, "audio");
  const ownedUpgradeId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Owned", albumName: "Album" },
    ownedPlaylistId,
  );
  assert.ok(ownedUpgradeId != null);
  const otherUpgradeId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Private", albumName: "Album" },
    otherPlaylistId,
  );
  assert.ok(otherUpgradeId != null);
  downloadTracker.setDone(ownedUpgradeId, ownedPath, "Album");
  downloadTracker.setDone(otherUpgradeId, otherPath, "Album");
  downloadTracker.updateQuality(ownedUpgradeId, { tier: "mp3-128", format: "mp3" });
  downloadTracker.updateQuality(otherUpgradeId, { tier: "mp3-128", format: "mp3" });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });

  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  requestUser = {
    id: owner.id,
    username: "owner",
    role: "user",
    permissions: { accessFlow: true },
  };
  try {
    const missingResponse = await fetch(`${baseUrl}/research-missing`, { method: "POST" });
    const missingPayload = await missingResponse.json();
    assert.equal(missingResponse.status, 200, JSON.stringify(missingPayload));
    assert.equal(missingPayload.requeued, 1);
    assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
    assert.equal(downloadTracker.getJob(otherJobId)?.status, "failed");

    const upgradeResponse = await fetch(`${baseUrl}/quality-upgrades`, { method: "POST" });
    const upgradePayload = await upgradeResponse.json();
    assert.equal(upgradeResponse.status, 200, JSON.stringify(upgradePayload));
    assert.equal(upgradePayload.queued, 1);
    assert.equal(upgradePayload.playlistCount, 1);
    const queuedUpgrade = downloadTracker
      .getAll()
      .find((job) => job.upgradeForJobId === ownedUpgradeId);
    assert.ok(queuedUpgrade != null);
    assert.equal(["pending", "downloading"].includes(queuedUpgrade?.status), true);
    assert.equal(
      downloadTracker.getAll().some((job) => job.upgradeForJobId === otherUpgradeId),
      false,
    );
    assert.equal(
      dbOps.getAurralHistory().some((entry) => entry.metadata?.jobId === queuedUpgrade.id),
      true,
    );

    const jobsResponse = await fetch(`${baseUrl}/jobs`);
    const jobsPayload: ListedJob[] = await jobsResponse.json();
    assert.match(jobsResponse.headers.get("cache-control") || "", /no-store/);
    assert.equal(
      jobsPayload.some((job) => job.upgradeForJobId === ownedUpgradeId),
      true,
    );
  } finally {
    downloadWorker.start = originalStart;
    requestUser = admin;
  }
});

test("wanted covers every library job regardless of playlist access", async () => {
  const missingJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Library Artist", trackName: "Library Missing", albumName: "Album" },
    "library",
  );
  assert.ok(missingJobId != null);
  downloadTracker.setFailed(missingJobId, "No source");
  const lowQualityPath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "Library Artist",
    "Album",
    "Library Low.mp3",
  );
  await fs.mkdir(path.dirname(lowQualityPath), { recursive: true });
  await fs.writeFile(lowQualityPath, "audio");
  const lowQualityJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Library Artist", trackName: "Library Low", albumName: "Album" },
    "library",
  );
  assert.ok(lowQualityJobId != null);
  downloadTracker.setDone(lowQualityJobId, lowQualityPath, "Album");
  downloadTracker.updateQuality(lowQualityJobId, { tier: "mp3-128", format: "mp3" });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });

  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  requestUser = { id: 9, username: "listener", role: "user", permissions: { accessFlow: true } };
  try {
    const jobsPayload: ListedJob[] = await (await fetch(`${baseUrl}/jobs`)).json();
    const listed = new Map(jobsPayload.map((job) => [job.id, job]));
    assert.equal(listed.get(missingJobId)?.status, "failed");
    assert.equal(listed.get(lowQualityJobId)?.qualityOwned, true);
    assert.notEqual(listed.get(lowQualityJobId)?.qualityState, "preferred");

    const missingResponse = await fetch(`${baseUrl}/research-missing`, { method: "POST" });
    const missingPayload = await missingResponse.json();
    assert.equal(missingResponse.status, 200, JSON.stringify(missingPayload));
    assert.equal(missingPayload.requeued, 1);
    assert.equal(downloadTracker.getJob(missingJobId)?.status, "pending");

    downloadTracker.setFailed(missingJobId, "Still no source");
    const research = await processPlaylistOperation({
      kind: "shared-playlist-research-track",
      playlistId: "library",
      jobId: missingJobId,
    });
    assert.ok(research != null && typeof research === "object" && "success" in research);
    assert.equal(research.success, true);
    assert.equal(downloadTracker.getJob(missingJobId)?.status, "pending");

    const upgradeResponse = await fetch(`${baseUrl}/quality-upgrades/library/${lowQualityJobId}`, {
      method: "POST",
    });
    const upgradePayload = await upgradeResponse.json();
    assert.equal(upgradeResponse.status, 200, JSON.stringify(upgradePayload));
    assert.equal(upgradePayload.queued, 1);
    assert.equal(
      downloadTracker.getAll().some((job) => job.upgradeForJobId === lowQualityJobId),
      true,
    );
  } finally {
    downloadWorker.start = originalStart;
    requestUser = admin;
  }
});
