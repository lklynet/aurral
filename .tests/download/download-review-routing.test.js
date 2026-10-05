import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseFile } from "music-metadata";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

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
  downloadWorkerModule,
  cancellationModule,
  { processPipelinePayload },
  { getDownloadClient },
] = await setupIsolatedBackend(
  "download-review-routing",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/ytdlpOrchestrator.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/deemixOrchestrator.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
  "backend/services/pipelineHelpers.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/downloadPipeline.js",
  "backend/services/download/downloadClientSettings.js",
);

const { blockPipelineJobForReview, finalizePipelineJobSuccess } = pipelineHelpersModule;

const btest = test;
const { playlistManager } = playlistManagerModule;
const { downloadWorker } = downloadWorkerModule;
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
  const wake = t.mock.method(downloadWorker, "wake", () => {});
  const checkPlaylistComplete = t.mock.method(
    downloadWorker,
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

async function writeOneSecondMp3(filePath, { title = "Correct Track", artist = "Artist Name", seconds = 1 } = {}) {
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
      String(seconds),
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-metadata",
      `title=${title}`,
      "-metadata",
      `artist=${artist}`,
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

async function assertReviewable(jobId, source) {
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked");
  assert.equal(job.downloadSource, source);
  assert.equal(job.error, "downloaded file is 99.0s shorter than the requested track");
  await access(job.stagingPath);
  return job.stagingPath;
}

function useOnlySources(t, ...sources) {
  for (const id of ["slskd", "deemix", "ytdlp", "nzbget", "sabnzbd"]) {
    t.mock.method(getDownloadClient(id), "isConfigured", () => sources.includes(id));
  }
}

btest("yt-dlp sends plausible duration mismatches to review", async (t) => {
  useOnlySources(t, "ytdlp");
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

  const result = await processPipelinePayload({
    phase: "finalize",
    source: "ytdlp",
    jobId,
    downloadedPath: filePath,
    destination: "ytdlp-review/Artist Name/Album Name",
    candidate: {
      raw: { id: "video-1", title: "Artist Name - Correct Track" },
    },
    candidateIndex: 0,
  });

  assert.equal(result, null);
  await assertReviewable(jobId, "ytdlp");
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
  assert.match(sourceFailures[0], /filename-title/);
});

btest("yt-dlp holds partially-matching identity for review", async (t) => {
  useOnlySources(t, "ytdlp");
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
  await writeOneSecondMp3(filePath, { title: "Correct" });

  const result = await processPipelinePayload({
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
  });

  assert.equal(result, null);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked");
  assert.equal(
    job.error,
    "downloaded file has a title that only partly matches the requested track",
  );
  await access(job.stagingPath);
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
    assert.equal(await assertReviewable(jobId, "usenet"), filePath);
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
    assert.equal(await assertReviewable(jobId, "deemix"), filePath);
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

btest("Soulseek tries the other candidates before sending a file to review", async (t) => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    ...dbOps.getSettings().integrations, slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  useOnlySources(t, "slskd");
  const root = path.join(isolatedState.baseDir, "slskd-held");
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => root);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const candidate = (name) => ({ raw: { user: name, file: `Music\\Artist Name\\${name}.mp3`, size: 0 } });
  const finalize = (payload) => processPipelinePayload({ ...payload, phase: "finalize", source: "slskd" });

  const jobId = addDurationMismatchJob("slskd-held");
  const held = path.join(root, "Artist Name", "held.mp3");
  const other = path.join(root, "Artist Name", "other.mp3");
  await writeOneSecondMp3(held);
  await writeOneSecondMp3(other);
  const next = await finalize({ jobId, candidateIndex: 0, candidates: [candidate("held"), candidate("other")] });
  assert.equal(next.candidateIndex, 1);
  assert.notEqual(downloadTracker.getJob(jobId).status, "blocked");
  await finalize(next);
  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.equal(downloadTracker.getJob(jobId).stagingPath, held);
  await access(held);
  await assert.rejects(access(other));

  const verifiedJobId = downloadTracker.addJob({ artistName: "Artist Name", trackName: "Correct Track",
    albumName: "Album Name", durationMs: 1000 }, "slskd-held");
  downloadTracker.setDownloading(verifiedJobId);
  const longer = path.join(root, "Artist Name", "longer.mp3");
  await writeOneSecondMp3(longer, { seconds: 30 });
  await writeOneSecondMp3(other);
  const retry = await finalize({ jobId: verifiedJobId, candidateIndex: 0,
    candidates: [candidate("longer"), candidate("other")] });
  await finalize(retry);
  assert.equal(downloadTracker.getJob(verifiedJobId).status, "done");
  await assert.rejects(access(longer));
});

btest("a yt-dlp file waits for review while the next source is tried", async (t) => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    ...dbOps.getSettings().integrations, slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  useOnlySources(t, "ytdlp", "slskd");
  t.mock.method(downloadWorker, "start", async () => {});
  const root = path.join(isolatedState.baseDir, "ytdlp-held-slskd");
  const client = getDownloadClient("slskd");
  t.mock.method(client, "getDownloadDirectory", async () => root);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const peer = (name) => ({ raw: { user: "peer", file: `Music\\Artist Name\\${name}.mp3`, size: 0 } });
  const fromYtdlp = async (jobId, seconds) => {
    const video = path.join(isolatedState.baseDir, "ytdlp-held", "ytdlp", jobId, "video.mp3");
    await writeOneSecondMp3(video, { seconds });
    downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "ytdlp", downloadClient: "ytdlp",
      releaseGuid: "video-held", remoteFilename: "Artist Name - Correct Track" });
    const next = await processPipelinePayload({ jobId, phase: "finalize", source: "ytdlp", downloadedPath: video,
      candidate: { raw: { id: "video-held", title: "Artist Name - Correct Track" } }, candidateIndex: 0 });
    assert.equal(next.source, "slskd");
    assert.equal(downloadTracker.getJob(jobId).status, "downloading");
    downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "slskd", downloadClient: "slskd",
      remoteUsername: "peer", remoteFilename: "Music\\Artist Name\\other.mp3" });
    return next;
  };

  const jobId = addDurationMismatchJob("ytdlp-held");
  const next = await fromYtdlp(jobId, 1);
  await writeOneSecondMp3(path.join(root, "Artist Name", "other.mp3"));
  await processPipelinePayload({ ...next, phase: "finalize", candidates: [peer("other")] });
  const parked = await assertReviewable(jobId, "ytdlp");
  await assert.rejects(access(path.join(root, "Artist Name", "other.mp3")));
  const { denyBlockedJob } = await import("../../backend/services/downloadJobs/blockedJobReview.js");
  await denyBlockedJob(jobId);
  assert.deepEqual(downloadTracker.getJob(jobId).deniedRemoteSources.at(-1), ["ytdlp", "video-held"]);
  await assert.rejects(access(parked));

  const verifiedJobId = downloadTracker.addJob({ artistName: "Artist Name", trackName: "Correct Track",
    albumName: "Album Name", durationMs: 1000 }, "ytdlp-held");
  downloadTracker.setDownloading(verifiedJobId);
  const retry = await fromYtdlp(verifiedJobId, 30);
  await writeOneSecondMp3(path.join(root, "Artist Name", "other.mp3"));
  await processPipelinePayload({ ...retry, phase: "finalize", candidates: [peer("other")] });
  assert.equal(downloadTracker.getJob(verifiedJobId).status, "done");
  await assert.rejects(access(retry.heldForReview.sourcePath));
});

