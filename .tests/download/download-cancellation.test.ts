import { createTrackedJob, localDownloadWorker, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

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
  nzbgetModule,
] = await setupIsolatedBackend(
  "download-cancellation",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellationService.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadFolderConfig.ts"),
  () => import("../../backend/services/sabnzbdClient.ts"),
  () => import("../../backend/services/nzbgetClient.ts"),
);

const {
  activatePlaylistDownloadGeneration,
  cancelDownloadJob,
  cancelPlaylistDownloadGeneration,
  clearDownloadProviderWork,
  getPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  listDownloadProviderWork,
  registerDownloadProviderWork,
} = cancellationModule;
const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { processPlaylistOperation } = operationsModule;
const { playlistManager } = playlistManagerModule;
const downloadWorker = localDownloadWorker(workerModule.downloadWorker);
const { enqueuePipelineJob, listHonkerJobs } = honkerModule;
const { markPlaylistDownloadWorkCancelled } = cancellationServiceModule;
const { dbOps } = dbHelpersModule;
const { resolveYtdlpStagingRoot } = downloadFolderConfigModule;
const { sabnzbdClient, tidarrClient } = sabnzbdModule;
const { nzbgetClient } = nzbgetModule;

beforeEach(async () => {
  await resetDatabase(db);
  db.exec("DELETE FROM weekly_flow_download_job_cancellations");
  db.exec("DELETE FROM weekly_flow_download_cancellations");
  downloadTracker.clearAll();
  downloadWorker.stop();
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("provider cancellation retry retains IDs from pipeline rows removed on the first attempt", async () => {
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  let succeeds = false;
  const remove = vi.spyOn(client, "removeFromQueue").mockImplementation(async () => succeeds);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    "cancellation-retry",
  );
  honkerModule.getPipelineQueue().enqueue({
    jobId,
    playlistId: "cancellation-retry",
    playlistGeneration: 0,
    source: "deemix",
    phase: "poll",
    queueUuid: "provider-id-only-in-payload",
  });
  await assert.rejects(
    cancellationServiceModule.cancelDownloadWorkForJobs([trackedJob(downloadTracker, jobId)]),
  );
  succeeds = true;
  await cancellationServiceModule.cancelDownloadWorkForJobs([trackedJob(downloadTracker, jobId)]);
  assert.equal(remove.mock.calls.length, 2);
  assert.equal(remove.mock.calls[1][0], "provider-id-only-in-payload");
});

test("provider cancellation keeps saved queue IDs when a saved job can't be read", async () => {
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  const remove = vi.spyOn(client, "removeFromQueue").mockImplementation(async () => true);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    "cancellation-unreadable-job",
  );
  dbOps.setJSONSetting(`downloadCancellationWork:${jobId}`, {
    jobs: [{ id: jobId, downloadClientId: 42 }, null],
    payloads: [{ jobId, source: "deemix", queueUuid: "queue-id-only-in-snapshot" }],
  });

  await cancellationServiceModule.cancelDownloadWorkForJobs([trackedJob(downloadTracker, jobId)]);

  assert.deepEqual(
    remove.mock.calls.map(([queueId]) => queueId),
    ["queue-id-only-in-snapshot"],
  );
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

  const orphanedJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Orphaned Song" },
    playlistId,
  );
  assert.ok(orphanedJobId != null);
  const orphanedGeneration = getPlaylistDownloadGeneration(playlistId);
  const activeGeneration = activatePlaylistDownloadGeneration(playlistId);
  const activeJobId = createTrackedJob(
    downloadTracker,
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

  const reloadedTracker = new trackerModule.DownloadTracker();
  assert.equal(reloadedTracker.getJob(orphanedJobId)?.playlistGeneration, orphanedGeneration);
  assert.equal(reloadedTracker.getNextPending()?.id, activeJobId);
});

