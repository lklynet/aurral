import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
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
  dbHelpersModule,
  downloadFolderConfigModule,
  sabnzbdModule,
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
  "backend/db/helpers/index.js",
  "backend/services/downloadFolderConfig.js",
  "backend/services/sabnzbdClient.js",
);

const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  clearDownloadProviderWork,
  getPlaylistDownloadGeneration,
  isPipelinePayloadActive,
  listDownloadProviderWork,
  registerDownloadProviderWork,
} = cancellationModule;
const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { processWeeklyFlowOperation } = operationsModule;
const { playlistManager } = playlistManagerModule;
const { weeklyFlowWorker } = workerModule;
const { enqueuePipelineJob, listHonkerJobs } = honkerModule;
const { markPlaylistDownloadWorkCancelled } = cancellationServiceModule;
const { dbOps } = dbHelpersModule;
const { resolveYtdlpStagingRoot } = downloadFolderConfigModule;
const { sabnzbdClient } = sabnzbdModule;

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

test("orphaned playlist jobs stay inactive after recreation and tracker reload", () => {
  const playlistId = "orphaned-playlist-job";
  activatePlaylistDownloadGeneration(playlistId);
  cancelPlaylistDownloadGeneration(playlistId);

  const orphanedJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Orphaned Song" },
    playlistId,
  );
  const orphanedGeneration = getPlaylistDownloadGeneration(playlistId);
  const activeGeneration = activatePlaylistDownloadGeneration(playlistId);
  const activeJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Current Song" },
    playlistId,
  );

  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });

  assert.equal(activeGeneration, orphanedGeneration + 1);
  assert.equal(downloadTracker.enqueueDownloadPipeline(orphanedJobId), false);
  assert.equal(downloadTracker.getNextPending()?.id, activeJobId);
  assert.equal(downloadTracker.getJob(activeJobId)?.playlistGeneration, activeGeneration);
  assert.equal(downloadTracker.getJob(orphanedJobId)?.playlistGeneration, orphanedGeneration);

  const reloadedTracker = new trackerModule.WeeklyFlowDownloadTracker();
  assert.equal(reloadedTracker.getJob(orphanedJobId)?.playlistGeneration, orphanedGeneration);
  assert.equal(reloadedTracker.getNextPending()?.id, activeJobId);
});

test("quality-upgrade jobs retain their source playlist generation", () => {
  const playlistId = "upgrade-playlist-generation";
  activatePlaylistDownloadGeneration(playlistId);
  cancelPlaylistDownloadGeneration(playlistId);
  activatePlaylistDownloadGeneration(playlistId);
  const sourceJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Owned Song" },
    playlistId,
  );
  downloadTracker.setDone(sourceJobId, "/library/Owned Song.mp3", "Album");
  const playlistGeneration = getPlaylistDownloadGeneration(playlistId);

  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(sourceJobId));

  assert.ok(upgradeJobId);
  assert.equal(downloadTracker.getJob(sourceJobId)?.playlistGeneration, playlistGeneration);
  assert.equal(
    downloadTracker.getJob(upgradeJobId)?.playlistGeneration,
    playlistGeneration,
  );
  assert.equal(
    db.prepare("SELECT playlist_generation FROM playlist_download_jobs WHERE id = ?")
      .get(upgradeJobId)?.playlist_generation,
    playlistGeneration,
  );
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

test("pending selection excludes durably cancelled jobs", () => {
  const playlistId = "cancelled-pending-selection";
  const cancelledJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Cancelled Song" },
    playlistId,
  );
  cancelDownloadJob(cancelledJobId);

  assert.equal(downloadTracker.getNextPending(), null);

  const activeJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Active Song" },
    playlistId,
  );
  assert.equal(downloadTracker.getNextPending()?.id, activeJobId);
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

