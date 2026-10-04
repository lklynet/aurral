import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { getDownloadClient }, deemix, ytdlp, slskd] =
  await setupIsolatedBackend("provider-search-exclusions",
    "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/download/downloadClientSettings.js", "backend/services/deemixOrchestrator.js",
    "backend/services/ytdlpOrchestrator.js", "backend/services/downloadPipeline.js");
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

for (const [source, processPayload] of [
  ["deemix", deemix.processDeemixPipelinePayload],
  ["ytdlp", ytdlp.processYtdlpPipelinePayload],
]) {
  test(`${source} blocks a track that fails validation from the next search`, async (t) => {
    const jobId = downloadTracker.addJob({ artistName: "The Band", trackName: "First", durationMs: 180000 }, "search-exclusions");
    const staging = join(state.baseDir, `${source}-rejected`);
    await mkdir(staging, { recursive: true });
    const filePath = join(staging, "First.flac");
    await writeFile(filePath, "not audio");
    const client = getDownloadClient(source);
    if (source === "deemix") t.mock.method(client, "removeFromQueue", async () => true);
    else t.mock.method(client, "cleanupStaging", async () => {});
    const helpers = { failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }) };
    await processPayload({ phase: "finalize", source, jobId, queueUuid: "queued",
      downloadedPath: filePath, candidateIndex: 0,
      candidates: [{ raw: { id: "rejected", url: "https://track.invalid/rejected" } }] }, helpers);
    assert.deepEqual(downloadTracker.getJob(jobId).deniedRemoteSources, [[source, "rejected"]]);
    t.mock.method(client, "search", async () => ["rejected", "allowed"].map((id) => ({ id,
      title: "First", artist: "The Band", channel: "The Band", durationSec: 180, readable: true })));
    const result = await processPayload({ phase: "search", source, jobId }, helpers);
    assert.deepEqual(result.candidates.map((entry) => entry.raw.id), ["allowed"]);
  });
}

test("slskd blocks a file that fails validation", async (t) => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const jobId = downloadTracker.addJob({ artistName: "The Band", trackName: "First", durationMs: 180000 }, "search-exclusions");
  const root = join(state.baseDir, "slskd-rejected");
  await mkdir(join(root, "The Band"), { recursive: true });
  await writeFile(join(root, "The Band", "First.flac"), "not audio");
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => root);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const remoteFile = "Music\\The Band\\First.flac";
  await slskd.processPipelinePayload({ phase: "finalize", source: "slskd", jobId,
    candidateIndex: 0, candidates: [{ raw: { user: "peer", file: remoteFile, size: 0 } }] });
  assert.deepEqual(downloadTracker.getJob(jobId).deniedRemoteSources, [["slskd", `peer\0${remoteFile}`]]);
});