test("quality-upgrade jobs retain their source playlist generation", () => {
  const playlistId = "upgrade-playlist-generation";
  activatePlaylistDownloadGeneration(playlistId);
  cancelPlaylistDownloadGeneration(playlistId);
  activatePlaylistDownloadGeneration(playlistId);
  const sourceJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Owned Song" },
    playlistId,
  );
  assert.ok(sourceJobId != null);
  downloadTracker.setDone(sourceJobId, "/library/Owned Song.mp3", "Album");
  const playlistGeneration = getPlaylistDownloadGeneration(playlistId);

  const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, sourceJobId));

  assert.ok(upgradeJobId);
  assert.equal(downloadTracker.getJob(sourceJobId)?.playlistGeneration, playlistGeneration);
  assert.equal(downloadTracker.getJob(upgradeJobId)?.playlistGeneration, playlistGeneration);
  assert.equal(
    db
      .prepare<
        unknown[],
        {
          playlist_generation: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["playlist_generation"];
        }
      >("SELECT playlist_generation FROM playlist_download_jobs WHERE id = ?")
      .get(upgradeJobId)?.playlist_generation,
    playlistGeneration,
  );
});

test("pending selection excludes durably cancelled jobs", () => {
  const playlistId = "cancelled-pending-selection";
  const cancelledJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Cancelled Song" },
    playlistId,
  );
  cancelDownloadJob(cancelledJobId);

  assert.equal(downloadTracker.getNextPending(), null);

  const activeJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Active Song" },
    playlistId,
  );
  assert.equal(downloadTracker.getNextPending()?.id, activeJobId);
});

test("deletion marks queued work cancelled before the background operation starts", () => {
  const playlistId = "immediate-delete";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Immediate Delete",
    tracks: [],
  });
  const jobId = createTrackedJob(
    downloadTracker,
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

  assert.equal(
    isPipelinePayloadActive({ jobId, playlistId, playlistGeneration: generation }),
    false,
  );
  assert.equal(
    listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId),
    true,
  );
});

test("static playlist deletion cancels its pipeline before clearing the tracker", async () => {
  const playlistId = "deleted-playlist";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Deleted Playlist",
    tracks: [],
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, "/tmp/aurral-cancellation-song.mp3", "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, jobId));
  assert.ok(upgradeJobId != null);
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

  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "pruneOrphanedJobState").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "setRetryCyclePaused").mockImplementation(() => true);
  vi.spyOn(playlistManager, "updateConfig").mockImplementation(() => {});
  vi.spyOn(playlistManager, "weeklyReset").mockImplementation(async () => {});
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);

  await processPlaylistOperation({
    kind: "shared-playlist-delete",
    playlistId,
  });

  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId), null);
  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(
    isPipelinePayloadActive({
      jobId,
      playlistId,
      playlistGeneration: generation,
    }),
    false,
  );
  assert.equal(
    listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId),
    false,
  );
  assert.equal(
    listHonkerJobs("slskd-pipeline").some((row) => row.id === upgradeQueueJobId),
    false,
  );
});

test("static playlist track replacement cancels dependent quality upgrades", async () => {
  const playlistId = "replaced-playlist";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Replaced Playlist",
    tracks: [],
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, "/tmp/aurral-cancellation-replaced.mp3", "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, jobId));
  assert.ok(upgradeJobId != null);
  const generation = activatePlaylistDownloadGeneration(playlistId);
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: upgradeJobId,
    playlistId,
    playlistGeneration: generation,
    upgrade: true,
  });

  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "pruneOrphanedJobState").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "setRetryCyclePaused").mockImplementation(() => true);
  vi.spyOn(playlistManager, "updateConfig").mockImplementation(() => {});
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);

  await operationsModule.updateStaticPlaylist({
    playlistId,
    tracks: [],
    hasTracksUpdate: true,
  });

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(
    isPipelinePayloadActive({
      jobId: upgradeJobId,
      playlistId,
      playlistGeneration: generation,
    }),
    false,
  );
  assert.equal(
    listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId),
    false,
  );
});

test("playlist deletion cancels durably recorded slskd searches", async () => {
  const playlistId = "provider-work-playlist";
  const jobId = "provider-work-job";
  const originalSettings = dbOps.getSettings();
  const deleteRequests: string[] = [];
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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Provider Work Playlist",
    tracks: [],
  });
  createTrackedJob(downloadTracker, { artistName: "Artist", trackName: "Song" }, playlistId);
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

