import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

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
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/playlists/playlistOperations.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/honkerDb.js",
  "backend/services/downloadJobs/downloadCancellationService.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadFolderConfig.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/nzbgetClient.js",
);

const {
  activateOwnerDownloadGeneration,
  cancelDownloadJob,
  cancelOwnerDownloadGeneration,
  clearDownloadProviderWork,
  getOwnerDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  listDownloadProviderWork,
  registerDownloadProviderWork,
} = cancellationModule;
const { downloadTracker } = trackerModule;
const { flowPlaylistConfig } = playlistConfigModule;
const { processPlaylistOperation } = operationsModule;
const { playlistManager } = playlistManagerModule;
const { downloadWorker } = workerModule;
const { enqueuePipelineJob, listHonkerJobs } = honkerModule;
const { markDownloadWorkCancelledForJobs, markOwnerDownloadWorkCancelled } = cancellationServiceModule;
const { dbOps } = dbHelpersModule;
const { resolveYtdlpStagingRoot } = downloadFolderConfigModule;
const { sabnzbdClient } = sabnzbdModule;
const { nzbgetClient } = nzbgetModule;

test.beforeEach(async () => {
  await resetDatabase(db);
  db.exec("DELETE FROM download_job_cancellations");
  db.exec("DELETE FROM download_owner_cancellations");
  downloadTracker.clearAll();
  downloadWorker.stop();
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("provider cancellation retry retains IDs from pipeline rows removed on the first attempt", async (t) => {
  const { getDownloadClient } = await importFromRepo("backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("deemix");
  t.mock.method(client, "isConfigured", () => true);
  let succeeds = false;
  const remove = t.mock.method(client, "removeFromQueue", async () => succeeds);
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, "cancellation-retry");
  honkerModule.getPipelineQueue().enqueue({ jobId, ownerId: "cancellation-retry", ownerGeneration: 0, source: "deemix", phase: "poll", queueUuid: "provider-id-only-in-payload" });
  await assert.rejects(cancellationServiceModule.cancelDownloadWorkForJobs([downloadTracker.getJob(jobId)]));
  succeeds = true;
  await cancellationServiceModule.cancelDownloadWorkForJobs([downloadTracker.getJob(jobId)]);
  assert.equal(remove.mock.callCount(), 2);
  assert.equal(remove.mock.calls[1].arguments[0], "provider-id-only-in-payload");
});

test("playlist deletion invalidates queued payloads across recreation", () => {
  const playlistId = "static-playlist";
  const firstGeneration = activateOwnerDownloadGeneration(playlistId);
  const payload = {
    jobId: "job-one",
    ownerId: playlistId,
    ownerGeneration: firstGeneration,
  };

  assert.equal(isPipelinePayloadActive(payload), true);

  cancelOwnerDownloadGeneration(playlistId);
  assert.equal(isPipelinePayloadActive(payload), false);

  const recreatedGeneration = activateOwnerDownloadGeneration(playlistId);
  assert.equal(recreatedGeneration, firstGeneration + 1);
  assert.equal(isPipelinePayloadActive(payload), false);
  assert.equal(
    isPipelinePayloadActive({
      ...payload,
      jobId: "job-two",
      ownerGeneration: recreatedGeneration,
    }),
    true,
  );
  assert.equal(getOwnerDownloadGeneration(playlistId), recreatedGeneration);
});

test("orphaned playlist jobs stay inactive after recreation and tracker reload", () => {
  const playlistId = "orphaned-playlist-job";
  activateOwnerDownloadGeneration(playlistId);
  cancelOwnerDownloadGeneration(playlistId);

  const orphanedJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Orphaned Song" },
    playlistId,
  );
  const orphanedGeneration = getOwnerDownloadGeneration(playlistId);
  const activeGeneration = activateOwnerDownloadGeneration(playlistId);
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
  assert.equal(downloadTracker.getJob(activeJobId)?.ownerGeneration, activeGeneration);
  assert.equal(downloadTracker.getJob(orphanedJobId)?.ownerGeneration, orphanedGeneration);

  const reloadedTracker = new trackerModule.DownloadTracker();
  assert.equal(reloadedTracker.getJob(orphanedJobId)?.ownerGeneration, orphanedGeneration);
  assert.equal(reloadedTracker.getNextPending()?.id, activeJobId);
});

test("quality-upgrade jobs retain their source playlist generation", () => {
  const playlistId = "upgrade-playlist-generation";
  activateOwnerDownloadGeneration(playlistId);
  cancelOwnerDownloadGeneration(playlistId);
  activateOwnerDownloadGeneration(playlistId);
  const sourceJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Owned Song" },
    playlistId,
  );
  downloadTracker.setDone(sourceJobId, "/library/Owned Song.mp3", "Album");
  const playlistGeneration = getOwnerDownloadGeneration(playlistId);

  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(sourceJobId));

  assert.ok(upgradeJobId);
  assert.equal(downloadTracker.getJob(sourceJobId)?.ownerGeneration, playlistGeneration);
  assert.equal(
    downloadTracker.getJob(upgradeJobId)?.ownerGeneration,
    playlistGeneration,
  );
  assert.equal(
    db.prepare("SELECT owner_generation FROM download_jobs WHERE id = ?")
      .get(upgradeJobId)?.owner_generation,
    playlistGeneration,
  );
});

