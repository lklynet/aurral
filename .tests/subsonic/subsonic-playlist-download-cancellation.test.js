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
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/honkerDb.js",
  "backend/db/helpers/index.js",
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  getPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  listDownloadProviderWork,
  registerDownloadProviderWork,
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

test("new Subsonic playlists accept jobs added after creation", async () => {
  const playlist = await subsonic.createSubsonicPlaylist(user, { name: "Empty Subsonic Playlist" });
  assert.ok(playlist);

  const jobId = downloadTracker.addJob(
    { artistName: "Later Artist", trackName: "Later Song" },
    playlist.id,
  );

  assert.equal(downloadTracker.getNextPending()?.id, jobId);
});

test("playlist deletion keeps a job available until an in-flight commit releases its lock", async () => {
  const playlistId = "subsonic-delete-commit-race";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Subsonic Delete Race",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const jobId = downloadTracker.addJob(
    { artistName: "Commit Artist", trackName: "Committing Song" },
    playlistId,
  );
  const finalPath = path.join(
    playlistManager.weeklyFlowRoot,
    "Commit Artist",
    "Commit Album",
    "Committing Song.flac",
  );

  let signalLockEntered;
  let releaseLock;
  const lockEntered = new Promise((resolve) => {
    signalLockEntered = resolve;
  });
  const lockHeld = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const lockName = `playlist-mutation:${playlistId}`;
  const commitLock = withHonkerLock(lockName, async () => {
    signalLockEntered();
    await lockHeld;
  });
  await lockEntered;

  try {
    const deletion = subsonic.deleteSubsonicPlaylist(user, playlistId);
    assert.equal(typeof deletion?.then, "function");

    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, "committed audio");
    assert.equal(
      downloadTracker.setDone(jobId, finalPath, "Commit Album"),
      true,
    );
    releaseLock();
    await commitLock;
    assert.equal(await deletion, true);
  } finally {
    releaseLock();
    await commitLock;
  }

  assert.equal(downloadTracker.getJob(jobId), null);
  await assert.rejects(fs.access(finalPath), { code: "ENOENT" });
});

test("Subsonic edits clean an in-flight legacy file before removing its job", async () => {
  const playlistId = "subsonic-edit-commit-race";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Subsonic Edit Race",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const jobId = downloadTracker.addJob(
    { artistName: "Commit Artist", trackName: "Committing Song" },
    playlistId,
  );
  const finalPath = path.join(
    playlistManager.weeklyFlowRoot,
    "Commit Artist",
    "Commit Album",
    "Committing Song.flac",
  );
  let signalLockEntered;
  let releaseLock;
  const lockEntered = new Promise((resolve) => { signalLockEntered = resolve; });
  const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
  const commitLock = withHonkerLock(`playlist-mutation:${playlistId}`, async () => {
    signalLockEntered();
    await lockHeld;
  });
  await lockEntered;

  try {
    const update = subsonic.updateSubsonicPlaylist(user, {
      playlistId,
      name: "Subsonic Edit Complete",
    });
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, "committed audio");
    assert.equal(downloadTracker.setDone(jobId, finalPath, "Commit Album"), true);
    releaseLock();
    await commitLock;
    assert.equal((await update)?.name, "Subsonic Edit Complete");
  } finally {
    releaseLock();
    await commitLock;
  }

  assert.equal(downloadTracker.getJob(jobId), null);
  await assert.rejects(fs.access(finalPath), { code: "ENOENT" });
});

