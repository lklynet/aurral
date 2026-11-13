import { createTrackedJob, isStepFrom, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  { deemixSource },
  { ytdlpSource },
  slskd,
  { processSourcePipelinePayload },
] = await setupIsolatedBackend(
  "provider-search-exclusions",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/deemixSource.ts"),
  () => import("../../backend/services/ytdlpSource.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/download/sourcePipeline.ts"),
);
beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(state));

type SearchingClient = { search: (query: string) => Promise<unknown[]> };

const sources = [deemixSource, ytdlpSource];
for (const contract of sources) {
  const source = contract.id;
  test(`${source} searches beyond denied results without altering denial history`, async () => {
    const jobId = createTrackedJob(
      downloadTracker,
      { artistName: "The Band", trackName: "First", durationMs: 180000 },
      "search-exclusions",
    );
    assert.ok(jobId != null);
    downloadTracker.recordDeniedSource(jobId, source, "denied");
    const client: SearchingClient =
      source === "deemix" ? getDownloadClient("deemix") : getDownloadClient("ytdlp");
    const original = client.search;
    let searches = 0;
    client.search = async () => [
      {
        id: ++searches === 1 ? "denied" : "allowed",
        title: "First",
        artist: "The Band",
        channel: "The Band",
        durationSec: 180,
        readable: true,
      },
    ];
    try {
      const result = await processSourcePipelinePayload(
        { phase: "search", source, jobId },
        contract,
        {
          failOrTryNextSource: async (_payload, _job, reason) => {
            throw new Error(reason);
          },
        },
      );
      assert.ok(isStepFrom(result, source));
      assert.equal(result.phase, "download");
      assert.deepEqual(
        result.candidates?.map((entry) => entry.raw.id),
        ["allowed"],
      );
      assert.deepEqual(trackedJob(downloadTracker, jobId).deniedRemoteSources, [
        [source, "denied"],
      ]);
    } finally {
      client.search = original;
    }
  });
}

for (const contract of sources) {
  const source = contract.id;
  test(`${source} blocks a track that fails validation from the next search`, async () => {
    const jobId = createTrackedJob(
      downloadTracker,
      { artistName: "The Band", trackName: "First", durationMs: 180000 },
      "search-exclusions",
    );
    const staging = join(state.baseDir, `${source}-rejected`);
    await mkdir(staging, { recursive: true });
    const filePath = join(staging, "First.flac");
    await writeFile(filePath, "not audio");
    const client: SearchingClient =
      source === "deemix" ? getDownloadClient("deemix") : getDownloadClient("ytdlp");
    if (source === "deemix")
      vi.spyOn(getDownloadClient("deemix"), "removeFromQueue").mockImplementation(async () => true);
    const helpers = { failOrTryNextSource: async () => null };
    await processSourcePipelinePayload(
      {
        phase: "finalize",
        source,
        jobId,
        pendingId: "queued",
        downloadedPath: filePath,
        candidateIndex: 0,
        candidates: [{ raw: { id: "rejected", title: "First", artist: "The Band" } }],
      },
      contract,
      helpers,
    );
    assert.deepEqual(trackedJob(downloadTracker, jobId).deniedRemoteSources, [
      [source, "rejected"],
    ]);
    vi.spyOn(client, "search").mockImplementation(async () =>
      ["rejected", "allowed"].map((id) => ({
        id,
        title: "First",
        artist: "The Band",
        channel: "The Band",
        durationSec: 180,
        readable: true,
      })),
    );
    const result = await processSourcePipelinePayload(
      { phase: "search", source, jobId },
      contract,
      helpers,
    );
    assert.ok(isStepFrom(result, source));
    assert.deepEqual(
      result.candidates?.map((entry) => entry.raw.id),
      ["allowed"],
    );
  });
}

test("slskd blocks a file that fails validation", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "The Band", trackName: "First", durationMs: 180000 },
    "search-exclusions",
  );
  const root = join(state.baseDir, "slskd-rejected");
  await mkdir(join(root, "The Band"), { recursive: true });
  await writeFile(join(root, "The Band", "First.flac"), "not audio");
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getDownloadDirectory").mockImplementation(async () => root);
  vi.spyOn(client, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  const remoteFile = "Music\\The Band\\First.flac";
  await slskd.processPipelinePayload({
    phase: "finalize",
    source: "slskd",
    jobId,
    candidateIndex: 0,
    candidates: [{ raw: { user: "peer", file: remoteFile, size: 0 } }],
  });
  assert.deepEqual(trackedJob(downloadTracker, jobId).deniedRemoteSources, [
    ["slskd", `peer\0${remoteFile}`],
  ]);
});
