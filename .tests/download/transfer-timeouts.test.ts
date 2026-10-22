import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { getDownloadClient },
  { processPipelinePayload },
  { processUsenetPipelinePayload },
] = await setupIsolatedBackend(
  "transfer-timeouts",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/download/downloadClientSettings.ts",
  "backend/services/downloadPipeline.ts",
  "backend/services/usenetOrchestrator.ts",
);

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(state));

const HOUR_MS = 60 * 60 * 1000;

function addJob() {
  return downloadTracker.addJob(
    { artistName: "The Band", trackName: "First", durationMs: 180000 },
    "timeouts",
  );
}

const failSource = { failOrTryNextSource: (_payload, _job, reason) => ({ failed: reason }) };

test("a stalled slskd transfer is cancelled and the next candidate is tried", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  const queued = {
    id: "transfer-1",
    username: "slow",
    state: "Queued, Remotely",
    bytesTransferred: 0,
    placeInQueue: 12,
  };
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({ events: [], totalCount: 0 }));
  vi.spyOn(client, "getTransfer").mockImplementation(async () => queued);
  const removed = vi.spyOn(client, "deleteTransfer").mockImplementation(async () => true);
  const jobId = addJob();
  const polling = {
    phase: "poll",
    source: "slskd",
    jobId,
    eventOffset: 0,
    legacyTransfer: { id: "transfer-1", username: "slow" },
    candidateIndex: 0,
    candidates: [
      { raw: { user: "slow", file: "a.flac" } },
      { raw: { user: "fast", file: "b.flac" } },
    ],
  };

  const waiting = await processPipelinePayload(polling);
  assert.equal(waiting.phase, "poll");
  const longAgo = Date.now() - HOUR_MS;
  const moving = await processPipelinePayload({
    ...waiting,
    lastProgress: "older",
    lastProgressAt: longAgo,
  });
  assert.equal(moving.phase, "poll");
  assert.equal(removed.mock.calls.length, 0);

  const stalled = await processPipelinePayload({ ...waiting, lastProgressAt: longAgo });
  assert.equal(removed.mock.calls.length, 1);
  assert.equal(stalled.phase, "download");
  assert.equal(stalled.candidateIndex, 1);

  queued.state = "Completed, TimedOut";
  assert.equal((await processPipelinePayload(polling)).phase, "download");
});

test("a rejected slskd transfer moves to the next user instead of retrying the same one", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({ events: [], totalCount: 0 }));
  vi.spyOn(client, "getTransfer").mockImplementation(async () => ({
    id: "transfer-1",
    username: "strict",
    state: "Completed, Rejected",
    exception: "Transfer rejected: Banned",
  }));
  vi.spyOn(client, "deleteTransfer").mockImplementation(async () => true);
  const jobId = addJob();
  const polling = {
    phase: "poll",
    source: "slskd",
    jobId,
    eventOffset: 0,
    legacyTransfer: { id: "transfer-1", username: "strict" },
    candidateIndex: 0,
    candidates: [
      { raw: { user: "strict", file: "a.flac" } },
      { raw: { user: "open", file: "b.flac" } },
    ],
  };

  const next = await processPipelinePayload(polling);
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
});

test("a file in an uploader's queue moves to the next candidate after 10 minutes", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({ events: [], totalCount: 0 }));
  vi.spyOn(client, "getTransfer").mockImplementation(async () => ({
    id: "transfer-1",
    username: "busy",
    state: "Queued, Remotely",
    bytesTransferred: 0,
  }));
  const removed = vi.spyOn(client, "deleteTransfer").mockImplementation(async () => true);
  const jobId = addJob();
  const polling = {
    phase: "poll",
    source: "slskd",
    jobId,
    eventOffset: 0,
    legacyTransfer: { id: "transfer-1", username: "busy" },
    candidateIndex: 0,
    candidates: [
      { raw: { user: "busy", file: "a.flac" } },
      { raw: { user: "free", file: "b.flac" } },
    ],
  };
  const waiting = await processPipelinePayload(polling);
  const quarterHourAgo = Date.now() - 15 * 60 * 1000;

  const moved = await processPipelinePayload({ ...waiting, lastProgressAt: quarterHourAgo });
  assert.equal(moved.phase, "download");
  assert.equal(moved.candidateIndex, 1);
  assert.equal(removed.mock.calls.length, 1);

  const lastCandidate = await processPipelinePayload({
    ...waiting,
    candidateIndex: 1,
    lastProgressAt: quarterHourAgo,
  });
  assert.equal(lastCandidate.phase, "poll");
});

test("a paused Usenet download keeps waiting while the client holds it", async () => {
  const client = getDownloadClient("nzbget");
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => null);
  vi.spyOn(client, "getQueueItem").mockImplementation(async () => ({ NZBID: 7, Status: "PAUSED" }));
  const jobId = addJob();
  const next = await processUsenetPipelinePayload(
    {
      phase: "poll",
      source: "usenet",
      jobId,
      downloadClient: "nzbget",
      nzbId: 7,
      pollAttempts: 5000,
    },
    failSource,
  );
  assert.equal(next.phase, "poll");
  assert.equal(next.missingPolls, 0);
});

test("a Usenet download that leaves the client moves to the next release", async () => {
  const client = getDownloadClient("nzbget");
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => null);
  vi.spyOn(client, "getQueueItem").mockImplementation(async () => null);
  const jobId = addJob();
  const payload = {
    phase: "poll",
    source: "usenet",
    jobId,
    downloadClient: "nzbget",
    nzbId: 7,
    candidateIndex: 0,
    candidates: [{ raw: { release: { guid: "a" } } }, { raw: { release: { guid: "b" } } }],
  };
  const waiting = await processUsenetPipelinePayload(payload, failSource);
  assert.equal(waiting.phase, "poll");
  assert.equal(waiting.missingPolls, 1);
  const next = await processUsenetPipelinePayload({ ...waiting, missingPolls: 60 }, failSource);
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
  assert.equal(next.nzbId, null);
});

test("an NZBGet download that failed is removed from the client", async () => {
  const client = getDownloadClient("nzbget");
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => ({
    NZBID: 7,
    Status: "FAILURE/PAR",
  }));
  const fromQueue = vi.spyOn(client, "deleteQueueItem").mockImplementation(async () => true);
  const fromHistory = vi.spyOn(client, "deleteHistoryItem").mockImplementation(async () => true);
  const jobId = addJob();
  const result = await processUsenetPipelinePayload(
    {
      phase: "poll",
      source: "usenet",
      jobId,
      downloadClient: "nzbget",
      nzbId: 7,
      candidateIndex: 0,
      candidates: [{ raw: { release: { guid: "broken" } } }],
    },
    failSource,
  );
  assert.match(result.failed, /Usenet download failed/);
  assert.deepEqual(
    fromQueue.mock.calls.map((call) => call[0]),
    [7],
  );
  assert.deepEqual(
    fromHistory.mock.calls.map((call) => call[0]),
    [7],
  );
});

test("a Usenet download still post-processing in the client keeps waiting", async () => {
  const client = getDownloadClient("sabnzbd");
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => ({
    nzo_id: "SAB_1",
    status: "Extracting",
  }));
  vi.spyOn(client, "getQueueItem").mockImplementation(async () => null);
  const jobId = addJob();
  const next = await processUsenetPipelinePayload(
    {
      phase: "poll",
      source: "usenet",
      jobId,
      downloadClient: "sabnzbd",
      nzbId: "SAB_1",
      missingPolls: 60,
    },
    failSource,
  );
  assert.equal(next.phase, "poll");
  assert.equal(next.missingPolls, 0);
});