test("settled slskd searches no longer block playlist cancellation", async () => {
  const playlistId = "settled-search-playlist";
  const originalSettings = dbOps.getSettings();
  const { slskdClient } = await import("../../backend/services/slskdClient.ts");
  const { processPipelinePayload } = await import("../../backend/services/downloadPipeline.ts");
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: "http://slskd.invalid", apiKey: "test-key" },
      ytdlp: { enabled: false },
    },
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  let searchCount = 0;
  vi.spyOn(slskdClient, "createSearch").mockImplementation(async (_query, options) => {
    const id = `settled-search-${++searchCount}`;
    assert.ok(options != null);
    options.onSearchCreated?.(id);
    return { id, searchText: _query };
  });
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => ({
    state: "Completed, TimedOut",
    responses: [],
  }));
  vi.spyOn(slskdClient, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  vi.spyOn(slskdClient, "cleanupAfterRun").mockImplementation(async () => ({
    searchesRemoved: 0,
    transfersRemoved: 0,
    downloadsRemoved: false,
    cleanedSearchIds: [],
  }));

  try {
    let payload: Awaited<ReturnType<typeof processPipelinePayload>> = {
      phase: "search",
      source: "slskd",
      jobId,
      playlistId,
    };
    let sawSearchWork = false;
    while (payload?.phase === "search") {
      payload = await processPipelinePayload(payload);
      sawSearchWork ||=
        listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length > 0;
    }

    assert.ok(searchCount > 0);
    assert.ok(sawSearchWork);
    assert.deepEqual(listDownloadProviderWork({ playlistId, provider: "slskd-search" }), []);
  } finally {
    dbOps.updateSettings(originalSettings);
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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Provider Work Retry Playlist",
    tracks: [],
  });
  createTrackedJob(downloadTracker, { artistName: "Artist", trackName: "Song" }, playlistId);
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
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed static playlist replacement preserves membership and leaves a recoverable job", async () => {
  const playlistId = "shared-playlist-edit-provider-retry";
  const track = { artistName: "Retry Artist", trackName: "Retry Song" };
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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Provider Failure Edit",
    tracks: [track],
    importSource: { provider: "spotify-playlist", keepRemovedTracks: true },
  });
  const jobId = createTrackedJob(downloadTracker, track, playlistId);
  assert.ok(jobId != null);
  registerDownloadProviderWork({
    jobId,
    playlistId,
    provider: "slskd-search",
    workId: "shared-playlist-edit-search",
  });

  try {
    await assert.rejects(
      operationsModule.updateStaticPlaylist({
        playlistId,
        tracks: [],
        hasTracksUpdate: true,
        mergeImportSource: true,
      }),
      /Could not cancel download provider work/,
    );

    assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId)?.tracks.length, 1);
    assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
    assert.equal(isDownloadJobCancelled(jobId), false);
    downloadTracker.setPending(jobId);
    assert.equal(downloadTracker.getNextPending()?.id, jobId);
    assert.equal(listDownloadProviderWork({ jobIds: [jobId], provider: "slskd-search" }).length, 1);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed static playlist deletion preserves membership and leaves a recoverable job", async () => {
  const playlistId = "shared-playlist-delete-provider-retry";
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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Provider Failure Delete",
    tracks: [],
  });
  const generation = activatePlaylistDownloadGeneration(playlistId);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  registerDownloadProviderWork({
    jobId,
    playlistId,
    provider: "slskd-search",
    workId: "shared-playlist-delete-search",
  });
  markPlaylistDownloadWorkCancelled(playlistId, downloadTracker.getByPlaylistId(playlistId));

  try {
    await assert.rejects(
      processPlaylistOperation({ kind: "shared-playlist-delete", playlistId }),
      /Could not cancel download provider work/,
    );

    assert.ok(flowPlaylistConfig.getStaticPlaylist(playlistId));
    assert.equal(isDownloadJobCancelled(jobId), false);
    assert.equal(
      isPipelinePayloadActive({ jobId, playlistId, playlistGeneration: generation }),
      true,
    );
    assert.equal(trackedJob(downloadTracker, jobId).status, "failed");
    assert.equal(downloadTracker.getNextPending(), null);
    assert.ok(downloadTracker.setPending(jobId, null));
    assert.equal(downloadTracker.getNextPending()?.id, jobId);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("SABnzbd cancellation retains a job when a refused queue deletion leaves it queued", async () => {
  const playlistId = "sabnzbd-refused-delete";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Queued Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "SABnzbd_nzo_refused",
  });
  vi.spyOn(sabnzbdClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(sabnzbdClient, "deleteQueueItem").mockImplementation(async () => false);
  vi.spyOn(sabnzbdClient, "deleteHistoryItem").mockImplementation(async () => false);
  vi.spyOn(sabnzbdClient, "getQueueItem").mockImplementation(async () => ({
    nzo_id: "SABnzbd_nzo_refused",
  }));
  vi.spyOn(sabnzbdClient, "getHistoryItem").mockImplementation(async () => null);

  await assert.rejects(
    cancellationServiceModule.cancelPlaylistDownloadWork(
      playlistId,
      downloadTracker.getByPlaylistId(playlistId),
    ),
    /Could not cancel download provider work/,
  );
  assert.equal(downloadTracker.getJob(jobId)?.downloadClientId, "SABnzbd_nzo_refused");
});

