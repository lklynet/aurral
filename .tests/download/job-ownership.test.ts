import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, trackerModule] = await setupIsolatedBackend(
  "job-ownership",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
);

const { DownloadTracker } = trackerModule;

beforeEach(async () => {
  await resetDatabase(db);
  trackerModule.downloadTracker.clearAll();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("album jobs can be grouped and owned by lidarr explicitly", () => {
  const tracker = new DownloadTracker();
  const groupId = "request-group-1";
  const lidarrJobId = createTrackedJob(
    tracker,
    { artistName: "Artist", trackName: "One", managedBy: "lidarr", requestGroupId: groupId },
    "library",
  );
  const aurralJobId = createTrackedJob(
    tracker,
    { artistName: "Artist", trackName: "Two", managedBy: "aurral", requestGroupId: groupId },
    "library",
  );
  const forgedJobId = createTrackedJob(
    tracker,
    { artistName: "Artist", trackName: "Three", managedBy: "not-a-manager", requestGroupId: "   " },
    "library",
  );

  assert.equal(trackedJob(tracker, lidarrJobId).managedBy, "lidarr");
  assert.equal(trackedJob(tracker, lidarrJobId).requestGroupId, groupId);
  assert.equal(trackedJob(tracker, aurralJobId).managedBy, "aurral");
  assert.equal(trackedJob(tracker, aurralJobId).requestGroupId, groupId);
  assert.equal(trackedJob(tracker, forgedJobId).managedBy, "aurral");
  assert.equal(trackedJob(tracker, forgedJobId).requestGroupId, null);

  const group = tracker.getAll().filter((job) => job.requestGroupId === groupId);
  assert.equal(group.length, 2);
});

test("job ownership survives a tracker reload", async () => {
  const tracker = new DownloadTracker();
  const lidarrJobId = createTrackedJob(
    tracker,
    {
      artistName: "Artist",
      trackName: "Reload",
      managedBy: "lidarr",
      requestGroupId: "group-reload",
    },
    "library",
  );

  const reloaded = new DownloadTracker();
  assert.equal(trackedJob(reloaded, lidarrJobId).managedBy, "lidarr");
  assert.equal(trackedJob(reloaded, lidarrJobId).requestGroupId, "group-reload");
});
