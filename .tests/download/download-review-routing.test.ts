import { usenetCandidate } from "./fixtures.ts";
import { createTrackedJob, trackedJob, ytdlpResult } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "node:path";
import { watch } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseFile } from "music-metadata";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

type UsenetPayload = Parameters<typeof processUsenetPipelinePayload>[0];
type YtdlpPayload = Parameters<typeof processYtdlpPipelinePayload>[0];
type PipelinePayload = import("../../backend/services/downloadPipeline.ts").PipelinePayload;
type DeemixPayload = Parameters<typeof processDeemixPipelinePayload>[0];

const [
  isolatedState,
  { downloadTracker },
  { buildResolvedJobTrack },
  { processYtdlpPipelinePayload, isYtdlpLiveResult, hasEnoughCandidates },
  { processUsenetPipelinePayload, collectDownloadedAudioFiles },
  { processDeemixPipelinePayload },
  { dbOps },
  { db },
  pipelineHelpersModule,
  ,
  downloadWorkerModule,
  cancellationModule,
  { processPipelinePayload },
  { getDownloadClient },
  { getScheduledLibraryScanJobId, scanRegistrySchema },
  { getLibraryScanQueue },
] = await setupIsolatedBackend(
  "download-review-routing",
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadUtils.ts"),
  () => import("../../backend/services/ytdlpOrchestrator.ts"),
  () => import("../../backend/services/usenetOrchestrator.ts"),
  () => import("../../backend/services/deemixOrchestrator.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/pipelineHelpers.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/libraryScanWorker.ts"),
  () => import("../../backend/services/honkerDb.ts"),
);

const { blockPipelineJobForReview, finalizePipelineJobSuccess } = pipelineHelpersModule;

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
  const request = buildResolvedJobTrack({
    artistName: "Artist Name",
    trackName: "Correct Track",
    durationMs: 1000,
  });
  assert.equal(
    hasEnoughCandidates(
      [
        ytdlpResult({
          id: "live-video",
          title: "Artist Name - Correct Track",
          liveStatus: "is_live",
        }),
      ],
      request,
    ),
    false,
  );
});

test("yt-dlp searches a compilation track by its own artist and reverses an empty search", async () => {
  const client = getDownloadClient("ytdlp");
  const queries: string[] = [];
  const song = ytdlpResult({
    id: "song",
    title: "Go All the Way",
    channel: "Raspberries - Topic",
    durationSec: 203,
  });
  vi.spyOn(client, "search").mockImplementation(async (query: string, options = {}) => {
    queries.push(options.songs ? `songs: ${query}` : query);
    return query.startsWith("Go All the Way") ? [song] : [];
  });
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Various Artists",
      artistAliases: ["Raspberries"],
      trackName: "Go All the Way",
      albumName: "Awesome Mix",
      durationMs: 202786,
    },
    "ytdlp-compilation",
  );
  const next = await processYtdlpPipelinePayload(
    { phase: "search", source: "ytdlp", jobId },
    { failOrTryNextSource: async (_payload, _job, reason) => assert.fail(reason) },
  );
  assert.ok(next != null);
  assert.deepEqual(queries, [
    "songs: Raspberries Go All the Way",
    "Raspberries Go All the Way",
    "Raspberries Go All the Way official audio",
    "Go All the Way Raspberries",
  ]);
  assert.equal(next.phase, "download");
  assert.ok(next.candidates != null);
  assert.deepEqual(next.candidates[0].raw, song);
});

