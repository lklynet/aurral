import { createTrackedJob } from "./fixtures.ts";
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
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
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
  const failedId = createTrackedJob(
    downloadTracker,
    { artistName: "Missing", trackName: "Leave Failed" },
    playlist.id,
  );
  assert.ok(failedId != null);
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
  const pendingId = createTrackedJob(
    downloadTracker,
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
  const inPipelineId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "In Pipeline" },
    playlist.id,
  );
  assert.ok(inPipelineId != null);
  downloadTracker.setDownloading(inPipelineId);
  const lastId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Last Pending" },
    playlist.id,
  );

  await downloadWorker.start();
  await downloadWorker.waitForIdle();
  assert.equal(downloadWorker.running, false);

  assert.equal(downloadTracker.getJob(lastId)?.status, "failed");
  assert.equal(downloadTracker.getJob(inPipelineId)?.status, "downloading");
});
