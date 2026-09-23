import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import {
  isBeetsMatcherAvailable,
  resetMatcherAvailability,
} from "../../backend/services/trackMatching/index.js";

const [
  isolatedState,
  { downloadTracker },
  { processYtdlpPipelinePayload, isYtdlpLiveResult, hasEnoughCandidates },
  { processUsenetPipelinePayload, collectDownloadedAudioFiles },
  { processDeemixPipelinePayload },
  { dbOps },
  { db },
  pipelineHelpersModule,
  playlistManagerModule,
  weeklyFlowWorkerModule,
  cancellationModule,
] = await setupIsolatedBackend(
  "download-review-routing",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/ytdlpOrchestrator.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/deemixOrchestrator.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
  "backend/services/pipelineHelpers.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
);

const { blockPipelineJobForReview, finalizePipelineJobSuccess } = pipelineHelpersModule;

// The unified download pipeline validates identity through the bundled beets
// matcher; without it these end-to-end flows cannot run.
resetMatcherAvailability();
const matcherAvailable = await isBeetsMatcherAvailable();
const btest = (name, fn) => test(name, { skip: matcherAvailable ? false : "beets not installed for any available Python interpreter" }, fn);
const { playlistManager } = playlistManagerModule;
const { weeklyFlowWorker } = weeklyFlowWorkerModule;
const { cancelDownloadJob } = cancellationModule;

test("yt-dlp keeps ordinary not-live results and excludes live statuses", () => {
  assert.equal(isYtdlpLiveResult({ liveStatus: "not_live" }), false);
  assert.equal(isYtdlpLiveResult({ liveStatus: "is_live" }), true);
  assert.equal(isYtdlpLiveResult({ liveStatus: "was_live" }), true);
  assert.equal(isYtdlpLiveResult({ liveStatus: "post_live" }), true);
  assert.equal(isYtdlpLiveResult({ liveStatus: "is_upcoming" }), true);
});

test("yt-dlp live results cannot satisfy the search early-exit check", () => {
  const request = {
    artistName: "Artist Name",
    trackName: "Correct Track",
    durationMs: 1000,
  };
  assert.equal(
    hasEnoughCandidates(
      [{
        id: "live-video",
        title: "Artist Name - Correct Track",
        channel: "Artist Name",
        durationSec: 1,
        liveStatus: "is_live",
      }],
      request,
    ),
    false,
  );
});

test("Usenet file collection only scans the current history directory", async () => {
  const sharedRoot = path.join(process.env.DOWNLOAD_FOLDER, "usenet-shared-root");
  const currentRoot = path.join(sharedRoot, "current-release");
  const unrelatedPath = path.join(sharedRoot, "unrelated.mp3");
  const currentPath = path.join(currentRoot, "current.mp3");
  await mkdir(currentRoot, { recursive: true });
  await writeFile(unrelatedPath, "unrelated");
  await writeFile(currentPath, "current");

  try {
    const files = await collectDownloadedAudioFiles({ FinalDir: currentRoot });
    assert.deepEqual(files, [currentPath]);
    assert.deepEqual(await collectDownloadedAudioFiles({}), []);
  } finally {
    await rm(sharedRoot, { recursive: true, force: true });
  }
});

test("cancelling deemix finalization leaves a provider-reported library file untouched", async () => {
  const filePath = path.join(process.env.DOWNLOAD_FOLDER, "existing-library-song.mp3");
  await writeOneSecondMp3(filePath);
  const jobId = downloadTracker.addJob(
    { artistName: "Artist Name", trackName: "Correct Track", albumName: "Album Name" },
    "deemix-source-safety",
  );
  downloadTracker.setDownloading(jobId);
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    cancelDownloadJob(jobId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: true }));
  });

  try {
    dbOps.updateSettings({
      integrations: { deemix: { enabled: true, url: server.url, bitrate: 1 } },
    });
    const result = await processDeemixPipelinePayload({
      phase: "finalize",
      source: "deemix",
      jobId,
      queueUuid: "track_1_1",
      downloadedPath: filePath,
      candidate: { raw: { title: "Correct Track", artist: "Artist Name" } },
    });

    assert.equal(result, null);
    await access(filePath);
  } finally {
    await server.close();
  }
});

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("pipeline completion leaves the library scan to playlist completion", async (t) => {
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);
  const refreshPlaylist = t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  const wake = t.mock.method(weeklyFlowWorker, "wake", () => {});
  const checkPlaylistComplete = t.mock.method(
    weeklyFlowWorker,
    "checkPlaylistComplete",
    async () => {},
  );

  await finalizePipelineJobSuccess({
    downloadTracker: {
      setDone() {},
    },
    job: {
      id: "pipeline-job",
      playlistType: "flow-playlist",
      artistName: "Artist",
      trackName: "Track",
    },
    committedFinalPath: "/library/Artist/Track.flac",
  });

  assert.equal(scheduleScanLibrary.mock.callCount(), 0);
  assert.deepEqual(refreshPlaylist.mock.calls.map((call) => call.arguments), [["flow-playlist"]]);
  assert.deepEqual(wake.mock.calls.map((call) => call.arguments), [[0]]);
  assert.deepEqual(
    checkPlaylistComplete.mock.calls.map((call) => call.arguments),
    [["flow-playlist"]],
  );
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
  assert.match(job.error, /duration mismatch/);
  await access(filePath);
}

