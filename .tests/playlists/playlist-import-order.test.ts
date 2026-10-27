import { playlistTrack, requireFixture } from "./fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  trackerModule,
  playlistConfigModule,
  operationsModule,
  workerModule,
  flowTrackSourceModule,
  playlistManagerModule,
  spotifyClientModule,
  importSyncModule,
  importPlaylistModule,
  operationQueueModule,
  loggerModule,
  listenbrainzPlaylistsModule,
  lastfmStationsModule,
  youtubeMusicPlaylistsModule,
  { api },
] = await setupIsolatedBackend(
  "playlist-import-order",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/flows/flowTrackSource.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/spotify/spotifyClient.ts"),
  () => import("../../backend/services/importLists/importListSync.ts"),
  () => import("../../backend/services/importLists/importPlaylist.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/logger.ts"),
  () => import("../../backend/services/importLists/listenbrainzPlaylists.ts"),
  () => import("../../backend/services/importLists/lastfmStations.ts"),
  () => import("../../backend/services/importLists/youtubeMusicPlaylists.ts"),
  () => import("../../backend/routes/api.ts"),
);

const { downloadTracker } = trackerModule;
const {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  orderJobsByPlaylistTracks,
  rebuildStaticPlaylistTracksFromJobs,
} = playlistConfigModule;
const {
  appendStaticPlaylistTracks,
  markLatestPlaylistOperationToken,
  processPlaylistOperation,
  updateStaticPlaylist,
} = operationsModule;
const { downloadWorker, DownloadWorker } = workerModule;
assert.ok(downloadWorker instanceof DownloadWorker);
const { flowTrackSource } = flowTrackSourceModule;
const { playlistManager } = playlistManagerModule;
const { spotifyClient } = spotifyClientModule;
const { listenbrainzPlaylistClient } = listenbrainzPlaylistsModule;
const { lastfmStationClient } = lastfmStationsModule;
const { youtubeMusicPlaylistClient } = youtubeMusicPlaylistsModule;
const { syncStaticPlaylistImport } = importSyncModule;
const { enqueueImportedPlaylist } = importPlaylistModule;
const { playlistOperationQueue } = operationQueueModule;
const { logger } = loggerModule;