test("job cancellation remains effective after the tracker row is removed", () => {
  const payload = {
    jobId: "job-removed",
    ownerId: "static-playlist",
    ownerGeneration: 0,
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
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Immediate Delete",
    tracks: [],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  const generation = activateOwnerDownloadGeneration(playlistId);
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId,
    ownerId: playlistId,
    ownerGeneration: generation,
  });
  markOwnerDownloadWorkCancelled(playlistId, downloadTracker.getByOwner(playlistId));

  assert.equal(isPipelinePayloadActive({ jobId, ownerId: playlistId, ownerGeneration: generation }), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId), true);
});

test("static playlist deletion cancels its Library downloads before clearing the tracker", async (t) => {
  const playlistId = "deleted-playlist";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Deleted Playlist",
    tracks: [],
  });
  const [pendingJobId, doneJobId] = addStaticPlaylistJobs(
    { downloadTracker, flowPlaylistConfig },
    playlistId,
    [
      { artistName: "Artist", trackName: "Pending Song" },
      { artistName: "Artist", trackName: "Done Song" },
    ],
  );
  downloadTracker.setDone(doneJobId, "/tmp/aurral-cancellation-song.mp3", "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(doneJobId));
  const generation = activateOwnerDownloadGeneration("library");
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: pendingJobId,
    ownerId: "library",
    ownerGeneration: generation,
  });
  const upgradeQueueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: upgradeJobId,
    ownerId: "library",
    ownerGeneration: generation,
    source: "slskd",
  });

  t.mock.method(downloadWorker, "pruneOrphanedJobState", async () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "deletePlaybackPlaylist", async () => {});
  t.mock.method(playlistManager, "cleanupEntityPlexPlaylists", async () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});

  await processPlaylistOperation({
    kind: "static-playlist-delete",
    playlistId,
  });

  assert.equal(flowPlaylistConfig.getStaticPlaylist(playlistId), null);
  assert.equal(downloadTracker.getJob(pendingJobId), null);
  assert.equal(downloadTracker.getJob(doneJobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(isDownloadJobCancelled(pendingJobId), true);
  assert.equal(isPipelinePayloadActive({
    jobId: pendingJobId,
    ownerId: "library",
    ownerGeneration: generation,
  }), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === queueJobId), false);
  assert.equal(listHonkerJobs("slskd-pipeline").some((row) => row.id === upgradeQueueJobId), false);
});

