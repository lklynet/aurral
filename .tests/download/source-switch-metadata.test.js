import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { getDownloadClient }, { processPipelinePayload },
  { holdForReview }] =
  await setupIsolatedBackend(
    "source-switch-metadata",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/download/downloadClientSettings.js",
    "backend/services/downloadPipeline.js",
    "backend/services/pipelineHelpers.js",
  );

test.after(() => cleanupIsolatedState(state));

dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
  slskd: { enabled: true, url: "http://127.0.0.1:9" },
} });

const METADATA_KEYS = ["downloadSource", "downloadClient", "downloadClientId", "releaseGuid", "releaseTitle",
  "indexerId", "indexerName", "remoteUsername", "remoteFilename"];

function storedMetadata(jobId) {
  return { ...db.prepare(`SELECT download_source AS downloadSource, download_client AS downloadClient,
    download_client_id AS downloadClientId, release_guid AS releaseGuid, release_title AS releaseTitle,
    indexer_id AS indexerId, indexer_name AS indexerName, remote_username AS remoteUsername,
    remote_filename AS remoteFilename FROM playlist_download_jobs WHERE id = ?`).get(jobId) };
}

function useOnlySources(t, ...sources) {
  for (const id of ["slskd", "deemix", "ytdlp", "nzbget", "sabnzbd"]) {
    t.mock.method(getDownloadClient(id), "isConfigured", () => sources.includes(id));
  }
}

function jobMetadata(jobId) {
  const job = downloadTracker.getJob(jobId);
  return Object.fromEntries(METADATA_KEYS.map((key) => [key, job[key] ?? null]));
}

test("a job that moves from yt-dlp to slskd names only slskd's download", async (t) => {
  useOnlySources(t, "ytdlp", "slskd");
  t.mock.method(getDownloadClient("ytdlp"), "downloadAudio", async () => ({ filePath: "" }));
  const slskd = getDownloadClient("slskd");
  t.mock.method(slskd, "enqueueBatch", async ({ username }) => ({ username, transfers: [{ id: "transfer-1" }] }));
  t.mock.method(slskd, "getEvents", async () => []);
  const jobId = downloadTracker.addJob({ artistName: "The Cure", trackName: "Boys Don't Cry" }, "library");
  downloadTracker.setDownloading(jobId);

  const finalize = await processPipelinePayload({ jobId, source: "ytdlp", phase: "download", candidateIndex: 0,
    candidates: [{ raw: { url: "https://youtube.test/watch?v=video-1", id: "video-1",
      title: "The Cure - Boys Don't Cry (Audio)", channel: "The Cure" } }] });
  assert.equal(downloadTracker.getJob(jobId).releaseTitle, "The Cure - Boys Don't Cry (Audio)");
  const next = await processPipelinePayload(finalize);
  assert.equal(next.source, "slskd");

  const polling = await processPipelinePayload({ ...next, phase: "download", candidateIndex: 0,
    candidates: [{ raw: { user: "peer", file: "Music\\The Cure\\Boys Don't Cry.flac", size: 30000000 } }] });
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
  const jobId = downloadTracker.addJob({ artistName: "The Cure", trackName: "Fire in Cairo" }, "library");
  let enqueuedFrom = null;
  t.mock.method(getDownloadClient("slskd"), "enqueueBatch", async () => {
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
  const heldForReview = holdForReview(downloadTracker.getJob(jobId), { source: "usenet", sourcePath,
    reason: "Duration differs", transferId: "41" });

  const next = await processPipelinePayload({ jobId, source: "slskd", phase: "download", candidateIndex: 0,
    triedSources: ["usenet"], heldForReview,
    candidates: [{ raw: { user: "peer", file: "Music\\The Cure\\Fire in Cairo.flac", size: 30000000 } }] });

  assert.deepEqual(enqueuedFrom, { ...Object.fromEntries(METADATA_KEYS.map((key) => [key, null])),
    downloadSource: "slskd", downloadClient: "slskd", remoteUsername: "peer",
    remoteFilename: "Music\\The Cure\\Fire in Cairo.flac" });
  assert.equal(next, null);
  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.deepEqual(storedMetadata(jobId), usenet);
  assert.deepEqual(jobMetadata(jobId), usenet);
});
