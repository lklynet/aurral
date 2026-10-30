import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { getDownloadClient },
  { processPipelinePayload },
  { holdForReview },
] = await setupIsolatedBackend(
  "source-switch-metadata",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/pipelineHelpers.ts"),
);

afterAll(() => cleanupIsolatedState(state));

dbOps.updateSettings({
  ...dbOps.getSettings(),
  integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  },
});

const METADATA_KEYS = [
  "downloadSource",
  "downloadClient",
  "downloadClientId",
  "releaseGuid",
  "releaseTitle",
  "indexerId",
  "indexerName",
  "remoteUsername",
  "remoteFilename",
] as const;

function storedMetadata(jobId: string | null) {
  return {
    ...db
      .prepare<
        unknown[],
        {
          downloadSource: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["download_source"];
          downloadClient: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["download_client"];
          downloadClientId: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["download_client_id"];
          releaseGuid: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["release_guid"];
          releaseTitle: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["release_title"];
          indexerId: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["indexer_id"];
          indexerName: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["indexer_name"];
          remoteUsername: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["remote_username"];
          remoteFilename: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["remote_filename"];
        }
      >(`SELECT download_source AS downloadSource, download_client AS downloadClient,
    download_client_id AS downloadClientId, release_guid AS releaseGuid, release_title AS releaseTitle,
    indexer_id AS indexerId, indexer_name AS indexerName, remote_username AS remoteUsername,
    remote_filename AS remoteFilename FROM playlist_download_jobs WHERE id = ?`)
      .get(jobId),
  };
}

function useOnlySources(t: import("vite-plus/test").TestContext, ...sources: string[]) {
  for (const id of ["slskd", "deemix", "ytdlp", "nzbget", "sabnzbd"] as const) {
    vi.spyOn(getDownloadClient(id), "isConfigured").mockImplementation(() => sources.includes(id));
  }
}

function jobMetadata(jobId: string | null) {
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
  return Object.fromEntries(METADATA_KEYS.map((key) => [key, job[key] ?? null]));
}

test("a job that moves from yt-dlp to slskd names only slskd's download", async (t) => {
  useOnlySources(t, "ytdlp", "slskd");
  vi.spyOn(getDownloadClient("ytdlp"), "downloadAudio").mockImplementation(async () => ({
    filePath: "",
    stagingDir: "",
  }));
  const slskd = getDownloadClient("slskd");
  vi.spyOn(slskd, "enqueueBatch").mockImplementation(async ({ username }) => ({
    username,
    transferId: "transfer-1",
    response: {},
    transfers: [{ id: "transfer-1" }],
  }));
  vi.spyOn(slskd, "getEvents").mockImplementation(async () => ({
    events: [],
    count: 0,
    totalCount: 0,
  }));
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "The Cure", trackName: "Boys Don't Cry" },
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);

  const finalize = await processPipelinePayload({
    jobId,
    source: "ytdlp",
    phase: "download",
    candidateIndex: 0,
    candidates: [
      {
        raw: {
          url: "https://youtube.test/watch?v=video-1",
          id: "video-1",
          title: "The Cure - Boys Don't Cry (Audio)",
          channel: "The Cure",
        },
      },
    ],
  });
  assert.ok(finalize != null);
  assert.equal(
    trackedJob(downloadTracker, jobId).releaseTitle,
    "The Cure - Boys Don't Cry (Audio)",
  );
  const next = await processPipelinePayload(finalize);
  assert.ok(next != null);
  assert.equal(next.source, "slskd");

  const polling = await processPipelinePayload({
    ...next,
    phase: "download",
    candidateIndex: 0,
    candidates: [
      { raw: { user: "peer", file: "Music\\The Cure\\Boys Don't Cry.flac", size: 30000000 } },
    ],
  });
  assert.ok(polling != null);
  assert.equal(polling.phase, "poll");

  const expected = {
    downloadSource: "slskd",
    downloadClient: "slskd",
    downloadClientId: "transfer-1",
    releaseGuid: null,
    releaseTitle: null,
    indexerId: null,
    indexerName: null,
    remoteUsername: "peer",
    remoteFilename: "Music\\The Cure\\Boys Don't Cry.flac",
  };
  assert.deepEqual(storedMetadata(jobId), expected);
  assert.deepEqual(jobMetadata(jobId), expected);
});

test("a Usenet file held while slskd is tried goes to review with its own release and indexer", async (t) => {
  useOnlySources(t, "nzbget", "slskd");
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "The Cure", trackName: "Fire in Cairo" },
    "library",
  );
  assert.ok(jobId != null);
  let enqueuedFrom = null;
  vi.spyOn(getDownloadClient("slskd"), "enqueueBatch").mockImplementation(async () => {
    enqueuedFrom = jobMetadata(jobId);
    throw new Error("peer refused");
  });
  downloadTracker.setDownloading(jobId);
  const usenet = {
    downloadSource: "usenet",
    downloadClient: "nzbget",
    downloadClientId: "41",
    releaseGuid: "nzb-guid",
    releaseTitle: "The.Cure-Boys.Dont.Cry-FLAC",
    indexerId: "3",
    indexerName: "Indexer",
    remoteUsername: "Indexer",
    remoteFilename: "The.Cure-Boys.Dont.Cry-FLAC",
  };
  downloadTracker.updateDownloadMetadata(jobId, usenet);
  const sourcePath = path.join(state.baseDir, "held-usenet", "Fire in Cairo.flac");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "held");
  const heldForReview = holdForReview(trackedJob(downloadTracker, jobId), {
    source: "usenet",
    sourcePath,
    reason: "Duration differs",
    transferId: "41",
  });

  const next = await processPipelinePayload({
    jobId,
    source: "slskd",
    phase: "download",
    candidateIndex: 0,
    triedSources: ["usenet"],
    heldForReview,
    candidates: [
      { raw: { user: "peer", file: "Music\\The Cure\\Fire in Cairo.flac", size: 30000000 } },
    ],
  });

  assert.deepEqual(enqueuedFrom, {
    ...Object.fromEntries(METADATA_KEYS.map((key) => [key, null])),
    downloadSource: "slskd",
    downloadClient: "slskd",
    remoteUsername: "peer",
    remoteFilename: "Music\\The Cure\\Fire in Cairo.flac",
  });
  assert.equal(next, null);
  assert.equal(trackedJob(downloadTracker, jobId).status, "blocked");
  assert.deepEqual(storedMetadata(jobId), usenet);
  assert.deepEqual(jobMetadata(jobId), usenet);
});
