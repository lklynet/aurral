import { isStepFrom, stepFrom, usenetCandidate } from "./fixtures.ts";
import { createTrackedJob, recordSourceFailures } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { getDownloadClient },
  { processPipelinePayload },
  { processSourcePipelinePayload },
  { usenetSource },
] = await setupIsolatedBackend(
  "transfer-timeouts",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/download/sourcePipeline.ts"),
  () => import("../../backend/services/usenetSource.ts"),
);

beforeEach(() => {
  failures.length = 0;
  resetDatabase(db);
});
afterAll(() => cleanupIsolatedState(state));

const HOUR_MS = 60 * 60 * 1000;

function addJob() {
  return createTrackedJob(
    downloadTracker,
    { artistName: "The Band", trackName: "First", durationMs: 180000 },
    "timeouts",
  );
}

const { reasons: failures, helpers: failSource } = recordSourceFailures();

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
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({
    events: [],
    count: 0,
    totalCount: 0,
  }));
  vi.spyOn(client, "getTransfer").mockImplementation(async () => queued);
  const removed = vi.spyOn(client, "deleteTransfer").mockImplementation(async () => true);
  const jobId = addJob();
  const polling = {
    phase: "poll",
    source: "slskd" as const,
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
  assert.ok(isStepFrom(waiting, "slskd"));
  assert.equal(waiting.phase, "poll");
  const longAgo = Date.now() - HOUR_MS;
  const moving = await processPipelinePayload({
    ...waiting,
    lastProgress: "older",
    lastProgressAt: longAgo,
  });
  assert.ok(moving != null);
  assert.equal(moving.phase, "poll");
  assert.equal(removed.mock.calls.length, 0);

  const stalled = await processPipelinePayload({ ...waiting, lastProgressAt: longAgo });
  assert.ok(stalled != null);
  assert.equal(removed.mock.calls.length, 1);
  assert.equal(stalled.phase, "download");
  assert.equal(stalled.candidateIndex, 1);

  queued.state = "Completed, TimedOut";
  assert.equal((await processPipelinePayload(polling))!.phase, "download");
});

test("an slskd download-complete event for the candidate finishes polling with its transfer", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  const done = {
    id: "transfer-2",
    username: "Peer",
    filename: "Music\\Album\\02 Second.flac",
    state: "Completed, Succeeded",
  };
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({
    events: [
      {
        type: "DownloadFileComplete",
        data: { transfer: { ...done, id: "transfer-1", filename: "Music\\Album\\01 First.flac" } },
      },
      { type: "DownloadFileComplete", data: { transfer: done } },
    ],
    count: 5,
    totalCount: 12,
  }));
  const jobId = addJob();

  const next = await processPipelinePayload({
    phase: "poll",
    source: "slskd" as const,
    jobId,
    eventOffset: 7,
    candidateIndex: 0,
    candidates: [{ raw: { user: "peer", file: "Music/Album/02 Second.flac" } }],
  });

  assert.equal(next?.phase, "finalize");
  assert.deepEqual(stepFrom(next, "slskd").batch, { transfers: [done] });
  assert.equal(stepFrom(next, "slskd").eventOffset, 12);
});

test("an slskd download-complete event passes on the path slskd saved the file to", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  const done = {
    id: "transfer-1",
    username: "Peer",
    filename: "Music\\Album\\01 First.flac",
    state: "Completed, Succeeded",
  };
  const localFilename = "/downloads/Album/01 First_639268025041726158.flac";
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({
    events: [
      { type: "DownloadFileComplete", data: { transfer: done, localFilename } },
      {
        type: "DownloadDirectoryComplete",
        data: { username: "Peer", remoteDirectoryName: "Music\\Album" },
      },
    ],
    count: 2,
    totalCount: 2,
  }));
  const jobId = addJob();

  const next = await processPipelinePayload({
    phase: "poll",
    source: "slskd" as const,
    jobId,
    eventOffset: 0,
    candidateIndex: 0,
    candidates: [{ raw: { user: "peer", file: "Music/Album/01 First.flac" } }],
  });

  assert.equal(next?.phase, "finalize");
  assert.deepEqual(stepFrom(next, "slskd").batch, { transfers: [done], localFilename });
});

