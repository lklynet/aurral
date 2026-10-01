import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { downloadTracker }, { getDownloadClient }, deemix, ytdlp] =
  await setupIsolatedBackend("provider-search-exclusions",
    "backend/config/db-sqlite.js", "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
    "backend/services/download/downloadClientSettings.js", "backend/services/deemixOrchestrator.js",
    "backend/services/ytdlpOrchestrator.js");
test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(state));

for (const [source, processPayload] of [
  ["deemix", deemix.processDeemixPipelinePayload],
  ["ytdlp", ytdlp.processYtdlpPipelinePayload],
]) {
  test(`${source} searches beyond denied results without altering denial history`, async () => {
    const jobId = downloadTracker.addJob({ artistName: "The Band", trackName: "First", durationMs: 180000 }, "search-exclusions");
    downloadTracker.recordDeniedSource(jobId, source, "denied");
    const client = getDownloadClient(source);
    const original = client.search;
    let searches = 0;
    client.search = async () => [{ id: ++searches === 1 ? "denied" : "allowed", title: "First",
      artist: "The Band", channel: "The Band", durationSec: 180, readable: true }];
    try {
      const result = await processPayload({ phase: "search", source, jobId }, {
        failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }),
      });
      assert.equal(result.phase, "download");
      assert.deepEqual(result.candidates.map((entry) => entry.raw.id), ["allowed"]);
      assert.deepEqual(downloadTracker.getJob(jobId).deniedRemoteSources, [[source, "denied"]]);
    } finally {
      client.search = original;
    }
  });
}