test("removing finished static playlist tracks cancels their quality upgrades only when files are deleted", async (t) => {
  const playlistId = "replaced-playlist";
  flowPlaylistConfig.createStaticPlaylist({
    id: playlistId,
    name: "Replaced Playlist",
    tracks: [],
  });
  const [keptJobId, deletedJobId] = addStaticPlaylistJobs(
    { downloadTracker, flowPlaylistConfig },
    playlistId,
    [
      { artistName: "Artist", trackName: "Kept Song" },
      { artistName: "Artist", trackName: "Deleted Song" },
    ],
  );
  downloadTracker.setDone(keptJobId, "/tmp/aurral-cancellation-kept.mp3", "Album");
  downloadTracker.setDone(deletedJobId, "/tmp/aurral-cancellation-replaced.mp3", "Album");
  const keptUpgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(keptJobId));
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(deletedJobId));
  const generation = activateOwnerDownloadGeneration("library");
  const queueJobId = enqueuePipelineJob({
    phase: "search",
    jobId: upgradeJobId,
    ownerId: "library",
    ownerGeneration: generation,
    upgrade: true,
  });

  t.mock.method(downloadWorker, "pruneOrphanedJobState", async () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => {});

  await operationsModule.updateStaticPlaylist({
    playlistId,
    tracks: [{ artistName: "Artist", trackName: "Deleted Song" }],
    hasTracksUpdate: true,
  });
  assert.equal(downloadTracker.getJob(keptJobId)?.queuedForPlaylist, false);
  assert.equal(downloadTracker.getJob(keptUpgradeJobId)?.status, "pending");

  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  await processPlaylistOperation({ kind: "static-playlist-delete-track", playlistId, jobId: deletedJobId });

  assert.equal(downloadTracker.getJob(deletedJobId), null);
  assert.equal(downloadTracker.getJob(upgradeJobId), null);
  assert.equal(isPipelinePayloadActive({
    jobId: upgradeJobId,
    ownerId: "library",
    ownerGeneration: generation,
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
  flowPlaylistConfig.createStaticPlaylist({
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
    ownerId: playlistId,
    provider: "slskd-search",
    workId: "search-durable",
  });

  try {
    assert.equal(listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }).length, 1);
    await cancellationServiceModule.cancelOwnerDownloadWork(
      playlistId,
      downloadTracker.getAllForOwner(playlistId),
    );
    assert.deepEqual(deleteRequests, ["DELETE /api/v0/searches/search-durable"]);
    assert.equal(listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }).length, 0);
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("settled slskd searches no longer block playlist cancellation", async (t) => {
  const playlistId = "settled-search-playlist";
  const originalSettings = dbOps.getSettings();
  const { slskdClient } = await importFromRepo("backend/services/slskdClient.js");
  const { processPipelinePayload } = await importFromRepo("backend/services/downloadPipeline.js");
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: "http://slskd.invalid", apiKey: "test-key" },
    },
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  let searchCount = 0;
  t.mock.method(slskdClient, "createSearch", async (_query, options) => {
    const id = `settled-search-${++searchCount}`;
    options.onSearchCreated(id);
    return { id };
  });
  t.mock.method(slskdClient, "getSearch", async () => ({ state: "Completed, TimedOut", responses: [] }));
  t.mock.method(slskdClient, "isCleanupAfterRunsEnabled", () => false);
  t.mock.method(slskdClient, "cleanupAfterRun", async () => ({ cleanedSearchIds: [] }));

  try {
    let payload = { phase: "search", source: "slskd", jobId, ownerId: playlistId };
    let sawSearchWork = false;
    while (payload?.phase === "search") {
      payload = await processPipelinePayload(payload);
      sawSearchWork ||= listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }).length > 0;
    }

    assert.ok(searchCount > 0);
    assert.ok(sawSearchWork);
    assert.deepEqual(listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }), []);
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
  downloadTracker.addJob(
    { id: jobId, artistName: "Artist", trackName: "Song" },
    playlistId,
  );
  registerDownloadProviderWork({
    jobId,
    ownerId: playlistId,
    provider: "slskd-search",
    workId: "search-retry",
  });

  try {
    await assert.rejects(
      cancellationServiceModule.cancelOwnerDownloadWork(
        playlistId,
        downloadTracker.getAllForOwner(playlistId),
      ),
      /Could not cancel download provider work/,
    );
    assert.equal(
      listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }).length,
      1,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed static playlist replacement preserves membership and leaves a recoverable job", async () => {
  const playlistId = "static-playlist-edit-provider-retry";
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
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlistId, [track]);
  downloadTracker.setDownloading(jobId);
  registerDownloadProviderWork({
    jobId,
    ownerId: "library",
    provider: "slskd-search",
    workId: "static-playlist-edit-search",
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
    assert.equal(
      listDownloadProviderWork({ jobIds: [jobId], provider: "slskd-search" }).length,
      1,
    );
  } finally {
    dbOps.updateSettings(originalSettings);
    await mock.close();
  }
});

test("failed static playlist deletion preserves membership and leaves a recoverable job", async () => {
  const playlistId = "static-playlist-delete-provider-retry";
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
  const generation = activateOwnerDownloadGeneration("library");
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlistId, [
    { artistName: "Artist", trackName: "Song" },
  ]);
  downloadTracker.setDownloading(jobId);
  markDownloadWorkCancelledForJobs([downloadTracker.getJob(jobId)]);
  registerDownloadProviderWork({
    jobId,
    ownerId: "library",
    provider: "slskd-search",
    workId: "static-playlist-delete-search",
  });

  try {
    await assert.rejects(
      processPlaylistOperation({ kind: "static-playlist-delete", playlistId }),
      /Could not cancel download provider work/,
    );

    assert.ok(flowPlaylistConfig.getStaticPlaylist(playlistId));
    assert.equal(isDownloadJobCancelled(jobId), false);
    assert.equal(
      isPipelinePayloadActive({ jobId, ownerId: "library", ownerGeneration: generation }),
      true,
    );
    assert.equal(downloadTracker.getJob(jobId).status, "failed");
    assert.equal(downloadTracker.getNextPending(), null);
    assert.ok(downloadTracker.setPending(jobId, null));
    assert.equal(downloadTracker.getNextPending()?.id, jobId);
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
    cancellationServiceModule.cancelOwnerDownloadWork(
      playlistId,
      downloadTracker.getAllForOwner(playlistId),
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
    cancellationServiceModule.cancelOwnerDownloadWork(
      playlistId,
      downloadTracker.getAllForOwner(playlistId),
    ),
  );
});