test("a rejected slskd transfer moves to the next user instead of retrying the same one", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({
    events: [],
    count: 0,
    totalCount: 0,
  }));
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
    source: "slskd" as const,
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
  assert.ok(next != null);
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
  vi.spyOn(client, "getEvents").mockImplementation(async () => ({
    events: [],
    count: 0,
    totalCount: 0,
  }));
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
    source: "slskd" as const,
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
  assert.ok(isStepFrom(waiting, "slskd"));
  const quarterHourAgo = Date.now() - 15 * 60 * 1000;

  const moved = await processPipelinePayload({ ...waiting, lastProgressAt: quarterHourAgo });
  assert.ok(moved != null);
  assert.equal(moved.phase, "download");
  assert.equal(moved.candidateIndex, 1);
  assert.equal(removed.mock.calls.length, 1);

  const lastCandidate = await processPipelinePayload({
    ...waiting,
    candidateIndex: 1,
    lastProgressAt: quarterHourAgo,
  });
  assert.ok(lastCandidate != null);
  assert.equal(lastCandidate.phase, "poll");
});

const directory = "/nonexistent/aurral-usenet-handover";

test("a paused or post-processing Usenet download keeps waiting while the client holds it", async () => {
  const nzbget = getDownloadClient("nzbget");
  vi.spyOn(nzbget, "getHistoryItem").mockImplementation(async () => null);
  vi.spyOn(nzbget, "getQueueItem").mockImplementation(async () => ({ NZBID: 7, Status: "PAUSED" }));
  const sabnzbd = getDownloadClient("sabnzbd");
  vi.spyOn(sabnzbd, "getHistoryItem").mockImplementation(async () => ({
    nzo_id: "SAB_1",
    status: "Extracting",
  }));
  vi.spyOn(sabnzbd, "getQueueItem").mockImplementation(async () => null);

  assert.deepEqual(await usenetSource.status({ id: "nzbget:7", directory }), { done: false });
  assert.deepEqual(await usenetSource.status({ id: "sabnzbd:SAB_1", directory }), {
    done: false,
  });
});

test("a Usenet download that left both the queue and the history is gone", async () => {
  const client = getDownloadClient("nzbget");
  const history = vi.spyOn(client, "getHistoryItem").mockImplementation(async () => null);
  vi.spyOn(client, "getQueueItem").mockImplementation(async () => null);
  await assert.rejects(
    usenetSource.status({ id: "nzbget:7", directory }),
    /left the download client/,
  );
  assert.equal(history.mock.calls.length, 2);
});

test("an NZBGet download that failed is removed from the client", async () => {
  const client = getDownloadClient("nzbget");
  vi.spyOn(client, "isConfigured").mockImplementation(() => true);
  vi.spyOn(client, "getHistoryItem").mockImplementation(async () => ({
    NZBID: 7,
    Status: "FAILURE/PAR",
  }));
  const fromQueue = vi.spyOn(client, "deleteQueueItem").mockImplementation(async () => true);
  const fromHistory = vi.spyOn(client, "deleteHistoryItem").mockImplementation(async () => true);
  const jobId = addJob();
  const result = await processSourcePipelinePayload(
    {
      phase: "poll",
      source: "usenet",
      jobId,
      pendingId: "nzbget:7",
      candidateIndex: 0,
      candidates: [usenetCandidate({ guid: "broken", title: "First" })],
    },
    usenetSource,
    failSource,
  );
  assert.equal(result, null);
  assert.match(requireFixture(failures[0]), /Usenet download failed/);
  assert.deepEqual(
    [fromQueue, fromHistory].map((mock) => mock.mock.calls.map((call) => call[0])),
    [["7"], ["7"]],
  );
});