test("Usenet file collection only scans the current history directory", async () => {
  const sharedRoot = path.join(process.env.DOWNLOAD_FOLDER!, "usenet-shared-root");
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
  const filePath = path.join(process.env.DOWNLOAD_FOLDER!, "existing-library-song.mp3");
  await writeOneSecondMp3(filePath);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist Name", trackName: "Correct Track", albumName: "Album Name" },
    "deemix-source-safety",
  );
  assert.ok(jobId != null);
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
    const result = await processDeemixPipelinePayload(
      {
        phase: "finalize",
        source: "deemix",
        jobId,
        queueUuid: "track_1_1",
        downloadedPath: filePath,
        candidate: { raw: { title: "Correct Track", artist: "Artist Name" } },
      },
      { failOrTryNextSource: failIfPipelineFallsThrough },
    );

    assert.equal(result, null);
    await access(filePath);
  } finally {
    await server.close();
  }
});

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("pipeline completion queues only committed files and settling does not expand the scan", async () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const committedPaths: string[] = [];
  for (const playlistType of ["library", "flow-playlist", "static-playlist"]) {
    const jobId = createTrackedJob(
      downloadTracker,
      { artistName: "Artist", trackName: playlistType },
      playlistType,
    );
    const filePath = path.join(process.env.DOWNLOAD_FOLDER!, "Artist", `${playlistType}.flac`);
    committedPaths.push(filePath);
    await finalizePipelineJobSuccess({
      downloadTracker,
      job: trackedJob(downloadTracker, jobId),
      committedFinalPath: filePath,
    });
    assert.equal(trackedJob(downloadTracker, jobId).status, "done");
    assert.equal(trackedJob(downloadTracker, jobId).finalPath, filePath);
  }

  const scanId = getScheduledLibraryScanJobId();
  assert.ok(scanId != null);
  assert.ok(getLibraryScanQueue().getJob(scanId));
  const registry = dbOps.getJSONSetting("pendingLibraryScanJob", scanRegistrySchema);
  assert.ok(registry != null);
  assert.deepEqual(registry.changedPaths, committedPaths);
  assert.notEqual(registry.force, true);
  assert.equal(registry.includeLidarr, false);
});

async function writeOneSecondMp3(
  filePath: string,
  {
    title = "Correct Track",
    artist = "Artist Name",
    seconds = 1,
  }: { title?: string; artist?: string; seconds?: number } = {},
) {
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

function addDurationMismatchJob(playlistId: string) {
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 15000,
      trackNumber: 1,
    },
    playlistId,
  );
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);
  return jobId;
}

async function failIfPipelineFallsThrough(): Promise<never> {
  assert.fail("blocked download fell through to source retry");
}

async function assertReviewable(jobId: string, source: string) {
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "blocked");
  assert.equal(job.downloadSource, source);
  assert.equal(job.error, "downloaded file is 14.0s shorter than the requested track");
  await access(job.stagingPath!);
  return job.stagingPath;
}

const downloadSourceIds = ["slskd", "deemix", "ytdlp", "nzbget", "sabnzbd"] as const;

function useOnlySources(
  t: import("vite-plus/test").TestContext,
  ...sources: (typeof downloadSourceIds)[number][]
) {
  for (const id of downloadSourceIds) {
    const client: { isConfigured(): boolean } = getDownloadClient(id);
    vi.spyOn(client, "isConfigured").mockImplementation(() => sources.includes(id));
  }
}

test("yt-dlp sends plausible duration mismatches to review", async (t) => {
  useOnlySources(t, "ytdlp");
  const jobId = addDurationMismatchJob("ytdlp-review");
  assert.ok(jobId != null);
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER!,
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

test("yt-dlp auto-rejects weak title matches instead of reviewing them", async () => {
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 1000,
    },
    "ytdlp-weak-title-review",
  );
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER!,
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

  const sourceFailures: string[] = [];
  const result = await processYtdlpPipelinePayload(
    {
      phase: "finalize",
      source: "ytdlp",
      jobId,
      downloadedPath: filePath,
      destination: "ytdlp-weak-title-review/Artist Name/Album Name",
      candidate: {
        raw: ytdlpResult({
          id: "video-weak-title",
          title: "Artist Name - Wrong Track",
        }),
      } as NonNullable<YtdlpPayload["candidate"]>,
      candidateIndex: 0,
    },
    {
      failOrTryNextSource: async (payload, job, reason) => {
        sourceFailures.push(reason);
        return null;
      },
    },
  );

  assert.equal(result, null);
  await assert.rejects(() => access(filePath), undefined!, "the wrong-track file must be removed");
  assert.equal(sourceFailures.length, 1);
  assert.match(sourceFailures[0], /filename-title/);
});

