import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, trackerModule, qualityProfileService] = await setupIsolatedBackend(
  "download-tracker",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/qualityProfileService.js",
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

test("drops orphaned upgrade jobs on restart and updates every shared file reference", () => {
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
  assert.ok(upgradeId);
  assert.equal(tracker.addUpgradeJob(tracker.getJob(secondId)), null);
  const reloaded = new WeeklyFlowDownloadTracker();
  assert.equal(reloaded.getJob(upgradeId), null);
  assert.ok(reloaded.addUpgradeJob(reloaded.getJob(secondId)));

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

test("finalizes an upgrade when optional quality metadata is absent", async () => {
  const tracker = trackerModule.downloadTracker;
  const library = path.join(isolatedState.baseDir, "weekly-flow", "aurral-weekly-flow");
  const oldPath = path.join(library, "old.mp3");
  const finalPath = path.join(library, "new.m4a");
  await mkdir(library, { recursive: true });
  await writeFile(oldPath, "old");
  await writeFile(finalPath, "new");

  const sourceId = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "discover");
  tracker.setDone(sourceId, oldPath, "Album");
  tracker.updateQuality(sourceId, { tier: "mp3-128", format: "mp3" });
  const upgradeId = tracker.addUpgradeJob(tracker.getJob(sourceId));

  await assert.doesNotReject(
    qualityProfileService.finalizeQualityUpgradeSuccess(
      tracker.getJob(upgradeId),
      finalPath,
      undefined,
    ),
  );
  assert.equal(tracker.getJob(upgradeId), null);
  assert.equal(tracker.getJob(sourceId)?.finalPath, finalPath);
});