test("playlist deletion cancels durably recorded slskd searches", async (t) => {
  const playlistId = "provider-work-playlist";
  const jobId = "provider-work-job";
  const originalSettings = dbOps.getSettings();
  const deleteRequests = [];
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    deleteRequests.push(`${request.method} ${request.url}`);
    response.writeHead(204);
    response.end();
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
    },
  });
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Provider Work Playlist",
    tracks: [],
  });
  downloadTracker.addJob(
    { id: jobId, artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  registerDownloadProviderWork({
    jobId,
    playlistId,
    provider: "slskd-search",
    workId: "search-durable",
  });

  try {
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
    await cancellationServiceModule.cancelPlaylistDownloadWork(
      playlistId,
      downloadTracker.getByPlaylistId(playlistId),
    );
    assert.deepEqual(deleteRequests, ["DELETE /api/v0/searches/search-durable"]);
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 0);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed provider cancellation keeps durable slskd work for a later retry", async () => {
  const playlistId = "provider-work-retry-playlist";
  const jobId = "provider-work-retry-job";
  const originalSettings = dbOps.getSettings();
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(503);
    response.end();
  });

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
    },
  });
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Provider Work Retry Playlist",
    tracks: [],
  });
  downloadTracker.addJob(
    { id: jobId, artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  registerDownloadProviderWork({
    jobId,
    playlistId,
    provider: "slskd-search",
    workId: "search-retry",
  });

  try {
    await assert.rejects(
      cancellationServiceModule.cancelPlaylistDownloadWork(
        playlistId,
        downloadTracker.getByPlaylistId(playlistId),
      ),
      /Could not cancel download provider work/,
    );
    assert.equal(
      listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length,
      1,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("SABnzbd cancellation retains a job when a refused queue deletion leaves it queued", async (t) => {
  const playlistId = "sabnzbd-refused-delete";
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Queued Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "SABnzbd_nzo_refused",
  });
  t.mock.method(sabnzbdClient, "isConfigured", () => true);
  t.mock.method(sabnzbdClient, "deleteQueueItem", async () => false);
  t.mock.method(sabnzbdClient, "deleteHistoryItem", async () => false);
  t.mock.method(sabnzbdClient, "getQueueItem", async () => ({ nzo_id: "SABnzbd_nzo_refused" }));
  t.mock.method(sabnzbdClient, "getHistoryItem", async () => null);

  await assert.rejects(
    cancellationServiceModule.cancelPlaylistDownloadWork(
      playlistId,
      downloadTracker.getByPlaylistId(playlistId),
    ),
    /Could not cancel download provider work/,
  );
  assert.equal(downloadTracker.getJob(jobId)?.downloadClientId, "SABnzbd_nzo_refused");
});

test("SABnzbd cancellation accepts already absent queue and history items", async (t) => {
  const playlistId = "sabnzbd-already-absent";
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Completed Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "SABnzbd_nzo_absent",
  });
  t.mock.method(sabnzbdClient, "isConfigured", () => true);
  t.mock.method(sabnzbdClient, "deleteQueueItem", async () => false);
  t.mock.method(sabnzbdClient, "deleteHistoryItem", async () => false);
  t.mock.method(sabnzbdClient, "getQueueItem", async () => null);
  t.mock.method(sabnzbdClient, "getHistoryItem", async () => null);

  await assert.doesNotReject(
    cancellationServiceModule.cancelPlaylistDownloadWork(
      playlistId,
      downloadTracker.getByPlaylistId(playlistId),
    ),
  );
});

test("playlist cancellation keeps provider work retryable when providers are unconfigured", async () => {
  const playlistId = "unconfigured-provider-playlist";
  const originalSettings = dbOps.getSettings();

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {},
  });
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Unconfigured Provider Playlist",
    tracks: [],
  });
  const slskdJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Slskd Song" },
    playlistId,
  );
  const deemixJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Deemix Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(deemixJobId, {
    downloadSource: "deemix",
    downloadClientId: "unconfigured-deemix-queue",
  });
  const sabnzbdJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "SABnzbd Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(sabnzbdJobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "unconfigured-sabnzbd-item",
  });
  const ytdlpJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "yt-dlp Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(ytdlpJobId, { downloadClient: "ytdlp" });
  const stagingPath = path.join(resolveYtdlpStagingRoot(""), "ytdlp", ytdlpJobId);
  await fs.mkdir(stagingPath, { recursive: true });
  await fs.writeFile(path.join(stagingPath, "partial.m4a"), "partial download");
  registerDownloadProviderWork({
    jobId: slskdJobId,
    playlistId,
    provider: "slskd-search",
    workId: "unconfigured-search",
  });

  try {
    await assert.rejects(
      cancellationServiceModule.cancelPlaylistDownloadWork(
        playlistId,
        downloadTracker.getByPlaylistId(playlistId),
      ),
      /Could not cancel download provider work/,
    );

    await assert.rejects(fs.access(stagingPath));
    for (const jobId of [slskdJobId, deemixJobId, sabnzbdJobId]) {
      assert.ok(downloadTracker.getJob(jobId));
    }
    assert.equal(
      listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length,
      1,
    );
    assert.equal(
      isPipelinePayloadActive({ jobId: slskdJobId, playlistId, playlistGeneration: 0 }),
      false,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    clearDownloadProviderWork({ provider: "slskd-search", workId: "unconfigured-search" });
    for (const jobId of [slskdJobId, deemixJobId, sabnzbdJobId, ytdlpJobId]) {
      downloadTracker.removeJob(jobId);
    }
    await fs.rm(stagingPath, { recursive: true, force: true });
  }
});

test("Deemix cleanup ignores jobs without a queue identifier", async () => {
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "No Queue ID" },
    "deemix-empty-queue-id",
  );
  downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "deemix" });

  await assert.doesNotReject(
    cancellationServiceModule.cancelDownloadWorkForJobs([downloadTracker.getJob(jobId)]),
  );
});