test("Subsonic edits remove a file shared only by jobs from the edited playlist", async () => {
  const playlistId = "subsonic-edit-duplicate-file";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Duplicate File",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const finalPath = path.join(playlistManager.weeklyFlowRoot, "Duplicate Artist", "Duplicate Song.flac");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "shared by obsolete jobs");
  const jobIds = ["First", "Second"].map((trackName) => {
    const id = downloadTracker.addJob({ artistName: "Duplicate Artist", trackName }, playlistId);
    downloadTracker.setDone(id, finalPath, "Duplicate Album");
    return id;
  });

  assert.ok(await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Updated" }));

  for (const id of jobIds) assert.equal(downloadTracker.getJob(id), null);
  await assert.rejects(fs.access(finalPath), { code: "ENOENT" });
});

test("renaming a Subsonic playlist keeps its canonical song and file", async () => {
  const playlistId = "subsonic-edit-retained-canonical-song";
  const finalPath = path.join(playlistManager.weeklyFlowRoot, "Retained Artist", "Retained Song.flac");
  const jobId = downloadTracker.addJob(
    { artistName: "Retained Artist", trackName: "Retained Song" },
    playlistId,
  );
  downloadTracker.setDone(jobId, finalPath, "Retained Album");
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Before Rename",
    ownerUserId: user.id,
    tracks: [{ artistName: "Retained Artist", trackName: "Retained Song", canonicalJobId: jobId }],
  });
  activatePlaylistDownloadGeneration(playlistId);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "retained audio");

  const renamed = await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "After Rename" });

  assert.equal(renamed?.tracks[0]?.canonicalJobId, jobId);
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
  await fs.access(finalPath);
});

test("Subsonic deletion preserves a file used by another playlist", async () => {
  const removedPlaylistId = "subsonic-shared-file-removed";
  const survivingPlaylistId = "subsonic-shared-file-survivor";
  for (const [id, name] of [
    [removedPlaylistId, "Removed playlist"],
    [survivingPlaylistId, "Surviving playlist"],
  ]) {
    flowPlaylistConfig.createSharedPlaylist({ id, name, ownerUserId: user.id, tracks: [] });
  }
  const finalPath = path.join(playlistManager.weeklyFlowRoot, "Shared Artist", "Shared Album", "Shared Song.flac");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "shared audio");
  const removedJobId = downloadTracker.addJob(
    { artistName: "Shared Artist", trackName: "Shared Song" },
    removedPlaylistId,
  );
  const survivingJobId = downloadTracker.addJob(
    { artistName: "Shared Artist", trackName: "Shared Song" },
    survivingPlaylistId,
  );
  downloadTracker.setDone(removedJobId, finalPath, "Shared Album");
  downloadTracker.setDone(survivingJobId, finalPath, "Shared Album");

  assert.equal(await subsonic.deleteSubsonicPlaylist(user, removedPlaylistId), true);
  assert.equal(downloadTracker.getJob(removedJobId), null);
  const survivor = downloadTracker.getJob(survivingJobId);
  assert.ok(survivor);
  await fs.access(survivor.finalPath);
});

