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
  cancellationModule,
  trackerModule,
  playlistConfigModule,
  operationsModule,
  playlistManagerModule,
  workerModule,
  honkerModule,
  cancellationServiceModule,
] = await setupIsolatedBackend(
  "weekly-flow-download-cancellation",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/honkerDb.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellationService.js",
);

const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  getPlaylistDownloadGeneration,
  isPipelinePayloadActive,
} = cancellationModule;
const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { processWeeklyFlowOperation } = operationsModule;
const { playlistManager } = playlistManagerModule;
const { weeklyFlowWorker } = workerModule;
const { enqueuePipelineJob, listHonkerJobs } = honkerModule;
const { markPlaylistDownloadWorkCancelled } = cancellationServiceModule;

test.beforeEach(async () => {
  await resetDatabase(db);
  db.exec("DELETE FROM weekly_flow_download_job_cancellations");
  db.exec("DELETE FROM weekly_flow_download_cancellations");
  downloadTracker.clearAll();
  weeklyFlowWorker.stop();
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("playlist deletion invalidates queued payloads across recreation", () => {
  const playlistId = "shared-playlist";
  const firstGeneration = activatePlaylistDownloadGeneration(playlistId);
  const payload = {
    jobId: "job-one",
    playlistId,
    playlistGeneration: firstGeneration,
  };

  assert.equal(isPipelinePayloadActive(payload), true);

  cancelPlaylistDownloadGeneration(playlistId);
  assert.equal(isPipelinePayloadActive(payload), false);

  const recreatedGeneration = activatePlaylistDownloadGeneration(playlistId);
  assert.equal(recreatedGeneration, firstGeneration + 1);
  assert.equal(isPipelinePayloadActive(payload), false);
  assert.equal(
    isPipelinePayloadActive({
      ...payload,
      jobId: "job-two",
      playlistGeneration: recreatedGeneration,
    }),
    true,
  );
  assert.equal(getPlaylistDownloadGeneration(playlistId), recreatedGeneration);
});

test("job cancellation remains effective after the tracker row is removed", () => {
  const payload = {
    jobId: "job-removed",
    playlistId: "shared-playlist",
    playlistGeneration: 0,
  };

  assert.equal(isPipelinePayloadActive(payload), true);
  cancelDownloadJob(payload.jobId);
  assert.equal(isPipelinePayloadActive(payload), false);
});

test("deletion marks queued work cancelled before the background operation starts", () => {
  const playlistId = "immediate-delete";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Immediate Delete",
    tracks: [],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  const generation = activatePlaylistDownloadGeneration(playlistId);
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId,
    playlistId,
    playlistGeneration: generation,
  });
  markPlaylistDownloadWorkCancelled(playlistId, downloadTracker.getByPlaylistType(playlistId));

  assert.equal(isPipelinePayloadActive({ jobId, playlistId, playlistGeneration: generation }), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId), true);
});

test("shared playlist deletion cancels its pipeline before clearing the tracker", async (t) => {
  const playlistId = "deleted-playlist";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Deleted Playlist",
    tracks: [],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  downloadTracker.setDone(jobId, "/tmp/aurral-cancellation-song.mp3", "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(jobId));
  const generation = activatePlaylistDownloadGeneration(playlistId);
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId,
    playlistId,
    playlistGeneration: generation,
  });
  const upgradeQueueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: upgradeJobId,
    playlistId,
    playlistGeneration: generation,
    source: "slskd",
  });

  t.mock.method(weeklyFlowWorker, "blockPlaylist", async () => {});
  t.mock.method(weeklyFlowWorker, "clearIncompleteRetry", async () => {});
  t.mock.method(weeklyFlowWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(weeklyFlowWorker, "unblockPlaylist", async () => {});
  t.mock.method(weeklyFlowWorker, "pruneOrphanedJobState", async () => {});
  t.mock.method(weeklyFlowWorker, "setRetryCyclePaused", () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "deletePlaybackPlaylist", async () => {});
  t.mock.method(playlistManager, "weeklyReset", async () => {});
  t.mock.method(playlistManager, "cleanupEntityPlexPlaylists", async () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});

  await processWeeklyFlowOperation({
    kind: "shared-playlist-delete",
    playlistId,
  });

  assert.equal(flowPlaylistConfig.getSharedPlaylist(playlistId), null);
  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(isPipelinePayloadActive({
    jobId,
    playlistId,
    playlistGeneration: generation,
  }), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === upgradeQueueJobId), false);
});

test("shared playlist track replacement cancels dependent quality upgrades", async (t) => {
  const playlistId = "replaced-playlist";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Replaced Playlist",
    tracks: [],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  downloadTracker.setDone(jobId, "/tmp/aurral-cancellation-replaced.mp3", "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(jobId));
  const generation = activatePlaylistDownloadGeneration(playlistId);
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: upgradeJobId,
    playlistId,
    playlistGeneration: generation,
    upgrade: true,
  });

  t.mock.method(weeklyFlowWorker, "blockPlaylist", async () => {});
  t.mock.method(weeklyFlowWorker, "clearIncompleteRetry", async () => {});
  t.mock.method(weeklyFlowWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(weeklyFlowWorker, "unblockPlaylist", async () => {});
  t.mock.method(weeklyFlowWorker, "pruneOrphanedJobState", async () => {});
  t.mock.method(weeklyFlowWorker, "setRetryCyclePaused", () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => {});

  await operationsModule.updateSharedPlaylist({
    playlistId,
    tracks: [],
    hasTracksUpdate: true,
  });

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(isPipelinePayloadActive({
    jobId: upgradeJobId,
    playlistId,
    playlistGeneration: generation,
  }), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId), false);
});
