import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { downloadTracker },
  { processYtdlpPipelinePayload },
  { processUsenetPipelinePayload },
  { dbOps },
  { db },
  { blockPipelineJobForReview },
] = await setupIsolatedBackend(
  "download-review-routing",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/ytdlpOrchestrator.js",
  "backend/services/usenetOrchestrator.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
  "backend/services/pipelineHelpers.js",
);

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

async function writeOneSecondMp3(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc",
      "-t",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
}

function addDurationMismatchJob(playlistId) {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 100000,
      trackNumber: 1,
    },
    playlistId,
  );
  downloadTracker.setDownloading(jobId);
  return jobId;
}

function failIfPipelineFallsThrough() {
  assert.fail("blocked download fell through to source retry");
}

async function assertReviewable(jobId, filePath, source) {
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked");
  assert.equal(job.downloadSource, source);
  assert.equal(job.stagingPath, filePath);
  assert.match(job.error, /^blocked-duration-mismatch:/);
  await access(filePath);
}

test("yt-dlp sends plausible duration mismatches to review", async () => {
  const jobId = addDurationMismatchJob("ytdlp-review");
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER,
    ".ytdlp-staging",
    jobId,
    "Artist Name - Correct Track.mp3",
  );
  await writeOneSecondMp3(filePath);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
    releaseGuid: "video-1",
    remoteFilename: "Artist Name - Correct Track",
  });

  const result = await processYtdlpPipelinePayload(
    {
      phase: "finalize",
      source: "ytdlp",
      jobId,
      downloadedPath: filePath,
      destination: "ytdlp-review/Artist Name/Album Name",
      candidate: {
        raw: { id: "video-1", title: "Artist Name - Correct Track" },
      },
      candidateIndex: 0,
    },
    { failOrTryNextSource: failIfPipelineFallsThrough },
  );

  assert.equal(result, null);
  await assertReviewable(jobId, filePath, "ytdlp");
});

test("yt-dlp sends weak title matches to review", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 1000,
    },
    "ytdlp-weak-title-review",
  );
  downloadTracker.setDownloading(jobId);
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER,
    ".ytdlp-staging",
    jobId,
    "Artist Name - Wrong Track.mp3",
  );
  await writeOneSecondMp3(filePath);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
    releaseGuid: "video-weak-title",
    remoteFilename: "Artist Name - Wrong Track",
  });

  const result = await processYtdlpPipelinePayload(
    {
      phase: "finalize",
      source: "ytdlp",
      jobId,
      downloadedPath: filePath,
      destination: "ytdlp-weak-title-review/Artist Name/Album Name",
      candidate: {
        raw: {
          id: "video-weak-title",
          title: "Artist Name - Wrong Track",
        },
      },
      candidateIndex: 0,
    },
    { failOrTryNextSource: failIfPipelineFallsThrough },
  );

  assert.equal(result, null);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked");
  assert.match(job.error, /^weak-title-match:/);
  assert.equal(job.stagingPath, filePath);
  await access(filePath);
});

test("Usenet sends its best plausible duration mismatch to review", async () => {
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  });

  try {
    const completedDir = path.join(process.env.DOWNLOAD_FOLDER, "usenet-complete");
    const filePath = path.join(
      completedDir,
      "Artist Name",
      "Album Name",
      "01 Correct Track.mp3",
    );
    await writeOneSecondMp3(filePath);
    dbOps.updateSettings({
      integrations: {
        nzbget: {
          enabled: true,
          url: server.url,
          completedPath: completedDir,
        },
      },
    });
    const jobId = addDurationMismatchJob("usenet-review");
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: "usenet",
      downloadClient: "nzbget",
      releaseGuid: "release-1",
      remoteFilename: "Artist Name - Album Name",
    });
    const candidate = {
      raw: {
        guid: "release-1",
        release: { guid: "release-1", title: "Artist Name - Album Name" },
      },
    };

    const result = await processUsenetPipelinePayload(
      {
        phase: "finalize",
        source: "usenet",
        jobId,
        nzbId: 1,
        destination: "usenet-review/Artist Name/Album Name",
        history: { FinalDir: completedDir },
        candidate,
        candidateIndex: 0,
      },
      { failOrTryNextSource: failIfPipelineFallsThrough },
    );

    assert.equal(result, null);
    await assertReviewable(jobId, filePath, "usenet");
  } finally {
    await server.close();
  }
});

test("upgrade duration mismatches remain available for review", async () => {
  const originalPath = path.join(process.env.DOWNLOAD_FOLDER, "original.mp3");
  const candidatePath = path.join(process.env.DOWNLOAD_FOLDER, "candidate.mp3");
  await writeOneSecondMp3(originalPath);
  await writeOneSecondMp3(candidatePath);

  const sourceJobId = downloadTracker.addJob(
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 100000,
    },
    "upgrade-review",
  );
  downloadTracker.setDone(sourceJobId, originalPath, "Album Name");
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(sourceJobId));
  downloadTracker.setDownloading(upgradeJobId);

  const result = blockPipelineJobForReview({
    downloadTracker,
    job: downloadTracker.getJob(upgradeJobId),
    validation: {
      blocked: true,
      reason: "blocked-duration-mismatch: candidate duration differs",
    },
    sourcePath: candidatePath,
  });

  assert.equal(result, true);
  assert.equal(downloadTracker.getJob(upgradeJobId)?.status, "blocked");
  assert.equal(downloadTracker.getJob(upgradeJobId)?.stagingPath, candidatePath);
  await access(candidatePath);
});
