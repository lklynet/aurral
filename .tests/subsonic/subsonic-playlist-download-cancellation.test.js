import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

const [
  isolatedState,
  { db },
  subsonic,
  trackerModule,
  playlistConfigModule,
  cancellationModule,
  playlistManagerModule,
  honkerModule,
  dbHelpersModule,
] = await setupIsolatedBackend(
  "subsonic-playlist-download-cancellation",
  "backend/config/db-sqlite.js",
  "backend/services/subsonicLibraryService.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/honkerDb.js",
  "backend/db/helpers/index.js",
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const {
  isDownloadJobCancelled,
  listDownloadProviderWork,
  registerDownloadProviderWork,
  withPipelineCommitLock,
} = cancellationModule;
const { playlistManager } = playlistManagerModule;
const { withHonkerLock } = honkerModule;
const { dbOps } = dbHelpersModule;
const user = { id: 74, role: "admin" };
const playlistManagerMethods = [
  "updateConfig",
  "ensureSmartPlaylists",
  "refreshPlaylist",
  "scheduleScanLibrary",
  "deletePlaybackPlaylist",
];
let originalPlaylistManagerMethods;

test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  invalidateFlowPlaylistConfigCache();
  originalPlaylistManagerMethods = new Map(
    playlistManagerMethods.map((name) => [name, playlistManager[name]]),
  );
  for (const name of playlistManagerMethods) {
    playlistManager[name] = name === "deletePlaybackPlaylist"
      ? async () => true
      : () => {};
  }
});

test.afterEach(() => {
  for (const [name, method] of originalPlaylistManagerMethods) {
    playlistManager[name] = method;
  }
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function createPlaylist(id, name, tracks = []) {
  flowPlaylistConfig.createStaticPlaylist({ id, name, ownerUserId: user.id, tracks: [] });
  return addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, id, tracks);
}

async function writeLibraryFile(...segments) {
  const finalPath = path.join(playlistManager.downloadRoot, ...segments);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "disposable audio");
  return finalPath;
}

async function holdCommitLock(jobId) {
  let signalEntered;
  let release;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const job = downloadTracker.getJob(jobId);
  const lock = withPipelineCommitLock(
    { jobId, ownerId: "library", ownerGeneration: job.ownerGeneration },
    async () => {
      signalEntered();
      await held;
    },
  );
  await entered;
  return { release, lock };
}

async function withSlskd(handler, operation) {
  const originalSettings = dbOps.getSettings();
  const mock = await createMockHttpServer(handler);
  try {
    dbOps.updateSettings({
      ...originalSettings,
      integrations: {
        ...(originalSettings.integrations || {}),
        slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
      },
    });
    return await operation();
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
}

test("playlist deletion waits for an in-flight import before deleting the playlist's download", async () => {
  const playlistId = "subsonic-delete-commit-race";
  const [jobId] = createPlaylist(playlistId, "Subsonic Delete Race", [
    { artistName: "Commit Artist", trackName: "Committing Song" },
  ]);
  const commit = await holdCommitLock(jobId);
  let finalPath;
  try {
    const deletion = subsonic.deleteSubsonicPlaylist(user, playlistId);
    finalPath = await writeLibraryFile("Commit Artist", "Commit Album", "Committing Song.flac");
    assert.equal(downloadTracker.setDone(jobId, finalPath, "Commit Album"), true);
    commit.release();
    await commit.lock;
    assert.equal(await deletion, true);
  } finally {
    commit.release();
    await commit.lock;
  }

  assert.equal(downloadTracker.getJob(jobId), null);
  await assert.rejects(fs.access(finalPath), { code: "ENOENT" });
});

test("Subsonic edits wait for an in-flight import before deleting a removed song's download", async () => {
  const playlistId = "subsonic-edit-commit-race";
  const [jobId, keptJobId] = createPlaylist(playlistId, "Subsonic Edit Race", [
    { artistName: "Commit Artist", trackName: "Committing Song" },
    { artistName: "Commit Artist", trackName: "Kept Song" },
  ]);
  const commit = await holdCommitLock(jobId);
  let finalPath;
  try {
    const update = subsonic.updateSubsonicPlaylist(user, {
      playlistId,
      name: "Subsonic Edit Complete",
      songIndexesToRemove: [0],
    });
    finalPath = await writeLibraryFile("Commit Artist", "Commit Album", "Committing Song.flac");
    assert.equal(downloadTracker.setDone(jobId, finalPath, "Commit Album"), true);
    commit.release();
    await commit.lock;
    const updated = await update;
    assert.equal(updated?.name, "Subsonic Edit Complete");
    assert.deepEqual(updated.tracks.map((track) => track.jobId), [keptJobId]);
  } finally {
    commit.release();
    await commit.lock;
  }

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(keptJobId)?.status, "pending");
  await assert.rejects(fs.access(finalPath), { code: "ENOENT" });
});