test("yt-dlp holds partially-matching identity for review", async (t) => {
  useOnlySources(t, "ytdlp");
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "",
      durationMs: 1000,
    },
    "ytdlp-weak-artist-review",
  );
  assert.ok(jobId != null);
  downloadTracker.setDownloading(jobId);
  const filePath = path.join(process.env.DOWNLOAD_FOLDER!, ".ytdlp-staging", jobId, "Correct.mp3");
  await writeOneSecondMp3(filePath, { title: "Correct Tracks" });

  const result = await processPipelinePayload({
    phase: "finalize",
    source: "ytdlp",
    jobId,
    downloadedPath: filePath,
    destination: "ytdlp-weak-artist-review/Artist Name",
    candidate: {
      raw: {
        id: "video-weak-artist",
        title: "Correct Tracks",
      },
    },
    candidateIndex: 0,
  });

  assert.equal(result, null);
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
  assert.equal(job.status, "blocked");
  assert.equal(
    job.error,
    "downloaded file has a title that only partly matches the requested track",
  );
  await access(job.stagingPath!);
});

test("Usenet tries its other releases before sending a file to review", async () => {
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  });

  try {
    const completedDir = path.join(process.env.DOWNLOAD_FOLDER!, "usenet-complete");
    const releaseDir = (name: string) => path.join(completedDir, name);
    const heldPath = path.join(releaseDir("first"), "01 Correct Track.mp3");
    await writeOneSecondMp3(heldPath);
    await writeOneSecondMp3(path.join(releaseDir("second"), "01 Correct Track.mp3"));
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
    assert.ok(jobId != null);
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: "usenet",
      downloadClient: "nzbget",
      downloadClientId: 1,
      releaseGuid: "release-1",
      remoteFilename: "Artist Name - Album Name",
    });
    const candidate = (guid: string) =>
      usenetCandidate({
        raw: {
          guid,
          release: {
            guid,
            title: "Artist Name - Album Name",
            downloadUrl: `http://indexer/${guid}`,
          },
        },
      });
    const sourceFailures: { payload: UsenetPayload; reason: string }[] = [];
    const helpers: Parameters<typeof processUsenetPipelinePayload>[1] = {
      failOrTryNextSource: async (payload, job, reason) => {
        sourceFailures.push({ payload, reason });
        return null;
      },
    };

    const next = await processUsenetPipelinePayload(
      {
        phase: "finalize",
        source: "usenet",
        jobId,
        nzbId: 1,
        destination: "usenet-review/Artist Name/Album Name",
        history: { FinalDir: releaseDir("first") },
        candidates: [candidate("release-1"), candidate("release-2")],
        candidateIndex: 0,
      },
      helpers,
    );
    assert.ok(next != null);

    assert.equal(next.candidateIndex, 1);
    assert.ok(next.heldForReview != null);
    assert.equal(next.heldForReview.sourcePath, heldPath);
    assert.notEqual(trackedJob(downloadTracker, jobId).status, "blocked");
    await access(heldPath);

    await processUsenetPipelinePayload(
      {
        ...next,
        phase: "finalize",
        nzbId: 2,
        history: { FinalDir: releaseDir("second") },
      } as UsenetPayload,
      helpers,
    );
    assert.equal(sourceFailures.length, 1);
    assert.equal(sourceFailures[0].payload.heldForReview?.sourcePath, heldPath);
    assert.equal(
      sourceFailures[0].reason,
      "downloaded file is 14.0s shorter than the requested track",
    );
    await access(heldPath);
  } finally {
    await server.close();
  }
});

test("an automatic Usenet upgrade drops a file it cannot verify and keeps the Library copy", async () => {
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  });
  try {
    const completedDir = path.join(process.env.DOWNLOAD_FOLDER!, "usenet-upgrade-complete");
    const candidatePath = path.join(completedDir, "release", "01 Correct Track.flac");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    const generated = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "flac",
      "-metadata",
      "title=Correct Track",
      "-metadata",
      "artist=Artist Name",
      candidatePath,
    ]);
    assert.equal(generated.status, 0);
    const originalPath = path.join(process.env.DOWNLOAD_FOLDER!, "upgrade-original.mp3");
    await writeOneSecondMp3(originalPath);
    dbOps.updateSettings({
      integrations: { nzbget: { enabled: true, url: server.url, completedPath: completedDir } },
    });
    const sourceJobId = addDurationMismatchJob("usenet-upgrade");
    assert.ok(sourceJobId != null);
    downloadTracker.setDone(sourceJobId, originalPath, "Album Name");
    downloadTracker.updateQuality(sourceJobId, { tier: "mp3-128" });
    const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, sourceJobId));
    assert.ok(upgradeJobId != null);
    downloadTracker.setDownloading(upgradeJobId);
    const failures: { payload: UsenetPayload; reason: string }[] = [];

    await processUsenetPipelinePayload(
      {
        phase: "finalize",
        source: "usenet",
        jobId: upgradeJobId,
        upgradeForJobId: sourceJobId,
        nzbId: 1,
        history: { FinalDir: path.dirname(candidatePath) },
        candidates: [
          usenetCandidate({
            raw: {
              guid: "upgrade-1",
              release: { guid: "upgrade-1", title: "Artist Name - Album Name" },
            },
          }),
        ],
        candidateIndex: 0,
      },
      {
        failOrTryNextSource: (payload, job, reason) => {
          failures.push({ payload, reason });
          return null;
        },
      },
    );

    assert.notEqual(downloadTracker.getJob(upgradeJobId)?.status, "blocked");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].payload.heldForReview, undefined);
    assert.equal(trackedJob(downloadTracker, sourceJobId).finalPath, originalPath);
    await access(originalPath);
  } finally {
    await server.close();
  }
});