test("NZBGet cancellation deletes the tracked queue and history items", async (t) => {
  const playlistId = "nzbget-cancelled-playlist";
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Queued Song" },
    playlistId,
  );
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadClient: "nzbget",
    downloadClientId: 42,
  });
  const calls = [];
  t.mock.method(nzbgetClient, "isConfigured", () => true);
  t.mock.method(nzbgetClient, "rpc", async (method, params) => {
    calls.push([method, params]);
    return true;
  });

  await cancellationServiceModule.cancelOwnerDownloadWork(
    playlistId,
    downloadTracker.getAllForOwner(playlistId),
  );

  assert.deepEqual(calls, [
    ["editqueue", ["GroupFinalDelete", "", [42]]],
    ["editqueue", ["HistoryFinalDelete", "", [42]]],
  ]);
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
    ownerId: playlistId,
    provider: "slskd-search",
    workId: "unconfigured-search",
  });

  try {
    await assert.rejects(
      cancellationServiceModule.cancelOwnerDownloadWork(
        playlistId,
        downloadTracker.getAllForOwner(playlistId),
      ),
      /Could not cancel download provider work/,
    );

    await assert.rejects(fs.access(stagingPath));
    for (const jobId of [slskdJobId, deemixJobId, sabnzbdJobId]) {
      assert.ok(downloadTracker.getJob(jobId));
    }
    assert.equal(
      listDownloadProviderWork({ ownerId: playlistId, provider: "slskd-search" }).length,
      1,
    );
    assert.equal(
      isPipelinePayloadActive({ jobId: slskdJobId, ownerId: playlistId, ownerGeneration: 0 }),
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

test("clearing a shown flow or deleting any flow rescans the library", async (t) => {
  const shown = flowPlaylistConfig.createFlow({ name: "Shown Flow", size: 10 });
  flowPlaylistConfig.updateFlow(shown.id, { showInLibrary: true });
  const hidden = flowPlaylistConfig.createFlow({ name: "Hidden Flow", size: 10 });

  t.mock.method(downloadWorker, "blockPlaylist", async () => {});
  t.mock.method(downloadWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(downloadWorker, "unblockPlaylist", async () => {});
  t.mock.method(downloadWorker, "setRetryCyclePaused", () => {});
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "deletePlaybackPlaylist", async () => {});
  t.mock.method(playlistManager, "clearFlowFiles", async () => {});
  t.mock.method(playlistManager, "cleanupEntityPlexPlaylists", async () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  const scans = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});

  await processPlaylistOperation({ kind: "disable-flow-cleanup", flowId: hidden.id });
  await processPlaylistOperation({ kind: "reset-flows", flowIds: [hidden.id] });
  assert.equal(scans.mock.callCount(), 0);

  await processPlaylistOperation({ kind: "disable-flow-cleanup", flowId: shown.id });
  assert.equal(scans.mock.callCount(), 1);
  await processPlaylistOperation({ kind: "reset-flows", flowIds: [shown.id] });
  assert.equal(scans.mock.callCount(), 2);
  await processPlaylistOperation({ kind: "delete-flow", flowId: shown.id });
  assert.equal(scans.mock.callCount(), 3);
  assert.equal(flowPlaylistConfig.getFlow(shown.id), null);
  await processPlaylistOperation({ kind: "delete-flow", flowId: hidden.id });
  assert.equal(scans.mock.callCount(), 4);
});

test("rotating a flow shown in the library rescans the library", async (t) => {
  dbOps.updateSettings({
    integrations: {
      lastfm: { apiKey: "test" },
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });
  const flow = flowPlaylistConfig.createFlow({ name: "Rotating Shown Flow", size: 10 });
  flowPlaylistConfig.updateFlow(flow.id, { showInLibrary: true });

  t.mock.method(downloadWorker, "blockPlaylist", async () => {});
  t.mock.method(downloadWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(downloadWorker, "unblockPlaylist", async () => {});
  t.mock.method(downloadWorker, "prepareFlowRunPlan", async () => ({}));
  t.mock.method(downloadWorker, "seedFlowRun", async () => ({ jobIds: [], tracksQueued: 0 }));
  t.mock.method(playlistManager, "updateConfig", () => {});
  t.mock.method(playlistManager, "clearFlowFiles", async () => {});
  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  const scans = t.mock.method(playlistManager, "scheduleScanLibrary", () => {});

  const result = await processPlaylistOperation({ kind: "manual-start-flow", flowId: flow.id });

  assert.equal(result.empty, true);
  assert.equal(scans.mock.callCount(), 1);
});