test("renaming a Subsonic playlist keeps its downloads", async () => {
  const playlistId = "subsonic-edit-retained-song";
  const [jobId] = createPlaylist(playlistId, "Before Rename", [
    { artistName: "Retained Artist", trackName: "Retained Song" },
  ]);
  const finalPath = await writeLibraryFile("Retained Artist", "Retained Song.flac");
  downloadTracker.setDone(jobId, finalPath, "Retained Album");

  const renamed = await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "After Rename" });

  assert.equal(renamed?.tracks[0]?.jobId, jobId);
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
  await fs.access(finalPath);
});

test("Subsonic deletion keeps a downloaded file another Library track uses", async () => {
  const finalPath = await writeLibraryFile("Shared Artist", "Shared Album", "Shared Song.flac");
  const [removedJobId] = createPlaylist("subsonic-shared-file-removed", "Removed playlist", [
    { artistName: "Shared Artist", trackName: "Shared Song" },
  ]);
  const libraryJobId = downloadTracker.addJob({ artistName: "Shared Artist", trackName: "Shared Song (Live)" }, "library");
  downloadTracker.setDone(removedJobId, finalPath, "Shared Album");
  downloadTracker.setDone(libraryJobId, finalPath, "Shared Album");

  assert.equal(await subsonic.deleteSubsonicPlaylist(user, "subsonic-shared-file-removed"), true);
  assert.equal(downloadTracker.getJob(removedJobId), null);
  assert.equal(downloadTracker.getJob(libraryJobId)?.finalPath, finalPath);
  await fs.access(finalPath);
});

test("Subsonic deletion keeps a song copied into another playlist", async () => {
  const [jobId] = createPlaylist("subsonic-copy-source", "Copy source", [
    { artistName: "Copied Artist", trackName: "Copied Song" },
  ]);
  const finalPath = await writeLibraryFile("Copied Artist", "Copied Song.flac");
  downloadTracker.setDone(jobId, finalPath, "Copied Album");
  const copy = await subsonic.createSubsonicPlaylist(user, {
    name: "Copy target",
    songIds: [`shared-song:subsonic-copy-source:${jobId}`],
  });
  assert.equal(copy?.tracks[0]?.jobId, jobId);

  assert.equal(await subsonic.deleteSubsonicPlaylist(user, "subsonic-copy-source"), true);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, finalPath);
  await fs.access(finalPath);
});

test("Subsonic deletion retains its download and provider work when cancellation fails", async () => {
  const playlistId = "subsonic-delete-provider-failure";
  const [jobId] = createPlaylist(playlistId, "Subsonic Provider Failure", [
    { artistName: "Retry Artist", trackName: "Retry Song" },
  ]);
  downloadTracker.setDownloading(jobId);
  registerDownloadProviderWork({
    jobId,
    ownerId: "library",
    provider: "slskd-search",
    workId: "subsonic-retry-search",
  });

  await withSlskd((request, response) => {
    request.resume();
    response.writeHead(503);
    response.end();
  }, async () => {
    await assert.rejects(
      subsonic.deleteSubsonicPlaylist(user, playlistId),
      /Could not cancel download provider work/,
    );
  });

  assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.tracks[0]?.jobId, jobId);
  assert.equal(listDownloadProviderWork({ jobIds: [jobId], provider: "slskd-search" }).length, 1);
});