test("SABnzbd cancellation accepts already absent queue and history items", async () => {
  const playlistId = "sabnzbd-already-absent";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Completed Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "SABnzbd_nzo_absent",
  });
  vi.spyOn(sabnzbdClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(sabnzbdClient, "deleteQueueItem").mockImplementation(async () => false);
  vi.spyOn(sabnzbdClient, "deleteHistoryItem").mockImplementation(async () => false);
  vi.spyOn(sabnzbdClient, "getQueueItem").mockImplementation(async () => null);
  vi.spyOn(sabnzbdClient, "getHistoryItem").mockImplementation(async () => null);

  await assert.doesNotReject(
    cancellationServiceModule.cancelPlaylistDownloadWork(
      playlistId,
      downloadTracker.getByPlaylistId(playlistId),
    ),
  );
});

test("NZBGet cancellation deletes the tracked queue and history items", async () => {
  const playlistId = "nzbget-cancelled-playlist";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Queued Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "nzbget",
    downloadClientId: 42,
  });
  const calls: (string | unknown[] | undefined)[][] = [];
  vi.spyOn(nzbgetClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(nzbgetClient, "rpc").mockImplementation(async (method, params) => {
    calls.push([method, params]);
    return true;
  });

  await cancellationServiceModule.cancelPlaylistDownloadWork(
    playlistId,
    downloadTracker.getByPlaylistId(playlistId),
  );

  assert.deepEqual(calls, [
    ["editqueue", ["GroupFinalDelete", "", [42]]],
    ["editqueue", ["HistoryFinalDelete", "", [42]]],
  ]);
});

test("Tidarr cancellation deletes the tracked download", async () => {
  const playlistId = "tidarr-cancelled-playlist";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Queued Song" },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "tidarr",
    downloadClientId: "tidarr_nzo_77777",
  });
  const deleted: string[] = [];
  vi.spyOn(tidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(tidarrClient, "deleteQueueItem").mockImplementation(async (id) => {
    deleted.push(String(id));
    return true;
  });
  vi.spyOn(tidarrClient, "deleteHistoryItem").mockImplementation(async () => false);
  vi.spyOn(tidarrClient, "getHistoryItem").mockImplementation(async () => null);

  await cancellationServiceModule.cancelPlaylistDownloadWork(
    playlistId,
    downloadTracker.getByPlaylistId(playlistId),
  );

  assert.deepEqual(deleted, ["tidarr_nzo_77777"]);
});

