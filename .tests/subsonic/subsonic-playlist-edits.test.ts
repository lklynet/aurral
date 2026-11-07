import { testUser } from "../helpers/userFixtures.ts";
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
} from "../helpers/backendTestHarness.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const [
  isolatedState,
  { db },
  subsonic,
  trackerModule,
  playlistConfigModule,
  cancellationModule,
  playlistManagerModule,
  jobQueue,
  dbHelpersModule,
  artworkService,
] = await setupIsolatedBackend(
  "subsonic-playlist-edits",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/subsonicLibraryService.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/jobs/queue.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/customArtworkService.ts"),
);

const { downloadTracker } = trackerModule;
const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { listDownloadProviderWork, registerDownloadProviderWork, withPipelineCommitLock } =
  cancellationModule;
const { playlistManager } = playlistManagerModule;
const { withLock } = jobQueue;
const { dbOps } = dbHelpersModule;
const playlistArtworkImage = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 180, g: 40, b: 100 } },
})
  .png()
  .toBuffer();
const user = testUser(74, { role: "admin" });

const playlistWithTrack = (
  playlistId: string,
  name: string,
  track: { artistName: string; trackName: string; albumName?: string },
) => {
  const jobId = downloadTracker.addJob(track, "library", { addedBy: playlistId });
  assert.ok(jobId != null);
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name,
    ownerUserId: user.id,
    tracks: [{ ...track, canonicalJobId: jobId }],
  });
  return jobId;
};
beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  invalidateFlowPlaylistConfigCache();
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => {});
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("playlist songs expose their custom artwork through an accessible versioned cover ID", async () => {
  const playlistId = "subsonic-custom-track-artwork";
  const jobId = playlistWithTrack(playlistId, "Custom Artwork", {
    artistName: "Artwork Artist",
    albumName: "Artwork Album",
    trackName: "Artwork Song",
  });
  downloadTracker.setDone(jobId, "/test/custom-artwork.flac", "Artwork Album");
  const saved = await artworkService.saveCustomArtworkUpload(
    "playlist-track",
    jobId,
    playlistArtworkImage,
    "image/png",
  );

  const playlist = subsonic.getSubsonicPlaylist(`shared:${playlistId}`, user);
  assert.ok(playlist != null);
  assert.ok(requireFixture(playlist.entry[0]).coverArt != null);
  assert.match(requireFixture(requireFixture(playlist.entry[0]).coverArt), /^art-playlist-track:/);
  assert.ok(requireFixture(playlist.entry[0]).coverArt != null);
  assert.equal(
    subsonic.resolveCustomArtwork(requireFixture(requireFixture(playlist.entry[0]).coverArt), user)
      ?.filePath,
    saved.filePath,
  );
  assert.ok(requireFixture(playlist.entry[0]).coverArt != null);
  assert.equal(
    subsonic.resolveCustomArtwork(
      requireFixture(requireFixture(playlist.entry[0]).coverArt),
      testUser(75),
    ),
    null,
  );
  assert.ok(Date.parse(playlist.changed) >= saved.updatedAt);

  await artworkService.removeCustomArtwork("playlist-track", jobId);
  const resetPlaylist = subsonic.getSubsonicPlaylist(`shared:${playlistId}`, user);
  assert.ok(resetPlaylist != null);
  assert.doesNotMatch(
    requireFixture(resetPlaylist.entry[0]).coverArt || "",
    /^art-playlist-track:/,
  );
  assert.ok(Date.parse(resetPlaylist.changed) > Date.parse(playlist.changed));
});

test("deleting a playlist while its download commits keeps the finished file in the Library", async () => {
  const playlistId = "subsonic-delete-commit-race";
  const jobId = playlistWithTrack(playlistId, "Subsonic Delete Race", {
    artistName: "Commit Artist",
    trackName: "Committing Song",
  });
  const finalPath = path.join(
    playlistManager.downloadRoot,
    "Commit Artist",
    "Commit Album",
    "Committing Song.flac",
  );

  let signalLockEntered!: () => void;
  let releaseLock!: () => void;
  const lockEntered = new Promise<void>((resolve) => {
    signalLockEntered = resolve;
  });
  const lockHeld = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const commitLock = withPipelineCommitLock(
    {
      jobId,
      playlistId: "library",
      playlistGeneration: downloadTracker.getJob(jobId)!.playlistGeneration,
    },
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
    assert.ok(await deletion);
  } finally {
    releaseLock();
    await commitLock;
  }

  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId), null);
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
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
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, finalPath, "Retained Album");
  const saved = { artistName: "Retained Artist", trackName: "Saved Song" };
  const savedJobId = requireFixture(downloadTracker.addJob(saved, "library", { saved: true }));
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Before Rename",
    ownerUserId: user.id,
    tracks: [
      { artistName: "Retained Artist", trackName: "Retained Song", canonicalJobId: jobId },
      { ...saved, canonicalJobId: savedJobId },
    ],
  });
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "retained audio");

  const renamed = await subsonic.updateSubsonicPlaylist(user, { playlistId, name: "After Rename" });

  assert.equal(renamed?.tracks[0]?.canonicalJobId, jobId);
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
  assert.equal(downloadTracker.getJob(savedJobId)?.status, "saved");
  await fs.access(finalPath);
});

test("Subsonic deletion keeps a download the provider will not cancel", async () => {
  const playlistId = "subsonic-delete-provider-failure";
  const jobId = playlistWithTrack(playlistId, "Subsonic Provider Failure", {
    artistName: "Retry Artist",
    trackName: "Retry Song",
  });
  const originalSettings = dbOps.getSettings();
  let signalRequestReceived!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
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
      playlistId: "library",
      provider: "slskd-search",
      workId: "subsonic-retry-search",
    });

    const deletion = subsonic.deleteSubsonicPlaylist(user, playlistId);
    await requestReceived;
    assert.ok(await deletion);

    assert.ok(downloadTracker.getJob(jobId));
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId), null);
    assert.equal(
      listDownloadProviderWork({ playlistId: "library", provider: "slskd-search" }).length,
      1,
    );
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
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const { promise: held, resolve: releaseLock } = Promise.withResolvers<void>();
  let lockReleased = false;
  const currentMutation = withLock("playlist-operation", async () => {
    signalEntered();
    await held;
  });
  await entered;

  const getPlaylist = flowPlaylistConfig.getStaticPlaylistForUser.bind(flowPlaylistConfig);
  vi.spyOn(flowPlaylistConfig, "getStaticPlaylistForUser").mockImplementation((...args) => {
    assert.equal(lockReleased, true);
    return getPlaylist(...args);
  });
  const update = subsonic.updateSubsonicPlaylist(user, {
    playlistId,
    name: "After Ordered Edit",
  });
  const followingMutation = withLock("playlist-operation", () => {
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "After Ordered Edit");
  });
  try {
    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "Before Ordered Edit");
  } finally {
    lockReleased = true;
    releaseLock();
    await Promise.all([currentMutation, update, followingMutation]);
  }
  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.name, "After Ordered Edit");
});