btest("yt-dlp sends plausible duration mismatches to review", async () => {
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

btest("yt-dlp auto-rejects weak title matches instead of reviewing them", async () => {
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

  const sourceFailures = [];
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
    {
      failOrTryNextSource: (payload, job, reason) => {
        sourceFailures.push(reason);
        return null;
      },
    },
  );

  assert.equal(result, null);
  await assert.rejects(() => access(filePath), undefined, "the wrong-track file must be removed");
  assert.equal(sourceFailures.length, 1);
  assert.match(sourceFailures[0], /does not match the requested track/);
});

btest("yt-dlp holds partially-matching identity for review", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "",
      durationMs: 1000,
    },
    "ytdlp-weak-artist-review",
  );
  downloadTracker.setDownloading(jobId);
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER,
    ".ytdlp-staging",
    jobId,
    "Correct.mp3",
  );
  await writeOneSecondMp3(filePath);

  const result = await processYtdlpPipelinePayload(
    {
      phase: "finalize",
      source: "ytdlp",
      jobId,
      downloadedPath: filePath,
      destination: "ytdlp-weak-artist-review/Artist Name",
      candidate: {
        raw: {
          id: "video-weak-artist",
          title: "Correct",
        },
      },
      candidateIndex: 0,
    },
    { failOrTryNextSource: failIfPipelineFallsThrough },
  );

  assert.equal(result, null);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked");
  assert.match(job.error, /moderate identity match|does not match/);
  assert.equal(job.stagingPath, filePath);
  await access(filePath);
});

btest("Usenet sends its best plausible duration mismatch to review", async () => {
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

btest("deemix drops its queue entry before a track goes to review", async () => {
  const removed = [];
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER,
    "deemix-complete",
    "Artist Name - Correct Track.mp3",
  );
  await writeOneSecondMp3(filePath);
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    const url = new URL(req.url, "http://deemix.test");
    if (url.pathname === "/api/removeFromQueue") removed.push(url.searchParams.get("uuid"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        url.pathname === "/api/getQueue"
          ? { queue: { track_1_1: { status: "completed", files: [{ path: filePath }] } } }
          : { result: true },
      ),
    );
  });

  try {
    dbOps.updateSettings({
      integrations: { deemix: { enabled: true, url: server.url, bitrate: 1 } },
    });
    const jobId = addDurationMismatchJob("deemix-review");
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: "deemix",
      downloadClient: "deemix",
      downloadClientId: "track_1_1",
      releaseGuid: "1",
      remoteFilename: "Correct Track",
    });

    const polled = await processDeemixPipelinePayload(
      {
        phase: "poll",
        source: "deemix",
        jobId,
        queueUuid: "track_1_1",
        destination: "deemix-review/Artist Name/Album Name",
        candidate: {
          raw: {
            id: "1",
            title: "Correct Track",
            artist: "Artist Name",
            album: "Album Name",
            file: "Artist Name - Correct Track",
          },
        },
        candidateIndex: 0,
      },
      { failOrTryNextSource: failIfPipelineFallsThrough },
    );

    assert.equal(polled.phase, "finalize");
    assert.deepEqual(removed, []);

    const result = await processDeemixPipelinePayload(polled, {
      failOrTryNextSource: failIfPipelineFallsThrough,
    });

    assert.equal(result, null);
    await assertReviewable(jobId, filePath, "deemix");
    assert.deepEqual(removed, ["track_1_1"]);
  } finally {
    await server.close();
  }
});

btest("deemix reuses an existing final path instead of creating a duplicate", async () => {
  const sourcePath = path.join(
    process.env.DOWNLOAD_FOLDER,
    "deemix-duplicate-source",
    "Artist Name - Correct Track.mp3",
  );
  const destination = "deemix-duplicate/Artist Name/Album Name";
  const targetPath = path.join(
    process.env.WEEKLY_FLOW_FOLDER,
    destination,
    "Correct Track.mp3",
  );
  await writeOneSecondMp3(sourcePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "existing-audio", "utf8");
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    const url = new URL(req.url, "http://deemix.test");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        url.pathname === "/api/getQueue"
          ? { queue: { track_1_1: { status: "completed", files: [{ path: sourcePath }] } } }
          : { result: true },
      ),
    );
  });

  let jobId;
  try {
    dbOps.updateSettings({
      integrations: { deemix: { enabled: true, url: server.url, bitrate: 1 } },
    });
    jobId = downloadTracker.addJob(
      {
        artistName: "Artist Name",
        trackName: "Correct Track",
        albumName: "Album Name",
        durationMs: 1000,
      },
      "deemix-duplicate",
    );
    downloadTracker.setDownloading(jobId);

    const polled = await processDeemixPipelinePayload(
      {
        phase: "poll",
        source: "deemix",
        jobId,
        queueUuid: "track_1_1",
        destination,
        candidate: {
          raw: {
            id: "1",
            title: "Correct Track",
            artist: "Artist Name",
            album: "Album Name",
            file: "Artist Name - Correct Track",
          },
        },
        candidateIndex: 0,
      },
      { failOrTryNextSource: failIfPipelineFallsThrough },
    );

    const result = await processDeemixPipelinePayload(polled, {
      failOrTryNextSource: failIfPipelineFallsThrough,
    });

    assert.equal(result, null);
    assert.equal(downloadTracker.getJob(jobId)?.status, "done");
    assert.equal(downloadTracker.getJob(jobId)?.finalPath, targetPath);
    assert.equal(await readFile(targetPath, "utf8"), "existing-audio");
    await assert.rejects(() => access(sourcePath));
    await assert.rejects(() => access(path.join(path.dirname(targetPath), "Correct Track (2).mp3")));
  } finally {
    if (jobId) downloadTracker.removeJob(jobId);
    await server.close();
    await rm(path.dirname(targetPath), { recursive: true, force: true });
    await rm(path.dirname(sourcePath), { recursive: true, force: true });
  }
});
