import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("download-tracker");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, trackerModule] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/weeklyFlowDownloadTracker.js"),
]);

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