test("a failed Subsonic edit keeps the old playlist and leaves its downloads recoverable", async () => {
  const playlistId = "subsonic-edit-provider-failure";
  const [pendingJobId, downloadingJobId] = createPlaylist(playlistId, "Before Failed Edit", [
    { artistName: "Retry Artist", trackName: "Retry Song" },
    { artistName: "Retry Artist", trackName: "Interrupted Song" },
  ]);
  downloadTracker.setDownloading(downloadingJobId);
  registerDownloadProviderWork({
    jobId: downloadingJobId,
    ownerId: "library",
    provider: "slskd-search",
    workId: "subsonic-edit-retry-search",
  });
  let failCleanup = true;
  const edit = () => subsonic.updateSubsonicPlaylist(user, {
    playlistId,
    name: "After Failed Edit",
    songIndexesToRemove: [0, 1],
  });

  await withSlskd((request, response) => {
    request.resume();
    response.writeHead(failCleanup ? 503 : 204);
    response.end();
  }, async () => {
    await assert.rejects(edit(), /Could not cancel download provider work/);
    const kept = flowPlaylistConfig.getStaticPlaylist(playlistId);
    assert.equal(kept?.name, "Before Failed Edit");
    assert.deepEqual(kept.tracks.map((track) => track.jobId), [pendingJobId, downloadingJobId]);
    assert.equal(downloadTracker.getJob(pendingJobId)?.status, "pending");
    assert.equal(isDownloadJobCancelled(pendingJobId), false);
    assert.equal(downloadTracker.getJob(downloadingJobId)?.status, "failed");
    assert.equal(listDownloadProviderWork({ jobIds: [downloadingJobId], provider: "slskd-search" }).length, 1);

    failCleanup = false;
    const retried = await edit();
    assert.equal(retried?.name, "After Failed Edit");
    assert.deepEqual(retried.tracks, []);
  });

  assert.equal(downloadTracker.getJob(pendingJobId), null);
  assert.equal(downloadTracker.getJob(downloadingJobId), null);
  assert.equal(listDownloadProviderWork({ jobIds: [downloadingJobId], provider: "slskd-search" }).length, 0);
});

test("Subsonic edits wait behind other playlist mutations", async () => {
  const playlistId = "subsonic-edit-global-order";
  createPlaylist(playlistId, "Before Ordered Edit");
  let signalEntered;
  let releaseLock;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const held = new Promise((resolve) => { releaseLock = resolve; });
  const currentMutation = withHonkerLock("playlist-operation", async () => {
    signalEntered();
    await held;
  });
  await entered;

  const update = subsonic.updateSubsonicPlaylist(user, {
    playlistId,
    name: "After Ordered Edit",
  });
  try {
    const state = await Promise.race([
      update.then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    assert.equal(state, "waiting");
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "Before Ordered Edit");
  } finally {
    releaseLock();
    await currentMutation;
    await update;
  }
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "After Ordered Edit");
});

test("a Subsonic edit that cannot be saved leaves removed downloads queued", async (t) => {
  const playlistId = "subsonic-rejected-edit";
  const [jobId] = createPlaylist(playlistId, "Before Rejected Edit", [
    { artistName: "Old Artist", trackName: "Old Song" },
  ]);
  t.mock.method(flowPlaylistConfig, "updateStaticPlaylist", () => null);

  await assert.rejects(
    subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Rejected name", songIndexesToRemove: [0] }),
    /Could not save the playlist/,
  );
  t.mock.restoreAll();
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.tracks[0]?.jobId, jobId);
  assert.equal(isDownloadJobCancelled(jobId), false);
  assert.equal(downloadTracker.getNextPendingMatching((job) => job.id === jobId)?.id, jobId);
});
