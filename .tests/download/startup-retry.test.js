import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { downloadWorker, startWorkerIfPending },
] = await setupIsolatedBackend(
  "startup-retry",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
);

test.beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("startup leaves failed tracks terminal", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Incomplete",
    tracks: [{ artistName: "Missing", trackName: "Leave Failed" }],
  });
  const failedId = downloadTracker.addJob(
    { artistName: "Missing", trackName: "Leave Failed" },
    playlist.id,
  );
  downloadTracker.setFailed(failedId, "not found");

  let starts = 0;
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {
    starts += 1;
  };
  try {
    await startWorkerIfPending();
  } finally {
    downloadWorker.start = originalStart;
  }

  assert.equal(starts, 0);
  assert.equal(downloadTracker.getJob(failedId)?.status, "failed");
});

test("startup resumes pending work", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Pending work",
    tracks: [{ artistName: "Pending", trackName: "Resume Me" }],
  });
  const pendingId = downloadTracker.addJob(
    { artistName: "Pending", trackName: "Resume Me" },
    playlist.id,
  );

  let starts = 0;
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {
    starts += 1;
  };
  try {
    await startWorkerIfPending();
  } finally {
    downloadWorker.start = originalStart;
  }

  assert.equal(starts, 1);
  assert.equal(downloadTracker.getJob(pendingId)?.status, "pending");
});