test("upgrade duration mismatches remain available for review", async () => {
  const originalPath = path.join(process.env.DOWNLOAD_FOLDER!, "original.mp3");
  const candidatePath = path.join(process.env.DOWNLOAD_FOLDER!, "candidate.mp3");
  await writeOneSecondMp3(originalPath);
  await writeOneSecondMp3(candidatePath);

  const sourceJobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 100000,
    },
    "upgrade-review",
  );
  assert.ok(sourceJobId != null);
  downloadTracker.setDone(sourceJobId, originalPath, "Album Name");
  const upgradeJobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, sourceJobId));
  assert.ok(upgradeJobId != null);
  downloadTracker.setDownloading(upgradeJobId);

  const result = blockPipelineJobForReview({
    downloadTracker,
    job: trackedJob(downloadTracker, upgradeJobId),
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

test("deemix drops its queue entry before a track goes to review", async () => {
  const removed: (string | null)[] = [];
  const filePath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "deemix-complete",
    "Artist Name - Correct Track.mp3",
  );
  await writeOneSecondMp3(filePath);
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    const url = new URL(req.url!, "http://deemix.test");
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
    assert.ok(jobId != null);
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
    assert.ok(polled != null);

    assert.equal(polled.phase, "finalize");
    assert.deepEqual([...removed], []);

    const result = await processDeemixPipelinePayload(polled as DeemixPayload, {
      failOrTryNextSource: failIfPipelineFallsThrough,
    });

    assert.equal(result, null);
    assert.equal(await assertReviewable(jobId, "deemix"), filePath);
    assert.deepEqual(removed, ["track_1_1"]);
  } finally {
    await server.close();
  }
});

test("deemix reuses an existing final path instead of creating a duplicate", async () => {
  const sourcePath = path.join(
    process.env.DOWNLOAD_FOLDER!,
    "deemix-duplicate-source",
    "Artist Name - Correct Track.mp3",
  );
  const destination = "deemix-duplicate/Artist Name/Album Name";
  const targetPath = path.join(process.env.WEEKLY_FLOW_FOLDER!, destination, "Correct Track.mp3");
  await writeOneSecondMp3(sourcePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "existing-audio", "utf8");
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    const url = new URL(req.url!, "http://deemix.test");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        url.pathname === "/api/getQueue"
          ? { queue: { track_1_1: { status: "completed", files: [{ path: sourcePath }] } } }
          : { result: true },
      ),
    );
  });

  let jobId: string | null = null;
  try {
    dbOps.updateSettings({
      integrations: { deemix: { enabled: true, url: server.url, bitrate: 1 } },
    });
    jobId = createTrackedJob(
      downloadTracker,
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
          resolvedAlbumName: "Other Release",
        },
        candidateIndex: 0,
      },
      { failOrTryNextSource: failIfPipelineFallsThrough },
    );
    assert.ok(polled != null);

    const result = await processDeemixPipelinePayload(polled as DeemixPayload, {
      failOrTryNextSource: failIfPipelineFallsThrough,
    });

    assert.equal(result, null);
    assert.equal(downloadTracker.getJob(jobId)?.status, "done");
    assert.equal(downloadTracker.getJob(jobId)?.finalPath, targetPath);
    assert.equal(downloadTracker.getJob(jobId)?.albumName, "Album Name");
    assert.equal(await readFile(targetPath, "utf8"), "existing-audio");
    await assert.rejects(() => access(sourcePath));
    await assert.rejects(() =>
      access(path.join(path.dirname(targetPath), "Correct Track (2).mp3")),
    );
  } finally {
    if (jobId) downloadTracker.removeJob(jobId);
    await server.close();
    await rm(path.dirname(targetPath), { recursive: true, force: true });
    await rm(path.dirname(sourcePath), { recursive: true, force: true });
  }
});

