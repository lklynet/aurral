import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import sharp from "sharp";

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
  artworkService,
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
  "backend/services/customArtworkService.js",
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
  withPipelineCommitLock,
} = cancellationModule;
const { playlistManager } = playlistManagerModule;
const { withHonkerLock } = honkerModule;
const { dbOps } = dbHelpersModule;
const playlistArtworkImage = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 180, g: 40, b: 100 } },
})
  .png()
  .toBuffer();
const user = { id: 74, role: "admin" };
const playlistManagerMethods = ["updateConfig", "requestPlaylistSync", "scheduleScanLibrary"];
let originalPlaylistManagerMethods;

beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  invalidateFlowPlaylistConfigCache();
  originalPlaylistManagerMethods = new Map(
    playlistManagerMethods.map((name) => [name, playlistManager[name]]),
  );
  for (const name of playlistManagerMethods) {
    playlistManager[name] = () => {};
  }
});

afterEach(() => {
  for (const [name, method] of originalPlaylistManagerMethods) {
    playlistManager[name] = method;
  }
});

afterAll(async () => {
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

test("playlist songs expose their custom artwork through an accessible versioned cover ID", async () => {
  const playlistId = "subsonic-custom-track-artwork";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Custom Artwork",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artwork Artist", albumName: "Artwork Album", trackName: "Artwork Song" },
    playlistId,
  );
  downloadTracker.setDone(jobId, "/test/custom-artwork.flac", "Artwork Album");
  const saved = await artworkService.saveCustomArtworkUpload(
    "playlist-track",
    jobId,
    playlistArtworkImage,
    "image/png",
  );

  const playlist = subsonic.getSubsonicPlaylist(`shared:${playlistId}`, user);
  assert.match(playlist.entry[0].coverArt, /^art-playlist-track:/);
  assert.equal(
    subsonic.resolveCustomArtwork(playlist.entry[0].coverArt, user)?.filePath,
    saved.filePath,
  );
  assert.equal(
    subsonic.resolveCustomArtwork(playlist.entry[0].coverArt, { id: 75, role: "user" }),
    null,
  );
  assert.ok(Date.parse(playlist.changed) >= saved.updatedAt);

  await artworkService.removeCustomArtwork("playlist-track", jobId);
  const resetPlaylist = subsonic.getSubsonicPlaylist(`shared:${playlistId}`, user);
  assert.doesNotMatch(resetPlaylist.entry[0].coverArt || "", /^art-playlist-track:/);
  assert.ok(Date.parse(resetPlaylist.changed) > Date.parse(playlist.changed));
});

