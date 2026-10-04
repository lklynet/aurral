import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { getDownloadClient },
  { processPipelinePayload }, { processUsenetPipelinePayload }] = await setupIsolatedBackend(
  "transfer-timeouts",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/download/downloadClientSettings.js",
  "backend/services/downloadPipeline.js",
  "backend/services/usenetOrchestrator.js",
);

test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(state));

const HOUR_MS = 60 * 60 * 1000;

function addJob() {
  return downloadTracker.addJob({ artistName: "The Band", trackName: "First", durationMs: 180000 }, "timeouts");
}

const failSource = { failOrTryNextSource: (_payload, _job, reason) => ({ failed: reason }) };

test("a stalled slskd transfer is cancelled and the next candidate is tried", async (t) => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const client = getDownloadClient("slskd");
  const queued = { id: "transfer-1", username: "slow", state: "Queued, Remotely",
    bytesTransferred: 0, placeInQueue: 12 };
  t.mock.method(client, "getEvents", async () => ({ events: [], totalCount: 0 }));
  t.mock.method(client, "getTransfer", async () => queued);
  const removed = t.mock.method(client, "deleteTransfer", async () => true);
  const jobId = addJob();
  const polling = { phase: "poll", source: "slskd", jobId, eventOffset: 0,
    legacyTransfer: { id: "transfer-1", username: "slow" }, candidateIndex: 0,
    candidates: [{ raw: { user: "slow", file: "a.flac" } }, { raw: { user: "fast", file: "b.flac" } }] };

  const waiting = await processPipelinePayload(polling);
  assert.equal(waiting.phase, "poll");
  const longAgo = Date.now() - HOUR_MS;
  const moving = await processPipelinePayload({ ...waiting, lastProgress: "older", lastProgressAt: longAgo });
  assert.equal(moving.phase, "poll");
  assert.equal(removed.mock.callCount(), 0);

  const stalled = await processPipelinePayload({ ...waiting, lastProgressAt: longAgo });
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(stalled.phase, "download");
  assert.equal(stalled.candidateIndex, 1);

  queued.state = "Completed, TimedOut";
  assert.equal((await processPipelinePayload(polling)).phase, "download");
});

test("a paused Usenet download keeps waiting while the client holds it", async (t) => {
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "getHistoryItem", async () => null);
  t.mock.method(client, "getQueueItem", async () => ({ NZBID: 7, Status: "PAUSED" }));
  const jobId = addJob();
  const next = await processUsenetPipelinePayload({ phase: "poll", source: "usenet", jobId,
    downloadClient: "nzbget", nzbId: 7, pollAttempts: 5000 }, failSource);
  assert.equal(next.phase, "poll");
  assert.equal(next.missingPolls, 0);
});

test("a Usenet download that leaves the client moves to the next release", async (t) => {
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "getHistoryItem", async () => null);
  t.mock.method(client, "getQueueItem", async () => null);
  const jobId = addJob();
  const payload = { phase: "poll", source: "usenet", jobId, downloadClient: "nzbget", nzbId: 7,
    candidateIndex: 0, candidates: [{ raw: { release: { guid: "a" } } }, { raw: { release: { guid: "b" } } }] };
  const waiting = await processUsenetPipelinePayload(payload, failSource);
  assert.equal(waiting.phase, "poll");
  assert.equal(waiting.missingPolls, 1);
  const next = await processUsenetPipelinePayload({ ...waiting, missingPolls: 60 }, failSource);
  assert.equal(next.phase, "download");
  assert.equal(next.candidateIndex, 1);
  assert.equal(next.nzbId, null);
});

test("an NZBGet download that failed is removed from the client", async (t) => {
  const client = getDownloadClient("nzbget");
  t.mock.method(client, "getHistoryItem", async () => ({ NZBID: 7, Status: "FAILURE/PAR" }));
  const fromQueue = t.mock.method(client, "deleteQueueItem", async () => true);
  const fromHistory = t.mock.method(client, "deleteHistoryItem", async () => true);
  const jobId = addJob();
  const result = await processUsenetPipelinePayload({ phase: "poll", source: "usenet", jobId,
    downloadClient: "nzbget", nzbId: 7, candidateIndex: 0,
    candidates: [{ raw: { release: { guid: "broken" } } }] }, failSource);
  assert.match(result.failed, /Usenet download failed/);
  assert.deepEqual(fromQueue.mock.calls.map((call) => call.arguments[0]), [7]);
  assert.deepEqual(fromHistory.mock.calls.map((call) => call.arguments[0]), [7]);
});

test("a Usenet download still post-processing in the client keeps waiting", async (t) => {
  const client = getDownloadClient("sabnzbd");
  t.mock.method(client, "getHistoryItem", async () => ({ nzo_id: "SAB_1", status: "Extracting" }));
  t.mock.method(client, "getQueueItem", async () => null);
  const jobId = addJob();
  const next = await processUsenetPipelinePayload({ phase: "poll", source: "usenet", jobId,
    downloadClient: "sabnzbd", nzbId: "SAB_1", missingPolls: 60 }, failSource);
  assert.equal(next.phase, "poll");
  assert.equal(next.missingPolls, 0);
});