test("Soulseek tries the other candidates before sending a file to review", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  useOnlySources(t, "slskd");
  const root = path.join(isolatedState.baseDir, "slskd-held");
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getDownloadDirectory").mockImplementation(async () => root);
  vi.spyOn(client, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  const candidate = (name: string) => ({
    raw: { user: name, file: `Music\\Artist Name\\${name}.mp3`, size: 0 },
  });
  const finalize = (payload: Partial<PipelinePayload> & Pick<PipelinePayload, "jobId">) =>
    processPipelinePayload({ ...payload, phase: "finalize", source: "slskd" });

  const jobId = addDurationMismatchJob("slskd-held");
  const held = path.join(root, "Artist Name", "held.mp3");
  const other = path.join(root, "Artist Name", "other.mp3");
  await writeOneSecondMp3(held);
  await writeOneSecondMp3(other);
  const next = await finalize({
    jobId,
    candidateIndex: 0,
    candidates: [candidate("held"), candidate("other")],
  });
  assert.ok(next != null);
  assert.equal(next.candidateIndex, 1);
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "blocked");
  await finalize(next);
  assert.equal(trackedJob(downloadTracker, jobId).status, "blocked");
  assert.equal(trackedJob(downloadTracker, jobId).stagingPath, held);
  await access(held);
  await assert.rejects(access(other));

  const verifiedJobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 1000,
    },
    "slskd-held",
  );
  assert.ok(verifiedJobId != null);
  downloadTracker.setDownloading(verifiedJobId);
  const longer = path.join(root, "Artist Name", "longer.mp3");
  await writeOneSecondMp3(longer, { seconds: 30 });
  await writeOneSecondMp3(other);
  const retry = await finalize({
    jobId: verifiedJobId,
    candidateIndex: 0,
    candidates: [candidate("longer"), candidate("other")],
  });
  assert.ok(retry != null);
  await finalize(retry);
  assert.equal(trackedJob(downloadTracker, verifiedJobId).status, "done");
  await assert.rejects(access(longer));
});

test("a yt-dlp file waits for review while the next source is tried", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  useOnlySources(t, "ytdlp", "slskd");
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const root = path.join(isolatedState.baseDir, "ytdlp-held-slskd");
  const client = getDownloadClient("slskd");
  vi.spyOn(client, "getDownloadDirectory").mockImplementation(async () => root);
  vi.spyOn(client, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  const peer = (name: string) => ({
    raw: { user: "peer", file: `Music\\Artist Name\\${name}.mp3`, size: 0 },
  });
  const fromYtdlp = async (jobId: string, seconds: number) => {
    const video = path.join(isolatedState.baseDir, "ytdlp-held", "ytdlp", jobId, "video.mp3");
    await writeOneSecondMp3(video, { seconds });
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: "ytdlp",
      downloadClient: "ytdlp",
      releaseGuid: "video-held",
      remoteFilename: "Artist Name - Correct Track",
    });
    const next = await processPipelinePayload({
      jobId,
      phase: "finalize",
      source: "ytdlp",
      downloadedPath: video,
      candidate: { raw: { id: "video-held", title: "Artist Name - Correct Track" } },
      candidateIndex: 0,
    });
    assert.ok(next != null);
    assert.equal(next.source, "slskd");
    assert.equal(trackedJob(downloadTracker, jobId).status, "downloading");
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: "slskd",
      downloadClient: "slskd",
      remoteUsername: "peer",
      remoteFilename: "Music\\Artist Name\\other.mp3",
    });
    return next;
  };

  const jobId = addDurationMismatchJob("ytdlp-held");
  assert.ok(jobId != null);
  const next = await fromYtdlp(jobId, 1);
  await writeOneSecondMp3(path.join(root, "Artist Name", "other.mp3"));
  await processPipelinePayload({ ...next, phase: "finalize", candidates: [peer("other")] });
  const parked = await assertReviewable(jobId, "ytdlp");
  assert.ok(parked != null);
  await assert.rejects(access(path.join(root, "Artist Name", "other.mp3")));
  const { denyBlockedJob } =
    await import("../../backend/services/downloadJobs/blockedJobReview.ts");
  await denyBlockedJob(jobId);
  assert.deepEqual(trackedJob(downloadTracker, jobId)!.deniedRemoteSources!.at(-1), [
    "ytdlp",
    "video-held",
  ]);
  await assert.rejects(access(parked));

  const verifiedJobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      durationMs: 1000,
    },
    "ytdlp-held",
  );
  assert.ok(verifiedJobId != null);
  downloadTracker.setDownloading(verifiedJobId);
  const retry = await fromYtdlp(verifiedJobId, 30);
  assert.ok(retry != null);
  await writeOneSecondMp3(path.join(root, "Artist Name", "other.mp3"));
  await processPipelinePayload({ ...retry, phase: "finalize", candidates: [peer("other")] });
  assert.equal(trackedJob(downloadTracker, verifiedJobId).status, "done");
  assert.ok(retry.heldForReview != null);
  await assert.rejects(access(retry.heldForReview.sourcePath!));
});