test("playlist deletion keeps a job available until an in-flight commit releases its lock", async () => {
  const playlistId = "subsonic-delete-commit-race";
  flowPlaylistConfig.createStaticPlaylist({
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
    playlistManager.downloadRoot,
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
  const commitLock = withPipelineCommitLock(
    { jobId, playlistId, playlistGeneration: downloadTracker.getJob(jobId).playlistGeneration },
    async () => {
      signalLockEntered();
      await lockHeld;
    },
  );
  await lockEntered;

  try {
    const deletion = subsonic.deleteSubsonicPlaylist(user, playlistId);
    assert.equal(typeof deletion?.then, "function");

    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, "committed audio");
    assert.equal(downloadTracker.setDone(jobId, finalPath, "Commit Album"), true);
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
  flowPlaylistConfig.createStaticPlaylist({
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
    playlistManager.downloadRoot,
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
  const commitLock = withPipelineCommitLock(
    { jobId, playlistId, playlistGeneration: downloadTracker.getJob(jobId).playlistGeneration },
    async () => {
      signalLockEntered();
      await lockHeld;
    },
  );
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

test("Subsonic edits keep playlist songs that have no stored track", async () => {
  const playlistId = "subsonic-edit-duplicate-file";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Duplicate File",
    ownerUserId: user.id,
    tracks: [],
  });
  activatePlaylistDownloadGeneration(playlistId);
  const finalPath = path.join(
    playlistManager.downloadRoot,
    "Duplicate Artist",
    "Duplicate Song.flac",
  );
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "shared by untracked songs");
  for (const trackName of ["First", "Second"]) {
    const id = downloadTracker.addJob({ artistName: "Duplicate Artist", trackName }, playlistId);
    downloadTracker.setDone(id, finalPath, "Duplicate Album");
  }

  assert.ok(await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Updated" }));

  const songs = subsonic.getSubsonicPlaylist(`shared:${playlistId}`, user).entry;
  assert.deepEqual(songs.map((song) => song.title).sort(), ["First", "Second"]);
  await fs.access(finalPath);
});

test("renaming a Subsonic playlist keeps its library song and file", async () => {
  const playlistId = "subsonic-edit-retained-canonical-song";
  const finalPath = path.join(
    playlistManager.downloadRoot,
    "Retained Artist",
    "Retained Song.flac",
  );
  const jobId = downloadTracker.addJob(
    { artistName: "Retained Artist", trackName: "Retained Song" },
    playlistId,
  );
  downloadTracker.setDone(jobId, finalPath, "Retained Album");
  flowPlaylistConfig.createStaticPlaylist({
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
    flowPlaylistConfig.createStaticPlaylist({ id, name, ownerUserId: user.id, tracks: [] });
  }
  const finalPath = path.join(
    playlistManager.downloadRoot,
    "Shared Artist",
    "Shared Album",
    "Shared Song.flac",
  );
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
  flowPlaylistConfig.createStaticPlaylist({
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
    assert.ok(flowPlaylistConfig.getStaticPlaylist(playlistId));
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed Subsonic edit keeps the old playlist and allows later jobs", async () => {
  const playlistId = "subsonic-edit-provider-failure";
  flowPlaylistConfig.createStaticPlaylist({
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
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "Before Failed Edit");
    assert.ok(downloadTracker.getJob(jobId));
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
    assert.equal(downloadTracker.getNextPending()?.id, jobId);
    assert.equal(downloadTracker.getJob(downloadingJobId)?.status, "failed");

    const laterJobId = downloadTracker.addJob(
      { artistName: "Later Artist", trackName: "Later Song" },
      playlistId,
    );
    assert.equal(
      downloadTracker.getNextPendingMatching((job) => job.id === laterJobId)?.id,
      laterJobId,
    );

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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Before Ordered Edit",
    ownerUserId: user.id,
    tracks: [],
  });
  let signalEntered;
  let releaseLock;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const held = new Promise((resolve) => {
    releaseLock = resolve;
  });
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
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "Before Ordered Edit");
  } finally {
    releaseLock();
    await currentMutation;
    await update;
  }
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "After Ordered Edit");
});

test("a rejected Subsonic edit does not leave later jobs cancelled", async () => {
  const playlistId = "subsonic-rejected-edit";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Before Rejected Edit",
    ownerUserId: user.id,
    tracks: [],
  });
  downloadTracker.addJob({ artistName: "Old Artist", trackName: "Old Song" }, playlistId);
  vi.spyOn(flowPlaylistConfig, "updateStaticPlaylist").mockImplementation(() => null);

  assert.equal(
    await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Rejected name" }),
    null,
  );
  const laterJobId = downloadTracker.addJob(
    { artistName: "Later Artist", trackName: "Later Song" },
    playlistId,
  );
  assert.equal(
    downloadTracker.getNextPendingMatching((job) => job.id === laterJobId)?.id,
    laterJobId,
  );
});

test("a failed Subsonic edit does not revive a previously cancelled job", async () => {
  const playlistId = "subsonic-edit-existing-cancellation";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Existing Cancellation",
    ownerUserId: user.id,
    tracks: [],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Old Song" }, playlistId);
  cancelDownloadJob(jobId);
  vi.spyOn(flowPlaylistConfig, "updateStaticPlaylist").mockImplementation(() => null);

  assert.equal(await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "Rejected" }), null);
  assert.equal(isDownloadJobCancelled(jobId), true);
});

test("a successful Subsonic edit does not reactivate a playlist awaiting deletion", async () => {
  const playlistId = "subsonic-edit-queued-delete";
  flowPlaylistConfig.createStaticPlaylist({
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
  assert.equal(
    isPipelinePayloadActive({
      jobId: laterJobId,
      playlistId,
      playlistGeneration: laterJob.playlistGeneration,
    }),
    false,
  );
});