test("Subsonic deletion retains jobs and provider work when cancellation fails", async () => {
  const playlistId = "subsonic-delete-provider-failure";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Subsonic Provider Failure",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const jobId = downloadTracker.addJob(
    { artistName: "Retry Artist", trackName: "Retry Song" },
    playlistId,
  );
  const originalSettings = dbOps.getSettings();
  let signalRequestReceived;
  const requestReceived = new Promise((resolve) => {
    signalRequestReceived = resolve;
  });
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    signalRequestReceived();
    response.writeHead(503);
    response.end();
  });

  try {
    dbOps.updateSettings({
      ...originalSettings,
      integrations: {
        ...(originalSettings.integrations || {}),
        slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
      },
    });
    registerDownloadProviderWork({
      jobId,
      playlistId,
      provider: "slskd-search",
      workId: "subsonic-retry-search",
    });

    const deletion = subsonic.deleteSubsonicPlaylist(user, playlistId);
    await requestReceived;
    await assert.rejects(deletion, /Could not cancel download provider work/);

    assert.ok(downloadTracker.getJob(jobId));
    assert.ok(flowPlaylistConfig.getSharedPlaylist(playlistId));
    assert.equal(
      listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length,
      1,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed Subsonic edit keeps the old playlist and allows later jobs", async () => {
  const playlistId = "subsonic-edit-provider-failure";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Before Failed Edit",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const jobId = downloadTracker.addJob(
    { artistName: "Retry Artist", trackName: "Retry Song" },
    playlistId,
  );
  const downloadingJobId = downloadTracker.addJob(
    { artistName: "Retry Artist", trackName: "Interrupted Song" },
    playlistId,
  );
  downloadTracker.setDownloading(downloadingJobId);
  const originalSettings = dbOps.getSettings();
  let failCleanup = true;
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(failCleanup ? 503 : 204);
    response.end();
  });

  try {
    dbOps.updateSettings({
      ...originalSettings,
      integrations: {
        ...(originalSettings.integrations || {}),
        slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
      },
    });
    registerDownloadProviderWork({
      jobId: downloadingJobId,
      playlistId,
      provider: "slskd-search",
      workId: "subsonic-edit-retry-search",
    });

    await assert.rejects(
      subsonic.updateSubsonicPlaylist(user, {
        playlistId,
        name: "After Failed Edit",
      }),
      /Could not cancel download provider work/,
    );
    assert.equal(flowPlaylistConfig.getSharedPlaylist(playlistId)?.name, "Before Failed Edit");
    assert.ok(downloadTracker.getJob(jobId));
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
    assert.equal(downloadTracker.getNextPending()?.id, jobId);
    assert.equal(downloadTracker.getJob(downloadingJobId)?.status, "failed");

    const laterJobId = downloadTracker.addJob(
      { artistName: "Later Artist", trackName: "Later Song" },
      playlistId,
    );
    assert.equal(downloadTracker.getNextPendingMatching((job) => job.id === laterJobId)?.id, laterJobId);

    failCleanup = false;
    const retried = await subsonic.updateSubsonicPlaylist(user, {
      playlistId,
      name: "After Failed Edit",
    });
    assert.equal(retried?.name, "After Failed Edit");
    assert.equal(downloadTracker.getJob(jobId), null);
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 0);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("Subsonic edits wait behind other playlist mutations", async () => {
  const playlistId = "subsonic-edit-global-order";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Before Ordered Edit",
    ownerUserId: user.id,
    tracks: [],
  });
  let signalEntered;
  let releaseLock;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const held = new Promise((resolve) => { releaseLock = resolve; });
  const currentMutation = withHonkerLock("weekly-flow-operation", async () => {
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
    assert.equal(flowPlaylistConfig.getSharedPlaylist(playlistId)?.name, "Before Ordered Edit");
  } finally {
    releaseLock();
    await currentMutation;
    await update;
  }
  assert.equal(flowPlaylistConfig.getSharedPlaylist(playlistId)?.name, "After Ordered Edit");
});

test("a rejected Subsonic edit does not leave later jobs cancelled", async (t) => {
  const playlistId = "subsonic-rejected-edit";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Before Rejected Edit",
    ownerUserId: user.id,
    tracks: [],
  });
  downloadTracker.addJob(
    { artistName: "Old Artist", trackName: "Old Song" },
    playlistId,
  );
  t.mock.method(flowPlaylistConfig, "updateSharedPlaylist", () => null);

  assert.equal(
    await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Rejected name" }),
    null,
  );
  const laterJobId = downloadTracker.addJob(
    { artistName: "Later Artist", trackName: "Later Song" },
    playlistId,
  );
  assert.equal(downloadTracker.getNextPendingMatching((job) => job.id === laterJobId)?.id, laterJobId);
});

test("a failed Subsonic edit does not revive a previously cancelled job", async (t) => {
  const playlistId = "subsonic-edit-existing-cancellation";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Existing Cancellation",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Old Song" }, playlistId);
  cancelDownloadJob(jobId);
  t.mock.method(flowPlaylistConfig, "updateSharedPlaylist", () => null);

  assert.equal(await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Rejected" }), null);
  assert.equal(isDownloadJobCancelled(jobId), true);
});

test("a successful Subsonic edit does not reactivate a playlist awaiting deletion", async () => {
  const playlistId = "subsonic-edit-queued-delete";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Queued for Deletion",
    ownerUserId: user.id,
    tracks: [],
  });
  cancelPlaylistDownloadGeneration(playlistId);
  const cancelledGeneration = getPlaylistDownloadGeneration(playlistId);

  const updated = await subsonic.updateSubsonicPlaylist(user, {
    playlistId,
    name: "Edited Before Deletion",
  });
  const laterJobId = downloadTracker.addJob(
    { artistName: "Later Artist", trackName: "Later Song" },
    playlistId,
  );
  const laterJob = downloadTracker.getJob(laterJobId);

  assert.equal(updated?.name, "Edited Before Deletion");
  assert.equal(getPlaylistDownloadGeneration(playlistId), cancelledGeneration);
  assert.equal(isPipelinePayloadActive({
    jobId: laterJobId,
    playlistId,
    playlistGeneration: laterJob.playlistGeneration,
  }), false);
});