test("denying a held file starts a stopped worker to search again", async () => {
  const start = vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const jobId = addDurationMismatchJob("deny-restart");
  assert.ok(jobId != null);
  const staged = path.join(isolatedState.baseDir, "deny-restart", "held.mp3");
  await writeOneSecondMp3(staged);
  downloadTracker.setBlocked(
    jobId,
    "downloaded file is 14.0s shorter than the requested track",
    staged,
  );
  const { denyBlockedJob } =
    await import("../../backend/services/downloadJobs/blockedJobReview.ts");
  assert.equal((await denyBlockedJob(jobId)).status, 200);
  assert.equal(trackedJob(downloadTracker, jobId).status, "pending");
  assert.equal(start.mock.calls.length, 1);
});

async function waitUntilGone(filePath: string) {
  const watcher = watch(path.dirname(filePath));
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () =>
        access(filePath).then(
          () => {},
          () => resolve(),
        );
      watcher.on("change", check);
      watcher.on("error", reject);
      void check();
    });
  } finally {
    watcher.close();
  }
}

test("removing a job in review discards its file but leaves a Library file", async () => {
  const { resolveDownloadRoot } = await import("../../backend/services/downloadPaths.ts");
  const inLibrary = path.join(
    resolveDownloadRoot(),
    "review-removal",
    "Artist Name - Correct Track.mp3",
  );
  const staged = path.join(isolatedState.baseDir, "review-removal", "held.mp3");
  for (const filePath of [inLibrary, staged]) {
    await writeOneSecondMp3(filePath);
    const jobId = addDurationMismatchJob("review-removal");
    assert.ok(jobId != null);
    downloadTracker.setBlocked(
      jobId,
      "downloaded file is 14.0s shorter than the requested track",
      filePath,
    );
  }

  assert.equal(downloadTracker.clearByPlaylistId("review-removal"), 2);
  await waitUntilGone(staged);
  await access(inLibrary);
});

test("denying a review removes its file and yt-dlp folder but leaves a Library file", async () => {
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const stagingRoot = path.join(isolatedState.baseDir, "deny-cleanup");
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      ytdlp: { stagingPath: stagingRoot },
    },
  });
  const { denyBlockedJob } =
    await import("../../backend/services/downloadJobs/blockedJobReview.ts");
  const review = async (filePath: string | ((jobId: string) => string), source: string) => {
    const jobId = addDurationMismatchJob("deny-cleanup");
    assert.ok(jobId != null);
    const stagedPath = typeof filePath === "function" ? filePath(jobId) : filePath;
    await writeOneSecondMp3(stagedPath);
    downloadTracker.updateDownloadMetadata(jobId, {
      downloadSource: source,
      releaseGuid: `${source}-1`,
    });
    downloadTracker.setBlocked(
      jobId,
      "downloaded file is 14.0s shorter than the requested track",
      stagedPath,
    );
    assert.equal((await denyBlockedJob(jobId)).status, 200);
    return jobId;
  };

  const ytdlpJobId = await review(
    (jobId) => path.join(stagingRoot, "ytdlp", jobId, "video-1.mp3"),
    "ytdlp",
  );
  assert.ok(ytdlpJobId != null);
  await assert.rejects(access(path.join(stagingRoot, "ytdlp", ytdlpJobId)));

  vi.spyOn(getDownloadClient("slskd"), "getDownloadDirectory").mockImplementation(async () => {
    throw new Error("slskd is unreachable");
  });
  const fromSoulseek = path.join(stagingRoot, "slskd", "Artist Name", "01 Correct Track.mp3");
  await review(fromSoulseek, "slskd");
  await assert.rejects(access(fromSoulseek));

  const { resolveDownloadRoot } = await import("../../backend/services/downloadPaths.ts");
  const inLibrary = path.join(
    resolveDownloadRoot(),
    "deny-cleanup",
    "Artist Name - Correct Track.mp3",
  );
  await review(inLibrary, "deemix");
  await access(inLibrary);
});

