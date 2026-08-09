import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, trackerModule] = await setupIsolatedBackend(
  "download-tracker",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
);

const { WeeklyFlowDownloadTracker } = trackerModule;

test.beforeEach(async () => {
  await resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getNextPendingMatching skips future-dated retry jobs and returns ready work", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const [firstId, secondId] = tracker.addJobs(
    [
      { artistName: "Artist A", trackName: "Song A" },
      { artistName: "Artist B", trackName: "Song B" },
    ],
    "discover",
  );

  tracker.setPending(firstId, "retry later", { asRetryCycle: true });

  const ready = tracker.getNextPendingMatching(
    (job) => job.id === secondId,
    null,
  );

  assert.equal(ready?.id, secondId);
});

test("persists enriched album context for slskd matching", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const jobId = tracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
      albumName: "Album",
    },
    "discover",
  );

  tracker.updateMetadata(jobId, {
    trackNumber: 3,
    albumTrackCount: 10,
    albumTrackTitles: ["Intro", "Other Song", "Song"],
  });

  const reloaded = new WeeklyFlowDownloadTracker();
  const job = reloaded.getJob(jobId);

  assert.equal(job.trackNumber, 3);
  assert.equal(job.albumTrackCount, 10);
  assert.deepEqual(job.albumTrackTitles, ["Intro", "Other Song", "Song"]);
});

test("returns complete playlist job lists unless a caller explicitly limits them", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const tracks = Array.from({ length: 650 }, (_, index) => ({
    artistName: `Artist ${index}`,
    trackName: `Song ${index}`,
  }));

  tracker.addJobs(tracks, "large-static-playlist");

  assert.equal(tracker.getByPlaylistType("large-static-playlist").length, 650);
  assert.equal(
    tracker.getByPlaylistType("large-static-playlist", 500).length,
    500,
  );
});

test("persists upgrade jobs and updates every playlist reference to a shared file", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const firstId = tracker.addJob(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "flow-one",
  );
  const secondId = tracker.addJob(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "static-two",
  );
  for (const id of [firstId, secondId]) {
    tracker.setDone(id, "/library/Song.mp3", "Album");
    tracker.updateQuality(id, { tier: "mp3-128", format: "mp3", bitrateKbps: 128 });
  }

  const upgradeId = tracker.addUpgradeJob(tracker.getJob(firstId));
  const reloaded = new WeeklyFlowDownloadTracker();
  assert.equal(reloaded.getJob(upgradeId)?.playlistType, "quality-upgrade");
  assert.equal(reloaded.getJob(upgradeId)?.playlistId, "flow-one");
  assert.equal(reloaded.getJob(upgradeId)?.upgradeForJobId, firstId);
  assert.equal(reloaded.addUpgradeJob(reloaded.getJob(secondId)), null);

  const changed = reloaded.replaceFinalPath("/library/Song.mp3", "/library/Song.flac", {
    tier: "flac-standard",
    format: "flac",
    sampleRate: 44100,
    bitDepth: 16,
  });
  assert.equal(changed.length, 2);
  assert.equal(reloaded.getJob(firstId)?.finalPath, "/library/Song.flac");
  assert.equal(reloaded.getJob(secondId)?.qualityTier, "flac-standard");
});
