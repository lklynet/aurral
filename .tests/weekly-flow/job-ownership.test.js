import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, trackerModule] = await setupIsolatedBackend(
  "job-ownership",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
);

const { WeeklyFlowDownloadTracker } = trackerModule;

test.beforeEach(async () => {
  await resetDatabase(db);
  trackerModule.downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("new jobs default to Aurral ownership", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const jobId = tracker.addJob(
    { artistName: "Artist", trackName: "Track" },
    "library",
  );
  assert.equal(tracker.getJob(jobId).managedBy, "aurral");
  assert.equal(tracker.getJob(jobId).requestGroupId, null);
});

test("album jobs can be grouped and owned by lidarr explicitly", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const groupId = "request-group-1";
  const lidarrJobId = tracker.addJob(
    { artistName: "Artist", trackName: "One", managedBy: "lidarr", requestGroupId: groupId },
    "library",
  );
  const aurralJobId = tracker.addJob(
    { artistName: "Artist", trackName: "Two", managedBy: "aurral", requestGroupId: groupId },
    "library",
  );
  const forgedJobId = tracker.addJob(
    { artistName: "Artist", trackName: "Three", managedBy: "not-a-manager", requestGroupId: "   " },
    "library",
  );

  assert.equal(tracker.getJob(lidarrJobId).managedBy, "lidarr");
  assert.equal(tracker.getJob(lidarrJobId).requestGroupId, groupId);
  assert.equal(tracker.getJob(aurralJobId).managedBy, "aurral");
  assert.equal(tracker.getJob(aurralJobId).requestGroupId, groupId);
  assert.equal(tracker.getJob(forgedJobId).managedBy, "aurral");
  assert.equal(tracker.getJob(forgedJobId).requestGroupId, null);

  const group = tracker.getAll().filter((job) => job.requestGroupId === groupId);
  assert.equal(group.length, 2);
});

test("job ownership survives a tracker reload", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const lidarrJobId = tracker.addJob(
    { artistName: "Artist", trackName: "Reload", managedBy: "lidarr", requestGroupId: "group-reload" },
    "library",
  );

  const reloaded = new WeeklyFlowDownloadTracker();
  assert.equal(reloaded.getJob(lidarrJobId).managedBy, "lidarr");
  assert.equal(reloaded.getJob(lidarrJobId).requestGroupId, "group-reload");
});
