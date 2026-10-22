import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { downloadWorker, startWorkerIfPending },
] = await setupIsolatedBackend(
  "startup-retry",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/playlists/flowPlaylistConfig.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/downloadJobs/downloadWorker.ts",
);

beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { ytdlp: { enabled: false } },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("startup leaves failed tracks terminal", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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

test("running out of work leaves downloads the pipeline owns running", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Idle worker",
    tracks: [
      { artistName: "Artist", trackName: "In Pipeline" },
      { artistName: "Artist", trackName: "Last Pending" },
    ],
  });
  const inPipelineId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "In Pipeline" },
    playlist.id,
  );
  downloadTracker.setDownloading(inPipelineId);
  const lastId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Last Pending" },
    playlist.id,
  );

  await downloadWorker.start();
  await downloadWorker.waitForIdle();
  assert.equal(downloadWorker.running, false);

  assert.equal(downloadTracker.getJob(lastId)?.status, "failed");
  assert.equal(downloadTracker.getJob(inPipelineId)?.status, "downloading");
});