btest("denying a held file starts a stopped worker to search again", async (t) => {
  const start = t.mock.method(downloadWorker, "start", async () => {});
  const jobId = addDurationMismatchJob("deny-restart");
  const staged = path.join(isolatedState.baseDir, "deny-restart", "held.mp3");
  await writeOneSecondMp3(staged);
  downloadTracker.setBlocked(jobId, "downloaded file is 99.0s shorter than the requested track", staged);
  const { denyBlockedJob } = await import("../../backend/services/downloadJobs/blockedJobReview.js");
  assert.equal((await denyBlockedJob(jobId)).status, 200);
  assert.equal(downloadTracker.getJob(jobId).status, "pending");
  assert.equal(start.mock.callCount(), 1);
});

async function waitUntilGone(filePath) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!(await access(filePath).then(() => true, () => false))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${filePath} was not removed`);
}

btest("removing a job in review discards its file but leaves a Library file", async () => {
  const { resolveDownloadRoot } = await import("../../backend/services/downloadPaths.js");
  const inLibrary = path.join(resolveDownloadRoot(), "review-removal", "Artist Name - Correct Track.mp3");
  const staged = path.join(isolatedState.baseDir, "review-removal", "held.mp3");
  for (const filePath of [inLibrary, staged]) {
    await writeOneSecondMp3(filePath);
    const jobId = addDurationMismatchJob("review-removal");
    downloadTracker.setBlocked(jobId, "downloaded file is 99.0s shorter than the requested track", filePath);
  }

  assert.equal(downloadTracker.clearByPlaylistId("review-removal"), 2);
  await waitUntilGone(staged);
  await access(inLibrary);
});

btest("denying a review removes its file and yt-dlp folder but leaves a Library file", async (t) => {
  t.mock.method(downloadWorker, "start", async () => {});
  const stagingRoot = path.join(isolatedState.baseDir, "deny-cleanup");
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
    ...dbOps.getSettings().integrations, ytdlp: { stagingPath: stagingRoot } } });
  const { denyBlockedJob } = await import("../../backend/services/downloadJobs/blockedJobReview.js");
  const review = async (filePath, source) => {
    const jobId = addDurationMismatchJob("deny-cleanup");
    await writeOneSecondMp3(typeof filePath === "function" ? filePath(jobId) : filePath);
    downloadTracker.updateDownloadMetadata(jobId, { downloadSource: source, releaseGuid: `${source}-1` });
    downloadTracker.setBlocked(jobId, "downloaded file is 99.0s shorter than the requested track",
      typeof filePath === "function" ? filePath(jobId) : filePath);
    assert.equal((await denyBlockedJob(jobId)).status, 200);
    return jobId;
  };

  const ytdlpJobId = await review((jobId) => path.join(stagingRoot, "ytdlp", jobId, "video-1.mp3"), "ytdlp");
  await assert.rejects(access(path.join(stagingRoot, "ytdlp", ytdlpJobId)));

  t.mock.method(getDownloadClient("slskd"), "getDownloadDirectory", async () => {
    throw new Error("slskd is unreachable");
  });
  const fromSoulseek = path.join(stagingRoot, "slskd", "Artist Name", "01 Correct Track.mp3");
  await review(fromSoulseek, "slskd");
  await assert.rejects(access(fromSoulseek));

  const { resolveDownloadRoot } = await import("../../backend/services/downloadPaths.js");
  const inLibrary = path.join(resolveDownloadRoot(), "deny-cleanup", "Artist Name - Correct Track.mp3");
  await review(inLibrary, "deemix");
  await access(inLibrary);
});

// Stands in for a download folder on a slow network mount: ffmpeg fails, as it
// times out there, on any file in that folder and works everywhere else.
async function failFfmpegIn(t, folder) {
  const bin = path.join(isolatedState.baseDir, "slow-mount-bin");
  const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "ffmpeg"), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in "${folder}"/*) echo "Connection timed out" >&2; exit 1 ;; esac
done
exec "${ffmpeg}" "$@"
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
}

btest("a download is tagged after it reaches the Library, so a slow download folder cannot fail it", async (t) => {
  const slowFolder = path.join(isolatedState.baseDir, "slow-mount");
  const usenetFile = path.join(slowFolder, "usenet", "Artist Name", "Album Name", "01 Correct Track.mp3");
  const slskdRoot = path.join(slowFolder, "slskd");
  const slskdFile = path.join(slskdRoot, "Artist Name", "02 Other Track.mp3");
  await writeOneSecondMp3(usenetFile);
  await writeOneSecondMp3(slskdFile, { title: "Other Track" });
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  });
  t.after(() => server.close());
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { ...dbOps.getSettings().integrations,
    nzbget: { enabled: true, url: server.url, completedPath: path.join(slowFolder, "usenet") },
    slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const slskd = getDownloadClient("slskd");
  t.mock.method(slskd, "getDownloadDirectory", async () => slskdRoot);
  t.mock.method(slskd, "isCleanupAfterRunsEnabled", () => false);
  await failFfmpegIn(t, slowFolder);
  const addJob = (trackName, trackNumber) => {
    const jobId = downloadTracker.addJob({ artistName: "Artist Name", trackName, albumName: "Album Name",
      durationMs: 1000, trackNumber }, "slow-mount");
    downloadTracker.setDownloading(jobId);
    return jobId;
  };

  const usenetJobId = addJob("Correct Track", 1);
  await processUsenetPipelinePayload({ phase: "finalize", source: "usenet", jobId: usenetJobId, nzbId: 1,
    destination: "slow-mount/Artist Name/Album Name", history: { FinalDir: path.join(slowFolder, "usenet") },
    candidate: { raw: { guid: "release-1", release: { guid: "release-1", title: "Artist Name - Album Name" } } },
    candidateIndex: 0 }, { failOrTryNextSource: failIfPipelineFallsThrough });
  const slskdJobId = addJob("Other Track", 2);
  await processPipelinePayload({ phase: "finalize", source: "slskd", jobId: slskdJobId, candidateIndex: 0,
    destination: "slow-mount/Artist Name/Album Name",
    candidates: [{ raw: { user: "peer", file: "Music\\Artist Name\\02 Other Track.mp3", size: 0 } }] });

  for (const [jobId, trackNumber] of [[usenetJobId, 1], [slskdJobId, 2]]) {
    const job = downloadTracker.getJob(jobId);
    assert.equal(job.status, "done", job.error);
    const { common } = await parseFile(job.finalPath);
    assert.deepEqual([common.album, common.track.no], ["Album Name", trackNumber]);
  }
});