test("playlist cancellation keeps provider work retryable when providers are unconfigured", async () => {
  const playlistId = "unconfigured-provider-playlist";
  const originalSettings = dbOps.getSettings();

  dbOps.updateSettings({
    ...originalSettings,
    integrations: {},
  });
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Unconfigured Provider Playlist",
    tracks: [],
  });
  const slskdJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Slskd Song" },
    playlistId,
  );
  const deemixJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Deemix Song" },
    playlistId,
  );
  assert.ok(deemixJobId != null);
  downloadTracker.updateDownloadMetadata(deemixJobId, {
    downloadSource: "deemix",
    downloadClientId: "unconfigured-deemix-queue",
  });
  const sabnzbdJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "SABnzbd Song" },
    playlistId,
  );
  assert.ok(sabnzbdJobId != null);
  downloadTracker.updateDownloadMetadata(sabnzbdJobId, {
    downloadClient: "sabnzbd",
    downloadClientId: "unconfigured-sabnzbd-item",
  });
  const ytdlpJobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "yt-dlp Song" },
    playlistId,
  );
  assert.ok(ytdlpJobId != null);
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
      assert.ok(trackedJob(downloadTracker, jobId));
    }
    assert.equal(listDownloadProviderWork({ playlistId, provider: "slskd-search" }).length, 1);
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
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "No Queue ID" },
    "deemix-empty-queue-id",
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "deemix" });

  await assert.doesNotReject(
    cancellationServiceModule.cancelDownloadWorkForJobs([trackedJob(downloadTracker, jobId)]),
  );
});

test("clearing a shown flow or deleting any flow rescans the library", async () => {
  const shown = flowPlaylistConfig.createFlow({ name: "Shown Flow", size: 10 });
  flowPlaylistConfig.updateFlow(shown.id, { showInLibrary: true });
  const hidden = flowPlaylistConfig.createFlow({ name: "Hidden Flow", size: 10 });

  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "setRetryCyclePaused").mockImplementation(() => true);
  vi.spyOn(playlistManager, "updateConfig").mockImplementation(() => {});
  vi.spyOn(playlistManager, "weeklyReset").mockImplementation(async () => {});
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  const scans = vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);

  await processPlaylistOperation({ kind: "disable-flow-cleanup", flowId: hidden.id });
  await processPlaylistOperation({ kind: "reset-playlists", playlistTypes: [hidden.id] });
  assert.equal(scans.mock.calls.length, 0);

  await processPlaylistOperation({ kind: "disable-flow-cleanup", flowId: shown.id });
  assert.equal(scans.mock.calls.length, 1);
  await processPlaylistOperation({ kind: "reset-playlists", playlistTypes: [shown.id] });
  assert.equal(scans.mock.calls.length, 2);
  await processPlaylistOperation({ kind: "delete-flow", flowId: shown.id });
  assert.equal(scans.mock.calls.length, 3);
  assert.equal(flowPlaylistConfig.getFlow(shown.id), null);
  await processPlaylistOperation({ kind: "delete-flow", flowId: hidden.id });
  assert.equal(scans.mock.calls.length, 4);
});

test("rotating a flow shown in the library rescans the library", async () => {
  dbOps.updateSettings({
    integrations: {
      lastfm: { apiKey: "test" },
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });
  const flow = flowPlaylistConfig.createFlow({ name: "Rotating Shown Flow", size: 10 });
  flowPlaylistConfig.updateFlow(flow.id, { showInLibrary: true });

  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "prepareFlowRunPlan").mockImplementation(async () => ({
    primaryTracks: [],
  }));
  vi.spyOn(downloadWorker, "seedFlowRun").mockImplementation(async () => ({
    jobIds: [],
    tracksQueued: 0,
  }));
  vi.spyOn(playlistManager, "updateConfig").mockImplementation(() => {});
  vi.spyOn(playlistManager, "weeklyReset").mockImplementation(async () => {});
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  const scans = vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);

  const result = await processPlaylistOperation({ kind: "manual-start-flow", flowId: flow.id });
  assert.ok(result != null && typeof result === "object" && "empty" in result);

  assert.equal(result.empty, true);
  assert.equal(scans.mock.calls.length, 1);
});