const requestAs = async (userId: number, path: string, body?: object) => {
  const response = await signedInAs(testUser(userId, { permissions: { accessFlow: true } }))
    .route("/", api)
    .request(
      `/playlists${path}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
  return { status: response.status, body: await response.json() };
};

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);

test("import sync delegates to the flow owner without blocking the web event loop", async () => {
  const { configureDownloadOwnerClient } =
    await import("../../backend/services/downloadJobs/downloadOwnerClient.ts");
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestServer = process.env.AURRAL_TEST_SERVER;
  const requests: { method: string; args: unknown[]; options: { timeoutMs: number } }[] = [];
  const worker = Promise.withResolvers<unknown>();
  configureDownloadOwnerClient({
    request: (method, args, options) => {
      requests.push({ method, args, options });
      return worker.promise;
    },
    getStatus: () => null,
  });
  process.env.NODE_ENV = "production";
  delete process.env.AURRAL_TEST_SERVER;
  try {
    const user = { id: 7, role: "admin", token: "not-for-worker" };
    const sync = syncStaticPlaylistImport({ playlistId: "playlist-id", user, force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.method, "syncStaticPlaylistImport");
    assert.deepEqual(request.args, [
      {
        playlistId: "playlist-id",
        user: { id: 7, role: "admin" },
        force: true,
      },
    ]);
    assert.equal(request.options.timeoutMs, 5 * 60 * 1000);
    worker.resolve({ ok: true, result: { trackCount: 1001, tracksQueued: 1 } });
    assert.deepEqual(await sync, { trackCount: 1001, tracksQueued: 1 });

    configureDownloadOwnerClient({
      request: async () => ({
        ok: false,
        error: {
          message: "Spotify connection expired",
          code: "SPOTIFY_AUTH_REQUIRED",
          statusCode: 401,
        },
      }),
      getStatus: () => null,
    });
    await assert.rejects(
      syncStaticPlaylistImport({ playlistId: "playlist-id", user: { id: 7 }, force: true }),
      { code: "SPOTIFY_AUTH_REQUIRED", statusCode: 401 },
    );
  } finally {
    configureDownloadOwnerClient({ request: null, getStatus: () => null });
    process.env.NODE_ENV = originalNodeEnv;
    if (originalTestServer === undefined) delete process.env.AURRAL_TEST_SERVER;
    else process.env.AURRAL_TEST_SERVER = originalTestServer;
  }
});

test("mutation release unblocks every playlist and prunes after an unblock error", async () => {
  const { beginPlaylistMutation } =
    await import("../../backend/services/downloadJobs/mutationGuards.ts");
  const calls: string[] = [];
  vi.spyOn(downloadWorker, "blockPlaylist").mockImplementation(() => true);
  vi.spyOn(downloadWorker, "waitForPlaylistIdle").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "unblockPlaylist").mockImplementation((id) => {
    calls.push(`unblock:${id}`);
    if (id === "first") throw new Error("unblock failed");
    return true;
  });
  vi.spyOn(downloadWorker, "pruneOrphanedJobState").mockImplementation(async () => {
    calls.push("prune");
  });

  const release = await beginPlaylistMutation(["first", "second"], { clearPending: false });
  await assert.rejects(release(), /unblock failed/);
  assert.deepEqual(calls, ["unblock:first", "unblock:second", "prune"]);
});

test("flow settings locks serialize with playlist mutations", async () => {
  const { withPlaylistMutation, withPlaylistMutationLock } =
    await import("../../backend/services/downloadJobs/mutationGuards.ts");
  const mutationEntered = Promise.withResolvers<void>();
  const mutationGate = Promise.withResolvers<void>();
  let updateEntered = false;
  let update: Promise<void> | undefined;
  const mutation = withPlaylistMutation(
    "flow-settings-lock",
    async () => {
      mutationEntered.resolve();
      await mutationGate.promise;
    },
    { clearPending: false },
  );

  try {
    await mutationEntered.promise;
    update = withPlaylistMutationLock("flow-settings-lock", async () => {
      updateEntered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(updateEntered, false);
    mutationGate.resolve();
    await Promise.all([mutation, update]);
    assert.equal(updateEntered, true);
  } finally {
    mutationGate.resolve();
    await Promise.allSettled([mutation, update]);
  }
});

async function writeReusableTrack(
  track: { artistName: string; trackName: string; albumName: string },
  playlistType = "source-playlist",
) {
  const sourcePath = path.join(
    requireFixture(downloadRoot),
    "aurral-weekly-flow",
    playlistType,
    track.artistName,
    track.albumName || "Unknown Album",
    `${track.trackName}.flac`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const jobId = downloadTracker.addJob(track, playlistType);
  assert.ok(jobId);
  downloadTracker.setDone(jobId, sourcePath, track.albumName);
  return { jobId, sourcePath };
}

beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
    playlistArtwork: { style: "aurral" },
  });
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  downloadWorker.stop();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

const addJob = (track: Parameters<typeof downloadTracker.addJob>[0], playlistType: string) => {
  const jobId = downloadTracker.addJob(track, playlistType);
  assert.ok(jobId);
  return jobId;
};

const importSourceOf = (playlistId: string) => {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  assert.ok(playlist?.importSource);
  return playlist.importSource;
};

const emptyPlan = () => ({
  primaryTracks: [],
  reserveTracks: [],
  diagnostics: { targets: { releaseRadar: 0, maxSize: 0 }, achieved: { primary: 0, reserve: 0 } },
});

const captureLog = (level: "info" | "error", message: string) => {
  const logged = Promise.withResolvers<Record<string, unknown>>();
  const spy = vi.spyOn(logger, level).mockImplementation((_scope, entry, details) => {
    if (entry === message) logged.resolve({ ...details });
  });
  return { spy, logged: logged.promise };
};

test("background import logs completion only after the playlist exists", async () => {
  const { spy: info, logged: importCompleted } = captureLog(
    "info",
    "Playlist import job completed",
  );
  const { stopPlaylistOperationWorker } =
    await import("../../backend/services/playlists/playlistOperationWorker.ts");
  try {
    await enqueueImportedPlaylist({
      ownerUserId: 7,
      name: "Completed Import",
      provider: "spotify-playlist",
      sourceName: "Test Source",
      externalId: "external-playlist",
      externalName: "External Playlist",
      tracks: [],
      syncEnabled: false,
      syncIntervalHours: 0,
      keepRemovedTracks: true,
    });
    const completed = await importCompleted;
    const started = info.mock.calls.find((call) => call[1] === "Playlist import job started");
    assert.ok(started);
    assert.partialDeepStrictEqual(started[2], { operationId: completed.operationId });
    assert.equal(completed.provider, "spotify-playlist");
    assert.equal(completed.playlistName, "Completed Import");
    assert.ok(flowPlaylistConfig.getStaticPlaylist(String(completed.playlistId)));
    assert.ok(completed.operationId);
    assert.equal(completed.trackCount, 0);
  } finally {
    await stopPlaylistOperationWorker();
  }
});

test("background import logs a permanent failure with its reason", async () => {
  const { logged: importFailed } = captureLog("error", "Playlist import failed");
  const { stopPlaylistOperationWorker } =
    await import("../../backend/services/playlists/playlistOperationWorker.ts");
  flowPlaylistConfig.createStaticPlaylist({
    name: "Duplicate Import",
    ownerUserId: 7,
    tracks: [],
  });
  try {
    await enqueueImportedPlaylist({
      ownerUserId: 7,
      name: "Duplicate Import",
      provider: "listenbrainz-playlist",
      sourceName: "Test Source",
      externalId: "external-playlist",
      externalName: "External Playlist",
      tracks: [],
      syncEnabled: false,
      syncIntervalHours: 0,
      keepRemovedTracks: true,
    });
    const failed = await importFailed;
    assert.equal(failed.provider, "listenbrainz-playlist");
    assert.match(String(failed.reason), /already exists/i);
    assert.ok(failed.operationId);
  } finally {
    await stopPlaylistOperationWorker();
  }
});

test("external import routes log fetch failures with the provider reason", async () => {
  const failures = vi.spyOn(logger, "error").mockImplementation(() => {});
  const providers = [
    {
      route: "/import/spotify",
      reason: "Spotify timed out",
      fail: (reason: string) =>
        vi.spyOn(spotifyClient, "listPlaylistTracks").mockRejectedValue(new Error(reason)),
    },
    {
      route: "/import/listenbrainz",
      reason: "ListenBrainz timed out",
      fail: (reason: string) =>
        vi
          .spyOn(listenbrainzPlaylistClient, "getPlaylistTracks")
          .mockRejectedValue(new Error(reason)),
    },
    {
      route: "/import/lastfm",
      reason: "Last.fm timed out",
      fail: (reason: string) =>
        vi.spyOn(lastfmStationClient, "getStationTracks").mockRejectedValue(new Error(reason)),
    },
  ];

  for (const { route, reason, fail } of providers) {
    fail(reason);
    const response = await requestAs(7, route, {
      playlistId: "external-playlist",
      name: "Test Mix",
      username: "listener",
    });
    assert.equal(response.status, 500);
    const logged = failures.mock.calls.at(-1);
    assert.partialDeepStrictEqual(logged?.[2], {
      playlistName: "Test Mix",
      stage: "fetch",
      reason,
    });
  }
});

test("YouTube Music preview and import trust the refetched source title", async () => {
  const sourceTracks = [
    playlistTrack({ artistName: "Artist A", trackName: "Track A", albumName: "Album A" }),
    playlistTrack({ artistName: "Artist B", trackName: "Track B" }),
  ];
  const getPlaylist = vi
    .spyOn(youtubeMusicPlaylistClient, "getPlaylist")
    .mockImplementation(async () => ({
      id: "PLabcdefghij_123",
      name: "Refetched source title",
      tracks: sourceTracks,
      stats: { sourceItems: 3, unavailable: 1, podcast: 0, incomplete: 0, duplicate: 0 },
      excluded: [{ position: 3, reason: "unavailable" }],
    }));
  const enqueue = vi
    .spyOn(playlistOperationQueue, "enqueuePayload")
    .mockImplementation(async () => ({
      queued: true,
      operationId: 71,
    }));
  const previewResponse = await requestAs(7, "/import/youtube-music/preview", {
    url: "https://music.youtube.com/playlist?list=PLabcdefghij_123",
  });
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(previewResponse.body, {
    playlist: { id: "PLabcdefghij_123", name: "Refetched source title" },
    trackCount: 2,
    skipped: 1,
    previewTracks: sourceTracks,
  });

  const importResponse = await requestAs(7, "/import/youtube-music", {
    playlistId: "PLabcdefghij_123",
    name: "My imported mix",
    externalName: "Spoofed client title",
    syncEnabled: true,
    syncIntervalHours: 12,
    keepRemovedTracks: false,
  });
  assert.equal(importResponse.status, 200);
  assert.equal(getPlaylist.mock.calls.length, 2);
  assert.equal(enqueue.mock.calls.length, 1);
  const queued = enqueue.mock.calls[0]?.[0];
  assert.partialDeepStrictEqual(queued, {
    sourceName: "YouTube Music",
    importSource: {
      provider: "youtube-music-playlist",
      externalId: "PLabcdefghij_123",
      externalName: "Refetched source title",
      syncIntervalHours: 12,
      keepRemovedTracks: false,
    },
  });
  assert.equal(JSON.stringify(queued).includes("Spoofed client title"), false);

  const invalidIntervalResponse = await requestAs(7, "/import/youtube-music", {
    playlistId: "PLabcdefghij_123",
    name: "Invalid schedule",
    syncIntervalHours: "not-a-number",
  });
  assert.equal(invalidIntervalResponse.status, 400);
  assert.deepEqual(invalidIntervalResponse.body, {
    error: "syncIntervalHours must be zero or greater",
  });
  assert.equal(getPlaylist.mock.calls.length, 2);
  assert.equal(enqueue.mock.calls.length, 1);
});

test("YouTube Music route maps provider failures without logging submitted references", async () => {
  const error = Object.assign(new Error("YouTube Music took too long to respond"), {
    code: "YOUTUBE_PLAYLIST_TIMEOUT",
    statusCode: 504,
  });
  vi.spyOn(youtubeMusicPlaylistClient, "getPlaylist").mockImplementation(async () => {
    throw error;
  });
  const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const failures = vi.spyOn(logger, "error").mockImplementation(() => {});
  const response = await requestAs(7, "/import/youtube-music/preview", {
    url: "https://music.youtube.com/playlist?list=PLsecretUnlisted_123",
  });

  assert.equal(response.status, 504);
  assert.deepEqual(response.body, {
    error: "Failed to preview YouTube Music playlist",
    message: "YouTube Music took too long to respond",
    code: "YOUTUBE_PLAYLIST_TIMEOUT",
  });
  const logs = JSON.stringify([warnings.mock.calls, failures.mock.calls]);
  assert.equal(logs.includes("PLsecretUnlisted_123"), false);
  assert.equal(logs.includes("music.youtube.com/playlist"), false);
});

afterAll(async () => {
  downloadWorker.stop();
  await cleanupIsolatedState(isolatedState);
});

test("orderJobsByPlaylistTracks follows config order over createdAt", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
  ];
  const jobs = [
    { id: "2", createdAt: 20, ...tracks[1] },
    { id: "3", createdAt: 30, ...tracks[2] },
    { id: "1", createdAt: 10, ...tracks[0] },
  ];
  const ordered = orderJobsByPlaylistTracks(jobs, tracks);
  assert.deepEqual(
    ordered.map((job) => job.id),
    ["1", "2", "3"],
  );
});

test("rebuildStaticPlaylistTracksFromJobs keeps remaining config order", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
    { artistName: "D", trackName: "Four", albumName: "Album" },
  ];
  const jobs = [
    { id: "10", createdAt: 40, ...tracks[3] },
    { id: "11", createdAt: 10, ...tracks[0] },
    { id: "12", createdAt: 30, ...tracks[2] },
  ];
  const remaining = rebuildStaticPlaylistTracksFromJobs(tracks, jobs);
  assert.deepEqual(
    remaining.map((track) => track.trackName),
    ["One", "Three", "Four"],
  );
});

test("mixed reuse seeding keeps import job order", async () => {
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const reusableA = {
      artistName: "Artist A",
      trackName: "Owned",
      albumName: "Album",
    };
    const missingB = {
      artistName: "Artist B",
      trackName: "Missing",
      albumName: "Album",
    };
    const reusableC = {
      artistName: "Artist C",
      trackName: "Also Owned",
      albumName: "Album",
    };
    const missingD = {
      artistName: "Artist D",
      trackName: "Also Missing",
      albumName: "Album",
    };
    await writeReusableTrack(reusableA);
    await writeReusableTrack(reusableC);

    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Import Order",
      tracks: [],
    });
    const imported = [reusableA, missingB, reusableC, missingD];
    const result = await appendStaticPlaylistTracks({
      playlistId: playlist.id,
      tracks: imported,
    });
    assert.ok(result != null);

    assert.equal(result.tracksReused, 2);
    assert.equal(result.tracksQueued, 2);

    const jobs = orderJobsByPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks,
    );
    assert.deepEqual(
      jobs.map((job) => `${job.artistName}:${job.trackName}:${job.status}`),
      [
        "Artist A:Owned:done",
        "Artist B:Missing:pending",
        "Artist C:Also Owned:done",
        "Artist D:Also Missing:pending",
      ],
    );
    assert.deepEqual(
      jobs.map((job) => job.createdAt),
      [...jobs].map((job) => job.createdAt).sort((left, right) => left - right),
    );
  } finally {
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("flow refresh clears playback before downloads finish", async () => {
  const originalBuildPlan = flowTrackSource.buildFlowRunPlan;
  const originalSync = playlistManager.requestPlaylistSync;
  const originalScheduleNextRun = flowPlaylistConfig.scheduleNextRun;
  const events: string[][] = [];
  try {
    dbOps.updateSettings({
      ...dbOps.getSettings(),
      integrations: {
        lastfm: { apiKey: "test" },
        slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
      },
    });
    const flow = flowPlaylistConfig.createFlow({
      name: "Refresh Before Download",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
    });
    flowPlaylistConfig.setEnabled(flow.id, true);
    flowTrackSource.buildFlowRunPlan = async () => emptyPlan();
    playlistManager.requestPlaylistSync = (playlistIds) => {
      if (playlistIds?.includes(flow.id)) events.push(["sync", flow.id]);
      return null;
    };
    flowPlaylistConfig.scheduleNextRun = (playlistId) => {
      if (playlistId === flow.id) events.push(["schedule", playlistId]);
      return null;
    };

    await processPlaylistOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(events, [
      ["sync", flow.id],
      ["schedule", flow.id],
    ]);
  } finally {
    flowTrackSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.requestPlaylistSync = originalSync;
    flowPlaylistConfig.scheduleNextRun = originalScheduleNextRun;
    downloadWorker.stop();
  }
});

test("a failed flow plan leaves the current playlist and jobs untouched", async () => {
  const originalBuildPlan = flowTrackSource.buildFlowRunPlan;
  const originalReset = playlistManager.weeklyReset;
  let resets = 0;
  try {
    dbOps.updateSettings({
      ...dbOps.getSettings(),
      integrations: {
        lastfm: { apiKey: "test" },
        slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
      },
    });
    const flow = flowPlaylistConfig.createFlow({
      name: "Plan Failure",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
    });
    flowPlaylistConfig.setEnabled(flow.id, true);
    const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, flow.id);
    flowTrackSource.buildFlowRunPlan = async () => {
      throw new Error("Planning unavailable");
    };
    playlistManager.weeklyReset = async () => {
      resets += 1;
    };

    await assert.rejects(
      processPlaylistOperation({ kind: "scheduled-flow-refresh", flowId: flow.id }),
      /Planning unavailable/,
    );
    assert.equal(resets, 0);
    assert.ok(downloadTracker.getJob(jobId));
  } finally {
    flowTrackSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.weeklyReset = originalReset;
    downloadWorker.stop();
  }
});

test("a stale flow plan does not cancel jobs when settings change during planning", async () => {
  const originalBuildPlan = flowTrackSource.buildFlowRunPlan;
  const planningStarted = Promise.withResolvers<void>();
  const deferredPlan = Promise.withResolvers<ReturnType<typeof emptyPlan>>();
  try {
    dbOps.updateSettings({
      ...dbOps.getSettings(),
      integrations: {
        lastfm: { apiKey: "test" },
        slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
      },
    });
    const flow = flowPlaylistConfig.createFlow({
      name: "Settings Change During Planning",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
    });
    flowPlaylistConfig.setEnabled(flow.id, true);
    const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, flow.id);
    const { getPlaylistDownloadGeneration, isDownloadJobCancelled } =
      await import("../../backend/services/downloadJobs/downloadCancellation.ts");
    const generationBeforePlanning = getPlaylistDownloadGeneration(flow.id);
    flowTrackSource.buildFlowRunPlan = async () => {
      planningStarted.resolve();
      return deferredPlan.promise;
    };

    const refresh = processPlaylistOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });
    await planningStarted.promise;
    flowPlaylistConfig.updateFlow(flow.id, { name: "Changed During Planning" });
    deferredPlan.resolve(emptyPlan());

    await assert.rejects(refresh, /Flow settings changed while planning/);
    assert.equal(isDownloadJobCancelled(jobId), false);
    assert.equal(getPlaylistDownloadGeneration(flow.id), generationBeforePlanning);
    assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  } finally {
    flowTrackSource.buildFlowRunPlan = originalBuildPlan;
    downloadWorker.stop();
  }
});

test("a queued flow stops before mutation when its owner becomes suspended", async () => {
  const originalBuildPlan = flowTrackSource.buildFlowRunPlan;
  const originalReset = playlistManager.weeklyReset;
  let resets = 0;
  try {
    dbOps.updateSettings({
      ...dbOps.getSettings(),
      integrations: {
        lastfm: { apiKey: "test" },
        slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
      },
    });
    const owner = userOps.createUser("queued-flow-owner", "unused", "user");
    assert.ok(owner != null);
    const flow = flowPlaylistConfig.createFlow({
      name: "Queued Before Suspension",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
      ownerUserId: owner.id,
    });
    flowPlaylistConfig.setEnabled(flow.id, true);
    flowTrackSource.buildFlowRunPlan = async () => {
      userOps.updateUser(owner.id, { status: "suspended" });
      return emptyPlan();
    };
    playlistManager.weeklyReset = async () => {
      resets += 1;
    };

    const result = await processPlaylistOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    assert.equal(resets, 0);
  } finally {
    flowTrackSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.weeklyReset = originalReset;
    downloadWorker.stop();
  }
});

test("a queued discovery adoption cannot seed downloads for a suspended owner", async () => {
  const originalSeed = downloadWorker.seedFlowRunWithTracks;
  let seedCalls = 0;
  try {
    const owner = userOps.createUser("suspended-adoption-owner", "unused", "user");
    assert.ok(owner != null);
    const flow = flowPlaylistConfig.createFlow({
      name: "Adopted Before Suspension",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
      ownerUserId: owner.id,
    });
    downloadWorker.seedFlowRunWithTracks = async () => {
      seedCalls += 1;
      return { tracksQueued: 1, jobIds: [], reserveTracks: 0 };
    };
    userOps.updateUser(owner.id, { status: "suspended" });

    const result = await processPlaylistOperation({
      kind: "adopt-flow-seed",
      flowId: flow.id,
      tracks: [{ artistName: "Artist", trackName: "Track" }],
    });

    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    assert.equal(seedCalls, 0);
  } finally {
    downloadWorker.seedFlowRunWithTracks = originalSeed;
    downloadWorker.stop();
  }
});

test("download pipeline work is deferred while its playlist owner is suspended", async () => {
  const owner = userOps.createUser("suspended-pipeline-owner", "unused", "user");
  assert.ok(owner != null);
  const flow = flowPlaylistConfig.createFlow({
    name: "Suspended Pipeline",
    mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
    size: 1,
    scheduleDays: [1],
    ownerUserId: owner.id,
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, flow.id);
  userOps.updateUser(owner.id, { status: "suspended" });
  const { processPipelinePayload } = await import("../../backend/services/downloadPipeline.ts");

  assert.ok(jobId);
  const payload = { phase: "search", source: "slskd", jobId } as const;
  assert.deepEqual(await processPipelinePayload(payload), {
    ...payload,
    delaySeconds: 30,
  });

  userOps.updateUser(owner.id, { status: "active" });
  const { isPlaylistOwnerActive } =
    await import("../../backend/services/downloadJobs/playlistOwnerStatus.ts");
  assert.equal(isPlaylistOwnerActive(flow.id), true);
});

test("flow operation tokens are stored separately for each playlist", () => {
  markLatestPlaylistOperationToken("flow:one", "first");
  markLatestPlaylistOperationToken("flow:two", "second");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Aone"), "first");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Atwo"), "second");
});

test("deleting a track keeps remaining import order in config", async () => {
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const tracks = [
      { artistName: "A", trackName: "One", albumName: "Album" },
      { artistName: "B", trackName: "Two", albumName: "Album" },
      { artistName: "C", trackName: "Three", albumName: "Album" },
      { artistName: "D", trackName: "Four", albumName: "Album" },
    ];
    await writeReusableTrack(tracks[0]);
    await writeReusableTrack(tracks[2]);

    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Delete Order",
      tracks: [],
    });
    await appendStaticPlaylistTracks({
      playlistId: playlist.id,
      tracks,
    });

    const jobsBefore = orderJobsByPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks,
    );
    const removedJobId = jobsBefore[1].id;

    const deleted = await processPlaylistOperation({
      kind: "shared-playlist-delete-track",
      playlistId: playlist.id,
      jobId: removedJobId,
    });
    assert.ok(deleted != null);
    assert.partialDeepStrictEqual(deleted, { success: true });

    const updated = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.ok(updated != null);
    assert.deepEqual(
      updated.tracks.map((track) => track.trackName),
      ["One", "Three", "Four"],
    );

    const jobsAfter = orderJobsByPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      updated.tracks,
    );
    assert.deepEqual(
      jobsAfter.map((job) => job.trackName),
      ["One", "Three", "Four"],
    );
  } finally {
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("replacing a static playlist removes Spotify tracks and honors file retention", async () => {
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const keepPlaylist = flowPlaylistConfig.createStaticPlaylist({
      name: "Keep Removed",
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "keep-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    await fs.mkdir(downloadRoot, { recursive: true });
    const keepPath = path.join(downloadRoot, "keep-removed.flac");
    await fs.writeFile(keepPath, "audio");
    const keepJobId = downloadTracker.addJob(track, keepPlaylist.id);
    assert.ok(keepJobId != null);
    downloadTracker.setDone(keepJobId, keepPath, track.albumName);

    await updateStaticPlaylist({
      playlistId: keepPlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: keepPlaylist.importSource,
    });
    assert.deepEqual(
      [...requireFixture(flowPlaylistConfig.getStaticPlaylist(keepPlaylist.id)).tracks],
      [],
    );
    await fs.access(keepPath);

    const deletePlaylist = flowPlaylistConfig.createStaticPlaylist({
      name: "Delete Removed",
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "delete-id",
        syncEnabled: true,
        syncIntervalHours: 24,
        keepRemovedTracks: false,
      },
    });
    const deletePath = path.join(downloadRoot, "delete-removed.flac");
    await fs.writeFile(deletePath, "audio");
    const deleteJobId = downloadTracker.addJob(track, deletePlaylist.id);
    assert.ok(deleteJobId != null);
    downloadTracker.setDone(deleteJobId, deletePath, track.albumName);

    await updateStaticPlaylist({
      playlistId: deletePlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: deletePlaylist.importSource,
      deleteUnsharedFiles: true,
    });
    assert.deepEqual(
      [...requireFixture(flowPlaylistConfig.getStaticPlaylist(deletePlaylist.id)).tracks],
      [],
    );
    await assert.rejects(fs.access(deletePath));
  } finally {
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("renaming or changing sync settings leaves queued downloads alone", async () => {
  const tracks = ["Done", "Queued", "Held", "Failed"].map((trackName) => ({
    artistName: "A",
    trackName,
    albumName: "Album",
  }));
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Imported",
    tracks,
    importSource: {
      provider: "deezer-playlist",
      externalId: "123",
      syncEnabled: true,
      syncIntervalHours: 24,
      keepRemovedTracks: true,
    },
  });
  const [doneId, queuedId, heldId, failedId] = tracks.map((track) => addJob(track, playlist.id));
  assert.ok(doneId && queuedId && heldId && failedId);
  downloadTracker.setDone(doneId, path.join(downloadRoot, "done.flac"), "Album");
  downloadTracker.setBlocked(heldId, "Held for review");
  downloadTracker.setFailed(failedId, "No source");

  await processPlaylistOperation({
    kind: "shared-playlist-update",
    playlistId: playlist.id,
    name: "Renamed",
    tracks: playlist.tracks,
    hasNameUpdate: true,
    hasTracksUpdate: false,
    hasImportSourceUpdate: true,
    importSource: { ...playlist.importSource, syncIntervalHours: 72, keepRemovedTracks: false },
  });

  const updated = flowPlaylistConfig.getStaticPlaylist(playlist.id);
  assert.ok(updated != null);
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.importSource?.syncIntervalHours, 72);
  assert.equal(updated.importSource?.keepRemovedTracks, false);
  assert.equal(updated.tracks.length, 4);
  assert.deepEqual(
    Object.fromEntries(
      downloadTracker.getByPlaylistType(playlist.id).map((job) => [job.id, job.status]),
    ),
    {
      [doneId]: "done",
      [queuedId]: "pending",
      [heldId]: "blocked",
      [failedId]: "failed",
    },
  );
});

test("imported playlist sync preserves enriched jobs while replacing removed tracks", async () => {
  const originalStart = downloadWorker.start;
  downloadWorker.start = async () => {};
  try {
    const pending = {
      artistName: "Artist",
      trackName: "Pending",
      albumName: "Album",
      artistMbid: "11111111-1111-1111-1111-111111111111",
    };
    const completed = {
      artistName: "Artist",
      trackName: "Completed",
      albumName: "Album",
      albumMbid: "22222222-2222-2222-2222-222222222222",
    };
    const removed = { artistName: "Artist", trackName: "Removed", albumName: "Album" };
    const retitled = { artistName: "Artist", trackName: "Retitled", albumName: "Album" };
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Imported Job Retention",
      ownerUserId: 7,
      tracks: [pending, completed, removed, retitled],
      importSource: {
        provider: "spotify-playlist",
        externalId: "imported-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    const pendingJobId = downloadTracker.addJob(pending, playlist.id);
    const completedJobId = downloadTracker.addJob(completed, playlist.id);
    assert.ok(completedJobId != null);
    await fs.mkdir(downloadRoot, { recursive: true });
    const completedPath = path.join(downloadRoot, "imported-retained-completed.flac");
    await fs.writeFile(completedPath, "audio");
    downloadTracker.setDone(completedJobId, completedPath, completed.albumName);
    const removedJobId = downloadTracker.addJob(removed, playlist.id);
    const retitledJobId = downloadTracker.addJob(retitled, playlist.id);
    assert.ok(retitledJobId != null);
    downloadTracker.updateMetadata(retitledJobId, { albumName: "Album (Deluxe Edition)" });
    downloadTracker.setDone(retitledJobId, completedPath, "Album (Deluxe Edition)");

    const result = await updateStaticPlaylist({
      playlistId: playlist.id,
      tracks: [
        { artistName: "Artist", trackName: "Pending", albumName: "Album" },
        { artistName: "Artist", trackName: "Completed", albumName: "Album" },
        { artistName: "Artist", trackName: "New", albumName: "Album" },
        { artistName: "Artist", trackName: "Retitled", albumName: "Album" },
      ],
      hasTracksUpdate: true,
      mergeImportSource: true,
    });
    assert.ok(result != null);

    assert.equal(result.tracksQueued, 1);
    assert.equal(downloadTracker.getJob(retitledJobId)?.status, "done");
    assert.ok(downloadTracker.getJob(pendingJobId));
    assert.equal(downloadTracker.getJob(completedJobId)?.status, "done");
    await fs.access(completedPath);
    assert.equal(downloadTracker.getJob(removedJobId), null);
    assert.ok(
      downloadTracker.getByPlaylistType(playlist.id).some((job) => job.trackName === "New"),
    );
  } finally {
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("ListenBrainz sync uses the shared import update path", async () => {
  const originalStart = downloadWorker.start;
  const originalGetGeneratedPlaylistTracks = listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  downloadWorker.start = async () => {};
  try {
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "ListenBrainz Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "listenbrainz-createdfor",
        externalId: "weekly-jams",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    const releaseMbid = "6d2e1b50-3a4c-4e5f-8a6b-7c8d9e0f1a2b";
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = async () => ({
      tracks: [
        playlistTrack({
          artistName: "New Artist",
          trackName: "New Song",
          releaseMbid,
          trackNumber: 3,
          discNumber: 2,
        }),
      ],
      stats: { incomplete: 0, duplicate: 0 },
    });

    await syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    const syncedTracks = requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks;
    assert.ok(syncedTracks[0].membershipId);
    assert.notEqual(syncedTracks[0].membershipId, playlist.tracks[0].membershipId);
    assert.deepEqual(
      syncedTracks.map(({ membershipId: _membershipId, ...track }) => track),
      [
        {
          artistName: "New Artist",
          trackName: "New Song",
          albumName: null,
          artistMbid: null,
          albumMbid: null,
          trackMbid: null,
          releaseYear: null,
          durationMs: null,
          artistAliases: [],
          reason: null,
          releaseMbid,
          trackNumber: 3,
          discNumber: 2,
        },
      ],
    );
    assert.deepEqual(
      db
        .prepare<
          unknown[],
          {
            track_name: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["track_name"];
            release_mbid: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["release_mbid"];
            track_number: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["track_number"];
            disc_number: import("../../backend/db/rows.ts").PlaylistDownloadJobsRow["disc_number"];
          }
        >(
          "SELECT track_name, release_mbid, track_number, disc_number FROM playlist_download_jobs WHERE playlist_type = ?",
        )
        .all(playlist.id),
      [{ track_name: "New Song", release_mbid: releaseMbid, track_number: 3, disc_number: 2 }],
    );
    const completed = info.mock.calls.find((call) => call[1] === "Playlist import sync completed");
    assert.partialDeepStrictEqual(completed?.[2], {
      playlistId: playlist.id,
      playlistTrackCount: 1,
      tracksAdded: 1,
      tracksRemoved: 1,
    });
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("YouTube Music sync uses the shared import path without logging its external ID", async () => {
  const originalStart = downloadWorker.start;
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  const getPlaylist = vi
    .spyOn(youtubeMusicPlaylistClient, "getPlaylist")
    .mockImplementation(async () => ({
      id: "PLsecretUnlisted_123",
      name: "Source title",
      tracks: [
        playlistTrack({ artistName: "New Artist", trackName: "New Song", durationMs: 180_000 }),
      ],
      stats: { sourceItems: 1, unavailable: 0, podcast: 0, incomplete: 0, duplicate: 0 },
      excluded: [],
    }));
  downloadWorker.start = async () => {};
  try {
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "YouTube Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "youtube-music-playlist",
        externalId: "PLsecretUnlisted_123",
        externalName: "Source title",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });

    const result = await syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.equal(getPlaylist.mock.calls.length, 1);
    assert.deepEqual(getPlaylist.mock.calls[0], ["PLsecretUnlisted_123", { forceRefresh: true }]);
    assert.equal(result.trackCount, 1);
    assert.equal(
      requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks[0].trackName,
      "New Song",
    );
    assert.equal(JSON.stringify(info.mock.calls).includes("PLsecretUnlisted_123"), false);
  } finally {
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("Spotify sync logs replacement tracks and excluded entries separately from download jobs", async () => {
  const originalStart = downloadWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  downloadWorker.start = async () => {};
  try {
    const keep = { artistName: "Artist", trackName: "Keep", albumName: "Album" };
    const removed = { artistName: "Artist", trackName: "Removed", albumName: "Album" };
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Spotify Replacement",
      ownerUserId: 7,
      tracks: [keep, removed],
      importSource: {
        provider: "spotify-playlist",
        externalId: "replacement-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    spotifyClient.listPlaylistTracks = async () => [
      {
        item: {
          type: "track",
          name: "Keep",
          artists: [{ name: "Artist" }],
          album: { name: "Album" },
        },
      },
      {
        item: {
          type: "track",
          name: "New",
          artists: [{ name: "Artist" }],
          album: { name: "Album" },
        },
      },
      { item: null },
    ];

    const result = await syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.equal(result.trackCount, 2);
    assert.equal(result.tracksQueued, 2);
    assert.equal(requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).trackCount, 2);
    const completed = info.mock.calls.find((call) => call[1] === "Playlist import sync completed");
    assert.partialDeepStrictEqual(completed?.[2], {
      previousTrackCount: 2,
      sourceEntryCount: 3,
      acceptedTrackCount: 2,
      playlistTrackCount: 2,
      tracksAdded: 1,
      tracksRemoved: 1,
      acceptedNotStoredCount: 0,
      sourceSkipped: { unavailable: 1 },
    });
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("Spotify sync identifies source tracks dropped before playlist storage", async () => {
  const originalStart = downloadWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const { addDiscoveryFeedback } = await import("../../backend/services/discovery/feedback.ts");
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  downloadWorker.start = async () => {};
  try {
    addDiscoveryFeedback("7", { artistName: "Blocked Artist", action: "block_artist" });
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Filtered Spotify Import",
      ownerUserId: 7,
      tracks: [],
      importSource: {
        provider: "spotify-playlist",
        externalId: "filtered-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    spotifyClient.listPlaylistTracks = async () => [
      { item: { type: "track", name: "Excluded", artists: [{ name: "Blocked Artist" }] } },
      { item: { type: "track", name: "Included", artists: [{ name: "Allowed Artist" }] } },
    ];

    const result = await syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.equal(result.trackCount, 2);
    const completed = info.mock.calls.find((call) => call[1] === "Playlist import sync completed");
    assert.partialDeepStrictEqual(completed?.[2], {
      sourceEntryCount: 2,
      acceptedTrackCount: 2,
      acceptedNotStoredCount: 1,
      playlistTrackCount: 1,
    });
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("failed import sync logs the reason and preserves it on the playlist", async () => {
  const originalGetGeneratedPlaylistTracks = listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
  const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Unavailable Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "listenbrainz-createdfor",
        externalId: "weekly-jams",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = async () => {
      throw new Error("ListenBrainz request timed out");
    };

    await assert.rejects(
      syncStaticPlaylistImport({ playlistId: playlist.id, user: { id: 7 }, force: true }),
      /ListenBrainz request timed out/,
    );

    const failed = errors.mock.calls.find((call) => call[1] === "Playlist import sync failed");
    assert.partialDeepStrictEqual(failed?.[2], {
      playlistId: playlist.id,
      reason: "ListenBrainz request timed out",
    });
    assert.equal(importSourceOf(playlist.id).lastSyncError, "ListenBrainz request timed out");
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
  }
});

test("Last.fm station sync refreshes the saved station and username", async () => {
  const originalStart = downloadWorker.start;
  const originalGetStationTracks = lastfmStationClient.getStationTracks;
  downloadWorker.start = async () => {};
  try {
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Last.fm Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "lastfm-station",
        externalId: "mix",
        externalUsername: "station-user",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    const requests: { userId: number | undefined; station: unknown; username: unknown }[] = [];
    lastfmStationClient.getStationTracks = async (userId, station, username) => {
      requests.push({ userId, station, username });
      return {
        tracks: [playlistTrack({ artistName: "New Artist", trackName: "New Song" })],
        stats: { incomplete: 0, duplicate: 0 },
        user: "station-user",
      };
    };

    await syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.deepEqual(requests, [{ userId: 7, station: "mix", username: "station-user" }]);
    assert.deepEqual(
      requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks.map(
        ({ artistName, trackName }) => ({
          artistName,
          trackName,
        }),
      ),
      [{ artistName: "New Artist", trackName: "New Song" }],
    );
    assert.equal(importSourceOf(playlist.id).externalUsername, "station-user");
  } finally {
    lastfmStationClient.getStationTracks = originalGetStationTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("Spotify sync keeps a retention change made while Spotify is pending", async () => {
  const originalStart = downloadWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  downloadWorker.start = async () => {};
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Pending Retention",
      ownerUserId: 7,
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "pending-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    await fs.mkdir(downloadRoot, { recursive: true });
    const finalPath = path.join(downloadRoot, "pending-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    assert.ok(jobId != null);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    let resolveSpotifyTracks!: (value: never[]) => void;
    spotifyClient.listPlaylistTracks = () =>
      new Promise<never[]>((resolve) => {
        resolveSpotifyTracks = resolve;
      });
    const syncPromise = syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: false,
      },
    });
    resolveSpotifyTracks([]);
    await syncPromise;

    const updated = flowPlaylistConfig.getStaticPlaylist(playlist.id);
    assert.ok(updated != null);
    assert.equal(updated.importSource?.keepRemovedTracks, false);
    assert.equal(updated.tracks.length, 0);
    await assert.rejects(fs.access(finalPath));
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("Spotify cleanup serializes retention updates with file removal", async () => {
  const originalStart = downloadWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const originalRm = fs.rm;
  let resolveRemovalStarted!: () => void;
  let releaseRemoval!: () => void;
  const removalStarted = new Promise<void>((resolve) => {
    resolveRemovalStarted = resolve;
  });
  const removalBlocked = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  downloadWorker.start = async () => {};
  try {
    const track = {
      artistName: "A",
      trackName: "Cleanup",
      albumName: "Album",
    };
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Serialized Retention",
      ownerUserId: 7,
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "serialized-id",
        syncEnabled: true,
        syncIntervalHours: 24,
        keepRemovedTracks: false,
      },
    });
    await fs.mkdir(downloadRoot, { recursive: true });
    const finalPath = path.join(downloadRoot, "serialized-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    assert.ok(jobId != null);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    spotifyClient.listPlaylistTracks = async () => [];
    fs.rm = async (...args) => {
      resolveRemovalStarted();
      await removalBlocked;
      return originalRm(...args);
    };
    const syncPromise = syncStaticPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await removalStarted;

    let retentionUpdated = false;
    const retentionPromise = updateStaticPlaylist({
      playlistId: playlist.id,
      hasImportSourceUpdate: true,
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: true,
      },
    }).then(() => {
      retentionUpdated = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retentionUpdated, false);

    releaseRemoval();
    await syncPromise;
    await retentionPromise;
    assert.equal(importSourceOf(playlist.id).keepRemovedTracks, true);
    await assert.rejects(fs.access(finalPath));
  } finally {
    fs.rm = originalRm;
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    downloadWorker.start = originalStart;
    downloadWorker.stop();
  }
});

test("Spotify status asks the owner to reconnect only when synced imports lost their connection", async () => {
  const { spotifyConnectionStore } =
    await import("../../backend/services/spotify/spotifyConnectionStore.ts");
  const statusFor = async (userId: number) =>
    (await requestAs(userId, "/import/spotify/status")).body;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Synced Spotify Mix",
    ownerUserId: 41,
    tracks: [],
    importSource: {
      provider: "spotify-playlist",
      externalId: "spotify-mix",
      syncEnabled: true,
      syncIntervalHours: 24,
    },
  });
  try {
    assert.equal((await statusFor(41)).reconnectRequired, true);
    assert.equal((await statusFor(42)).reconnectRequired, false);

    spotifyConnectionStore.saveConnection(41, { accessToken: "access", refreshToken: "refresh" });
    const reconnected = await statusFor(41);
    assert.deepEqual([reconnected.connected, reconnected.reconnectRequired], [true, false]);
  } finally {
    spotifyConnectionStore.clearConnection(41);
    flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  }
});