// Stands in for a download folder on a slow network mount: ffmpeg fails, as it
// times out there, on any file in that folder and works everywhere else.
async function failFfmpegIn(t: import("vite-plus/test").TestContext, folder: string) {
  const bin = path.join(isolatedState.baseDir, "slow-mount-bin");
  const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "ffmpeg"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in "${folder}"/*) echo "Connection timed out" >&2; exit 1 ;; esac
done
exec "${ffmpeg}" "$@"
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.onTestFinished(() => {
    process.env.PATH = originalPath;
  });
}

test("a download is tagged after it reaches the Library, so a slow download folder cannot fail it", async (t: import("vite-plus/test").TestContext) => {
  const slowFolder = path.join(isolatedState.baseDir, "slow-mount");
  const usenetFile = path.join(
    slowFolder,
    "usenet",
    "Artist Name",
    "Album Name",
    "01 Correct Track.mp3",
  );
  const slskdRoot = path.join(slowFolder, "slskd");
  const slskdFile = path.join(slskdRoot, "Artist Name", "02 Other Track.mp3");
  await writeOneSecondMp3(usenetFile);
  await writeOneSecondMp3(slskdFile, { title: "Other Track" });
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  });
  t.onTestFinished(() => server.close());
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      nzbget: { enabled: true, url: server.url, completedPath: path.join(slowFolder, "usenet") },
      slskd: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  const slskd = getDownloadClient("slskd");
  vi.spyOn(slskd, "getDownloadDirectory").mockImplementation(async () => slskdRoot);
  vi.spyOn(slskd, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  await failFfmpegIn(t, slowFolder);
  const addJob = (trackName: string, trackNumber: number) => {
    const jobId = createTrackedJob(
      downloadTracker,
      {
        artistName: "Artist Name",
        trackName,
        albumName: "Album Name",
        durationMs: 1000,
        trackNumber,
      },
      "slow-mount",
    );
    assert.ok(jobId != null);
    downloadTracker.setDownloading(jobId);
    return jobId;
  };

  const usenetJobId = addJob("Correct Track", 1);
  await processUsenetPipelinePayload(
    {
      phase: "finalize",
      source: "usenet",
      jobId: usenetJobId,
      nzbId: 1,
      destination: "slow-mount/Artist Name/Album Name",
      history: { FinalDir: path.join(slowFolder, "usenet") },
      candidates: [
        usenetCandidate({
          raw: {
            guid: "release-1",
            release: { guid: "release-1", title: "Artist Name - Album Name" },
          },
          resolvedAlbumName: "Other Release",
        }),
      ],
      candidateIndex: 0,
    },
    { failOrTryNextSource: failIfPipelineFallsThrough },
  );
  const slskdJobId = addJob("Other Track", 2);
  await processPipelinePayload({
    phase: "finalize",
    source: "slskd",
    jobId: slskdJobId,
    candidateIndex: 0,
    destination: "slow-mount/Artist Name/Album Name",
    candidates: [
      {
        raw: { user: "peer", file: "Music\\Artist Name\\02 Other Track.mp3", size: 0 },
        resolvedAlbumName: "Other Release",
      },
    ],
  });

  const expectedTracks: [string, number][] = [
    [usenetJobId, 1],
    [slskdJobId, 2],
  ];
  for (const [jobId, trackNumber] of expectedTracks) {
    const job = trackedJob(downloadTracker, jobId);
    assert.equal(job.status, "done", job.error ?? "no error");
    const { common } = await parseFile(job.finalPath!);
    assert.deepEqual(
      [job.albumName, common.album, common.track.no],
      ["Album Name", "Album Name", trackNumber],
    );
  }
});
