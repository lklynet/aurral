import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  cancellationService,
  { processUsenetPipelinePayload },
  { processDeemixPipelinePayload },
  { processPipelinePayload },
  { sabnzbdClient },
  { deemixClient },
  { slskdClient },
] = await setupIsolatedBackend(
  "provider-enqueue-cancellation",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellationService.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/deemixOrchestrator.js",
  "backend/services/slskdOrchestrator.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/deemixClient.js",
  "backend/services/slskdClient.js",
);

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

function createGate() {
  let signalStarted;
  let release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release,
    async wait() {
      signalStarted();
      await blocked;
    },
  };
}

function createJob(playlistId, trackName) {
  const jobId = downloadTracker.addJob({ artistName: "Race Artist", trackName }, playlistId);
  const job = downloadTracker.getJob(jobId);
  return {
    job,
    payload: {
      jobId,
      playlistId,
      playlistGeneration: job.playlistGeneration,
      track: { artistName: "Race Artist", trackName },
      destination: `cancellation-race/${playlistId}`,
    },
  };
}

async function assertCancellationWaitsForAdmission({
  gate,
  job,
  payload,
  runPipeline,
  retryCancellation,
  cancelWork = () => cancellationService.cancelDownloadWorkForJobs([job]),
}) {
  const pipeline = runPipeline();
  let outcome = null;
  let cancellation;
  try {
    await gate.started;
    cancellation = cancelWork().then(
      (value) => { outcome = { status: "fulfilled", value }; },
      (error) => { outcome = { status: "rejected", error }; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const waitedForAdmission = outcome === null;
    gate.release();
    await cancellation;
    assert.equal(await pipeline, null);
    assert.equal(waitedForAdmission, true);
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.error.message, /Could not cancel download provider work/);
    assert.ok(downloadTracker.getJob(payload.jobId)?.downloadClientId);
    await retryCancellation();
  } finally {
    gate.release();
    await Promise.allSettled([pipeline, cancellation].filter(Boolean));
  }
}

test("SABnzbd cancellation waits for an in-flight append and can retry cleanup", async (t) => {
  const playlistId = "sabnzbd-enqueue-race";
  const { job, payload } = createJob(playlistId, "SABnzbd Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let deleteAttempts = 0;

  dbOps.updateSettings({
    integrations: { sabnzbd: { enabled: true, url: "http://sabnzbd.test", apiKey: "test" } },
  });
  t.mock.method(sabnzbdClient, "isConfigured", () => true);
  t.mock.method(sabnzbdClient, "appendUrl", async () => {
    await gate.wait();
    return { nzbId: "sabnzbd-race-item" };
  });
  t.mock.method(sabnzbdClient, "deleteQueueItem", async () => ++deleteAttempts > 1);
  t.mock.method(sabnzbdClient, "getQueueItem", async () =>
    deleteAttempts === 1 ? { nzo_id: "sabnzbd-race-item" } : null,
  );
  t.mock.method(sabnzbdClient, "deleteHistoryItem", async () => false);
  t.mock.method(sabnzbdClient, "getHistoryItem", async () => null);

  const pipelinePayload = {
    ...payload,
    phase: "download",
    source: "usenet",
    candidates: [{ raw: { release: {
      downloadUrl: "https://release.test/song.nzb",
      title: "Race Artist - SABnzbd Song",
      guid: "sabnzbd-race-guid",
      indexerId: 1,
      indexer: "Test Indexer",
    } } }],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload: pipelinePayload,
      runPipeline: () => processUsenetPipelinePayload(pipelinePayload),
      cancelWork: () => cancellationService.cancelPlaylistDownloadWork(
        playlistId,
        [downloadTracker.getJob(job.id)],
      ),
      retryCancellation: () => cancellationService.cancelDownloadWorkForJobs([
        downloadTracker.getJob(job.id),
      ]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});

test("deemix cancellation waits for an in-flight enqueue and can retry cleanup", async (t) => {
  const playlistId = "deemix-enqueue-race";
  const { job, payload } = createJob(playlistId, "Deemix Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let removalAttempts = 0;

  dbOps.updateSettings({
    integrations: { deemix: { enabled: true, url: "http://deemix.test", bitrate: 1 } },
  });
  t.mock.method(deemixClient, "isConfigured", () => true);
  t.mock.method(deemixClient, "addToQueue", async () => {
    await gate.wait();
    return "deemix-race-item";
  });
  t.mock.method(deemixClient, "removeFromQueue", async () => {
    removalAttempts += 1;
    if (removalAttempts === 1) throw new Error("deemix cleanup temporarily unavailable");
    return true;
  });
  const pipelinePayload = {
    ...payload,
    phase: "download",
    source: "deemix",
    candidates: [{ raw: {
      id: "deemix-race-track",
      url: "https://deemix.test/track/race",
      title: "Deemix Song",
      artist: "Race Artist",
      file: "Race Artist - Deemix Song",
    } }],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload,
      payload: pipelinePayload,
      runPipeline: () => processDeemixPipelinePayload(pipelinePayload),
      retryCancellation: () => cancellationService.cancelDownloadWorkForJobs([
        downloadTracker.getJob(job.id),
      ]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});

test("slskd cancellation waits for an in-flight enqueue and can retry cleanup", async (t) => {
  const playlistId = "slskd-enqueue-race";
  const { job, payload } = createJob(playlistId, "slskd Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let deletionAttempts = 0;

  dbOps.updateSettings({
    integrations: { slskd: { enabled: true, url: "http://slskd.test", apiKey: "test" } },
  });
  t.mock.method(slskdClient, "isConfigured", () => true);
  t.mock.method(slskdClient, "enqueueBatch", async () => {
    await gate.wait();
    return {
      batchId: null,
      transferId: "slskd-race-transfer",
      username: "race-peer",
      transfers: [{ id: "slskd-race-transfer" }],
    };
  });
  t.mock.method(slskdClient, "deleteTransfer", async () => {
    deletionAttempts += 1;
    if (deletionAttempts === 1) throw new Error("slskd cleanup temporarily unavailable");
    return true;
  });
  const pipelinePayload = {
    ...payload,
    phase: "download",
    source: "slskd",
    eventOffset: 0,
    candidates: [{ raw: {
      user: "race-peer",
      file: "Race Artist - slskd Song.flac",
      size: 1024,
    } }],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload,
      payload: pipelinePayload,
      runPipeline: () => processPipelinePayload(pipelinePayload),
      retryCancellation: () => cancellationService.cancelDownloadWorkForJobs([
        downloadTracker.getJob(job.id),
      ]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});
