import { usenetCandidate } from "./fixtures.ts";
import { createTrackedJob, trackedJob } from "./fixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

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
  { prowlarrClient },
] = await setupIsolatedBackend(
  "provider-enqueue-cancellation",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellationService.ts"),
  () => import("../../backend/services/usenetOrchestrator.ts"),
  () => import("../../backend/services/deemixOrchestrator.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/sabnzbdClient.ts"),
  () => import("../../backend/services/deemixClient.ts"),
  () => import("../../backend/services/slskdClient.ts"),
  () => import("../../backend/services/prowlarrClient.ts"),
);

beforeEach(() => resetDatabase(db));
afterAll(async () => cleanupIsolatedState(isolatedState));

function createGate() {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    async wait() {
      signalStarted();
      await blocked;
    },
  };
}

function createJob(playlistId: string, trackName: string) {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Race Artist", trackName },
    playlistId,
  );
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
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

type Outcome = { status: "fulfilled"; value: unknown } | { status: "rejected"; error: Error };

const failTheSource = {
  failOrTryNextSource: async (_payload: unknown, _job: unknown, reason: string): Promise<never> => {
    throw new Error(reason);
  },
};

async function assertCancellationWaitsForAdmission({
  gate,
  job,
  payload,
  runPipeline,
  retryCancellation,
  cancelWork = () => cancellationService.cancelDownloadWorkForJobs([job]),
}: {
  gate: ReturnType<typeof createGate>;
  job: ReturnType<typeof createJob>["job"];
  payload: { jobId: string };
  runPipeline: () => Promise<unknown>;
  retryCancellation: () => Promise<unknown>;
  cancelWork?: () => Promise<unknown>;
}) {
  const pipeline = runPipeline();
  const result: { outcome: Outcome | null } = { outcome: null };
  let cancellation: Promise<void> | undefined;
  try {
    await gate.started;
    cancellation = cancelWork().then(
      (value) => {
        result.outcome = { status: "fulfilled", value };
      },
      (error) => {
        result.outcome = { status: "rejected", error };
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitedForAdmission = result.outcome === null;
    gate.release();
    await cancellation;
    assert.equal(await pipeline, null);
    assert.equal(waitedForAdmission, true);
    const { outcome } = result;
    assert.ok(outcome != null);
    assert.equal(outcome.status, "rejected");
    assert.ok(outcome.status === "rejected");
    assert.match(outcome.error.message, /Could not cancel download provider work/);
    assert.ok(downloadTracker.getJob(payload.jobId)?.downloadClientId);
    await retryCancellation();
  } finally {
    gate.release();
    await Promise.allSettled([pipeline, cancellation].filter(Boolean));
  }
}

test("SABnzbd cancellation waits for an in-flight append and can retry cleanup", async () => {
  const playlistId = "sabnzbd-enqueue-race";
  const { job, payload } = createJob(playlistId, "SABnzbd Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let deleteAttempts = 0;

  dbOps.updateSettings({
    integrations: { sabnzbd: { enabled: true, url: "http://sabnzbd.test", apiKey: "test" } },
  });
  vi.spyOn(sabnzbdClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(prowlarrClient, "downloadNzb").mockImplementation(async () =>
    Buffer.from("<nzb></nzb>"),
  );
  vi.spyOn(sabnzbdClient, "appendNzb").mockImplementation(async () => {
    await gate.wait();
    return { nzbId: "sabnzbd-race-item", nzbName: "Race Artist - SABnzbd Song" };
  });
  vi.spyOn(sabnzbdClient, "deleteQueueItem").mockImplementation(async () => ++deleteAttempts > 1);
  vi.spyOn(sabnzbdClient, "getQueueItem").mockImplementation(async () =>
    deleteAttempts === 1 ? { nzo_id: "sabnzbd-race-item" } : null,
  );
  vi.spyOn(sabnzbdClient, "deleteHistoryItem").mockImplementation(async () => false);
  vi.spyOn(sabnzbdClient, "getHistoryItem").mockImplementation(async () => null);

  const pipelinePayload = {
    ...payload,
    phase: "download",
    source: "usenet",
    candidates: [
      usenetCandidate({
        raw: {
          release: {
            downloadUrl: "https://release.test/song.nzb",
            title: "Race Artist - SABnzbd Song",
            guid: "sabnzbd-race-guid",
            indexerId: 1,
            indexer: "Test Indexer",
          },
        },
      }),
    ],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload: pipelinePayload,
      runPipeline: () => processUsenetPipelinePayload(pipelinePayload, failTheSource),
      cancelWork: () =>
        cancellationService.cancelPlaylistDownloadWork(playlistId, [
          trackedJob(downloadTracker, job.id),
        ]),
      retryCancellation: () =>
        cancellationService.cancelDownloadWorkForJobs([trackedJob(downloadTracker, job.id)]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});

test("deemix cancellation waits for an in-flight enqueue and can retry cleanup", async () => {
  const playlistId = "deemix-enqueue-race";
  const { job, payload } = createJob(playlistId, "Deemix Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let removalAttempts = 0;

  dbOps.updateSettings({
    integrations: { deemix: { enabled: true, url: "http://deemix.test", bitrate: 1 } },
  });
  vi.spyOn(deemixClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(deemixClient, "addToQueue").mockImplementation(async () => {
    await gate.wait();
    return "deemix-race-item";
  });
  vi.spyOn(deemixClient, "removeFromQueue").mockImplementation(async () => {
    removalAttempts += 1;
    if (removalAttempts === 1) throw new Error("deemix cleanup temporarily unavailable");
    return true;
  });
  const pipelinePayload = {
    ...payload,
    phase: "download" as const,
    source: "deemix",
    candidates: [
      {
        raw: {
          id: "deemix-race-track",
          url: "https://deemix.test/track/race",
          title: "Deemix Song",
          artist: "Race Artist",
          file: "Race Artist - Deemix Song",
        },
      },
    ],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload: pipelinePayload,
      runPipeline: () => processDeemixPipelinePayload(pipelinePayload, failTheSource),
      retryCancellation: () =>
        cancellationService.cancelDownloadWorkForJobs([trackedJob(downloadTracker, job.id)]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});

test("slskd cancellation waits for an in-flight enqueue and can retry cleanup", async () => {
  const playlistId = "slskd-enqueue-race";
  const { job, payload } = createJob(playlistId, "slskd Song");
  const gate = createGate();
  const originalSettings = dbOps.getSettings();
  let deletionAttempts = 0;

  dbOps.updateSettings({
    integrations: { slskd: { enabled: true, url: "http://slskd.test", apiKey: "test" } },
  });
  vi.spyOn(slskdClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(slskdClient, "enqueueBatch").mockImplementation(async () => {
    await gate.wait();
    return {
      transferId: "slskd-race-transfer",
      username: "race-peer",
      transfers: [{ id: "slskd-race-transfer" }],
      response: {},
    };
  });
  vi.spyOn(slskdClient, "deleteTransfer").mockImplementation(async () => {
    deletionAttempts += 1;
    if (deletionAttempts === 1) throw new Error("slskd cleanup temporarily unavailable");
    return true;
  });
  const pipelinePayload = {
    ...payload,
    phase: "download",
    source: "slskd",
    eventOffset: 0,
    candidates: [
      {
        raw: {
          user: "race-peer",
          file: "Race Artist - slskd Song.flac",
          size: 1024,
        },
      },
    ],
  };

  try {
    await assertCancellationWaitsForAdmission({
      gate,
      job,
      payload: pipelinePayload,
      runPipeline: () => processPipelinePayload(pipelinePayload),
      retryCancellation: () =>
        cancellationService.cancelDownloadWorkForJobs([trackedJob(downloadTracker, job.id)]),
    });
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(job.id);
  }
});
