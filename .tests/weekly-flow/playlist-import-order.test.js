import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  trackerModule,
  playlistConfigModule,
  operationsModule,
  workerModule,
  playlistSourceModule,
  playlistManagerModule,
  spotifyClientModule,
  importSyncModule,
  importPlaylistModule,
  operationQueueModule,
  loggerModule,
  listenbrainzPlaylistsModule,
  lastfmStationsModule,
] = await setupIsolatedBackend(
  "playlist-import-order",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistSource.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/spotify/spotifyClient.js",
  "backend/services/importLists/importListSync.js",
  "backend/services/importLists/importPlaylist.js",
  "backend/services/weeklyFlow/weeklyFlowOperationQueue.js",
  "backend/services/logger.js",
  "backend/services/importLists/listenbrainzPlaylists.js",
  "backend/services/importLists/lastfmStations.js",
);

const { downloadTracker } = trackerModule;
const {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
  rebuildSharedPlaylistTracksFromJobs,
} = playlistConfigModule;
const {
  appendSharedPlaylistTracks,
  markLatestWeeklyFlowOperationToken,
  processWeeklyFlowOperation,
  updateSharedPlaylist,
} = operationsModule;
const { weeklyFlowWorker } = workerModule;
const { playlistSource } = playlistSourceModule;
const { playlistManager } = playlistManagerModule;
const { spotifyClient } = spotifyClientModule;
const { listenbrainzPlaylistClient } = listenbrainzPlaylistsModule;
const { lastfmStationClient } = lastfmStationsModule;
const { syncSharedPlaylistImport } = importSyncModule;
const { enqueueImportedPlaylist } = importPlaylistModule;
const { weeklyFlowOperationQueue } = operationQueueModule;
const { logger } = loggerModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

test("import sync delegates to the flow owner without blocking the web event loop", async () => {
  const { configureFlowOwnerClient } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowOwnerClient.js",
  );
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestServer = process.env.AURRAL_TEST_SERVER;
  let resolveWorker;
  let request;
  const workerResult = new Promise((resolve) => { resolveWorker = resolve; });
  configureFlowOwnerClient({
    request: (method, args, options) => {
      request = { method, args, options };
      return workerResult;
    },
    getStatus: () => null,
  });
  process.env.NODE_ENV = "production";
  delete process.env.AURRAL_TEST_SERVER;
  try {
    const sync = syncSharedPlaylistImport({
      playlistId: "playlist-id",
      user: { id: 7, role: "admin", token: "not-for-worker" },
      force: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(request.method, "syncSharedPlaylistImport");
    assert.deepEqual(request.args, [{
      playlistId: "playlist-id", user: { id: 7, role: "admin" }, force: true,
    }]);
    assert.equal(request.options.timeoutMs, 5 * 60 * 1000);
    resolveWorker({ ok: true, result: { trackCount: 1001, tracksQueued: 1 } });
    assert.deepEqual(await sync, { trackCount: 1001, tracksQueued: 1 });

    configureFlowOwnerClient({
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
      syncSharedPlaylistImport({ playlistId: "playlist-id", user: { id: 7 }, force: true }),
      (error) => error.code === "SPOTIFY_AUTH_REQUIRED" && error.statusCode === 401,
    );
  } finally {
    configureFlowOwnerClient({ request: null, getStatus: () => null });
    process.env.NODE_ENV = originalNodeEnv;
    if (originalTestServer === undefined) delete process.env.AURRAL_TEST_SERVER;
    else process.env.AURRAL_TEST_SERVER = originalTestServer;
  }
});

test("mutation release unblocks every playlist and prunes after an unblock error", async (t) => {
  const { beginPlaylistMutation } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowMutationGuards.js",
  );
  const calls = [];
  t.mock.method(weeklyFlowWorker, "blockPlaylist", async () => true);
  t.mock.method(weeklyFlowWorker, "clearIncompleteRetry", async () => {});
  t.mock.method(weeklyFlowWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(weeklyFlowWorker, "unblockPlaylist", async (id) => {
    calls.push(`unblock:${id}`);
    if (id === "first") throw new Error("unblock failed");
  });
  t.mock.method(weeklyFlowWorker, "pruneOrphanedJobState", async () => {
    calls.push("prune");
  });

  const release = await beginPlaylistMutation(["first", "second"], { clearPending: false });
  await assert.rejects(release(), /unblock failed/);
  assert.deepEqual(calls, ["unblock:first", "unblock:second", "prune"]);
});

test("flow settings locks serialize with playlist mutations", async () => {
  const { withPlaylistMutation, withPlaylistMutationLock } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowMutationGuards.js",
  );
  let signalMutationEntered;
  let releaseMutation;
  const mutationEntered = new Promise((resolve) => { signalMutationEntered = resolve; });
  const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
  let updateEntered = false;
  let update;
  const mutation = withPlaylistMutation("flow-settings-lock", async () => {
    signalMutationEntered();
    await mutationGate;
  }, { clearPending: false });

  try {
    await mutationEntered;
    update = withPlaylistMutationLock("flow-settings-lock", async () => {
      updateEntered = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updateEntered, false);
    releaseMutation();
    await Promise.all([mutation, update]);
    assert.equal(updateEntered, true);
  } finally {
    releaseMutation();
    await Promise.allSettled([mutation, update].filter(Boolean));
  }
});

async function writeReusableTrack(track, playlistType = "source-playlist") {
  const sourcePath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    playlistType,
    track.artistName,
    track.albumName || "Unknown Album",
    `${track.trackName}.flac`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const jobId = downloadTracker.addJob(track, playlistType);
  downloadTracker.setDone(jobId, sourcePath, track.albumName);
  return { jobId, sourcePath };
}

test.beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
    playlistArtwork: { style: "aurral" },
  });
  downloadTracker.clearAll();
  weeklyFlowWorker.stop();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test("import enqueue logs a queued operation without claiming completion", async (t) => {
  const messages = [];
  const enqueue = t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async () => ({
    queued: true,
    operationId: 42,
  }));
  t.mock.method(logger, "info", (_category, message, details) => {
    messages.push({ message, details });
  });

  const result = await enqueueImportedPlaylist({
    ownerUserId: 7,
    name: "Imported Mix",
    provider: "spotify-playlist",
    externalId: "external-playlist",
    tracks: [{ artistName: "Artist", trackName: "Song" }],
    sourceStats: { unavailable: 2, podcast: 1, incomplete: 0, duplicate: 0 },
    syncEnabled: false,
  });

  assert.equal(enqueue.mock.callCount(), 1);
  assert.equal(result.queued, true);
  assert.deepEqual(messages.map((entry) => entry.message), ["Playlist import queued"]);
  assert.equal(messages[0].details.provider, "spotify-playlist");
  assert.equal(messages[0].details.playlistName, "Imported Mix");
  assert.equal(messages[0].details.operationId, 42);
  assert.equal(messages[0].details.trackCount, 1);
  assert.equal(messages[0].details.skipped.unavailable, 2);
  assert.ok(messages[0].details.playlistId);
  assert.equal(JSON.stringify(messages).includes("external-playlist"), false);
});

const waitForImportLog = async (mock, message) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const call = mock.mock.calls.find((entry) => entry.arguments[1] === message);
    if (call) return call.arguments[2];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
};

test("background import logs completion only after the playlist exists", async (t) => {
  const info = t.mock.method(logger, "info", () => {});
  const { stopWeeklyFlowOperationWorker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowOperationWorker.js",
  );
  try {
    await enqueueImportedPlaylist({
      ownerUserId: 7,
      name: "Completed Import",
      provider: "spotify-playlist",
      externalId: "external-playlist",
      tracks: [],
      syncEnabled: false,
    });
    const completed = await waitForImportLog(info, "Playlist import job completed");
    const started = info.mock.calls.find((call) =>
      call.arguments[1] === "Playlist import job started");
    assert.ok(started);
    assert.equal(started.arguments[2].operationId, completed.operationId);
    assert.equal(completed.provider, "spotify-playlist");
    assert.equal(completed.playlistName, "Completed Import");
    assert.ok(flowPlaylistConfig.getSharedPlaylist(completed.playlistId));
    assert.ok(completed.operationId);
    assert.equal(completed.trackCount, 0);
  } finally {
    await stopWeeklyFlowOperationWorker();
  }
});

test("background import logs a permanent failure with its reason", async (t) => {
  const errors = t.mock.method(logger, "error", () => {});
  const { stopWeeklyFlowOperationWorker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowOperationWorker.js",
  );
  flowPlaylistConfig.createSharedPlaylist({
    name: "Duplicate Import",
    ownerUserId: 7,
    tracks: [],
  });
  try {
    await enqueueImportedPlaylist({
      ownerUserId: 7,
      name: "Duplicate Import",
      provider: "listenbrainz-playlist",
      externalId: "external-playlist",
      tracks: [],
      syncEnabled: false,
    });
    const failed = await waitForImportLog(errors, "Playlist import failed");
    assert.equal(failed.provider, "listenbrainz-playlist");
    assert.match(failed.reason, /already exists/i);
    assert.ok(failed.operationId);
  } finally {
    await stopWeeklyFlowOperationWorker();
  }
});

test("external import routes log fetch failures with the provider reason", async (t) => {
  const [spotifyRoutes, listenbrainzRoutes, lastfmRoutes] = await Promise.all([
    importFromRepo("backend/routes/weeklyFlow/handlers/spotifyImport.js"),
    importFromRepo("backend/routes/weeklyFlow/handlers/listenbrainzImport.js"),
    importFromRepo("backend/routes/weeklyFlow/handlers/lastfmImport.js"),
  ]);
  const handlers = new Map();
  const router = {
    get() {},
    delete() {},
    post(route, handler) { handlers.set(route, handler); },
  };
  spotifyRoutes.registerSpotifyImport(router);
  listenbrainzRoutes.registerListenBrainzImport(router);
  lastfmRoutes.registerLastfmImport(router);
  const failures = t.mock.method(logger, "error", () => {});
  const providers = [
    ["/import/spotify", spotifyClient, "listPlaylistTracks", "Spotify timed out"],
    ["/import/listenbrainz", listenbrainzPlaylistClient, "getPlaylistTracks", "ListenBrainz timed out"],
    ["/import/lastfm", lastfmStationClient, "getStationTracks", "Last.fm timed out"],
  ];

  for (const [route, client, method, reason] of providers) {
    t.mock.method(client, method, async () => { throw new Error(reason); });
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handlers.get(route)({
      user: { id: 7 },
      body: { playlistId: "external-playlist", name: "Test Mix", username: "listener" },
    }, response);
    assert.equal(response.statusCode, 500);
    const logged = failures.mock.calls.at(-1);
    assert.equal(logged?.arguments[2]?.playlistName, "Test Mix");
    assert.equal(logged?.arguments[2]?.stage, "fetch");
    assert.equal(logged?.arguments[2]?.reason, reason);
  }
});

test.after(async () => {
  weeklyFlowWorker.stop();
  await cleanupIsolatedState(isolatedState);
});

test("orderJobsBySharedPlaylistTracks follows config order over createdAt", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
  ];
  const jobs = [
    { id: 2, createdAt: 20, ...tracks[1] },
    { id: 3, createdAt: 30, ...tracks[2] },
    { id: 1, createdAt: 10, ...tracks[0] },
  ];
  const ordered = orderJobsBySharedPlaylistTracks(jobs, tracks);
  assert.deepEqual(
    ordered.map((job) => job.id),
    [1, 2, 3],
  );
});

test("rebuildSharedPlaylistTracksFromJobs keeps remaining config order", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
    { artistName: "D", trackName: "Four", albumName: "Album" },
  ];
  const jobs = [
    { id: 10, createdAt: 40, ...tracks[3] },
    { id: 11, createdAt: 10, ...tracks[0] },
    { id: 12, createdAt: 30, ...tracks[2] },
  ];
  const remaining = rebuildSharedPlaylistTracksFromJobs(tracks, jobs);
  assert.deepEqual(
    remaining.map((track) => track.trackName),
    ["One", "Three", "Four"],
  );
});

test("mixed reuse seeding keeps import job order", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
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

    const playlist = flowPlaylistConfig.createSharedPlaylist({
      name: "Import Order",
      tracks: [],
    });
    const imported = [reusableA, missingB, reusableC, missingD];
    const result = await appendSharedPlaylistTracks({
      playlistId: playlist.id,
      tracks: imported,
    });

    assert.equal(result.tracksReused, 2);
    assert.equal(result.tracksQueued, 2);

    const jobs = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks,
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
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("flow refresh clears playback before downloads finish", async () => {
  const originalBuildPlan = playlistSource.buildFlowRunPlan;
  const originalRefresh = playlistManager.refreshPlaylist;
  const originalScheduleNextRun = flowPlaylistConfig.scheduleNextRun;
  const events = [];
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
    playlistSource.buildFlowRunPlan = async () => ({
      primaryTracks: [],
      reserveTracks: [],
      diagnostics: { targets: { primary: 0 }, achieved: { primary: 0, reserve: 0 } },
    });
    playlistManager.refreshPlaylist = async (playlistId) => {
      await new Promise((resolve) => setImmediate(resolve));
      events.push(["refresh", playlistId]);
    };
    flowPlaylistConfig.scheduleNextRun = (playlistId) => {
      events.push(["schedule", playlistId]);
    };

    await processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(events, [
      ["refresh", flow.id],
      ["schedule", flow.id],
    ]);
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.refreshPlaylist = originalRefresh;
    flowPlaylistConfig.scheduleNextRun = originalScheduleNextRun;
    weeklyFlowWorker.stop();
  }
});

test("a failed flow plan leaves the current playlist and jobs untouched", async () => {
  const originalBuildPlan = playlistSource.buildFlowRunPlan;
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
    playlistSource.buildFlowRunPlan = async () => { throw new Error("Planning unavailable"); };
    playlistManager.weeklyReset = async () => { resets += 1; };

    await assert.rejects(
      processWeeklyFlowOperation({ kind: "scheduled-flow-refresh", flowId: flow.id }),
      /Planning unavailable/,
    );
    assert.equal(resets, 0);
    assert.ok(downloadTracker.getJob(jobId));
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.weeklyReset = originalReset;
    weeklyFlowWorker.stop();
  }
});

test("a stale flow plan does not cancel jobs when settings change during planning", async () => {
  const originalBuildPlan = playlistSource.buildFlowRunPlan;
  let signalPlanning;
  let resolvePlan;
  const planningStarted = new Promise((resolve) => { signalPlanning = resolve; });
  const deferredPlan = new Promise((resolve) => { resolvePlan = resolve; });
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
    const { getPlaylistDownloadGeneration, isDownloadJobCancelled } = await importFromRepo(
      "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
    );
    const generationBeforePlanning = getPlaylistDownloadGeneration(flow.id);
    playlistSource.buildFlowRunPlan = async () => {
      signalPlanning();
      return deferredPlan;
    };

    const refresh = processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });
    await planningStarted;
    flowPlaylistConfig.updateFlow(flow.id, { name: "Changed During Planning" });
    resolvePlan({
      primaryTracks: [],
      reserveTracks: [],
      diagnostics: { targets: { primary: 0 }, achieved: { primary: 0, reserve: 0 } },
    });

    await assert.rejects(refresh, /Flow settings changed while planning/);
    assert.equal(isDownloadJobCancelled(jobId), false);
    assert.equal(getPlaylistDownloadGeneration(flow.id), generationBeforePlanning);
    assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildPlan;
    weeklyFlowWorker.stop();
  }
});

test("flow operation tokens are stored separately for each playlist", () => {
  markLatestWeeklyFlowOperationToken("flow:one", "first");
  markLatestWeeklyFlowOperationToken("flow:two", "second");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Aone"), "first");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Atwo"), "second");
});

test("deleting a track keeps remaining import order in config", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const tracks = [
      { artistName: "A", trackName: "One", albumName: "Album" },
      { artistName: "B", trackName: "Two", albumName: "Album" },
      { artistName: "C", trackName: "Three", albumName: "Album" },
      { artistName: "D", trackName: "Four", albumName: "Album" },
    ];
    await writeReusableTrack(tracks[0]);
    await writeReusableTrack(tracks[2]);

    const playlist = flowPlaylistConfig.createSharedPlaylist({
      name: "Delete Order",
      tracks: [],
    });
    await appendSharedPlaylistTracks({
      playlistId: playlist.id,
      tracks,
    });

    const jobsBefore = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks,
    );
    const removedJobId = jobsBefore[1].id;

    const deleted = await processWeeklyFlowOperation({
      kind: "shared-playlist-delete-track",
      playlistId: playlist.id,
      jobId: removedJobId,
    });
    assert.equal(deleted.success, true);

    const updated = flowPlaylistConfig.getSharedPlaylist(playlist.id);
    assert.deepEqual(
      updated.tracks.map((track) => track.trackName),
      ["One", "Three", "Four"],
    );

    const jobsAfter = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      updated.tracks,
    );
    assert.deepEqual(
      jobsAfter.map((job) => job.trackName),
      ["One", "Three", "Four"],
    );
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("replacing a shared playlist removes Spotify tracks and honors file retention", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const keepPlaylist = flowPlaylistConfig.createSharedPlaylist({
      name: "Keep Removed",
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "keep-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const keepPath = path.join(weeklyFlowRoot, "keep-removed.flac");
    await fs.writeFile(keepPath, "audio");
    const keepJobId = downloadTracker.addJob(track, keepPlaylist.id);
    downloadTracker.setDone(keepJobId, keepPath, track.albumName);

    await updateSharedPlaylist({
      playlistId: keepPlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: keepPlaylist.importSource,
    });
    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(keepPlaylist.id).tracks, []);
    await fs.access(keepPath);

    const deletePlaylist = flowPlaylistConfig.createSharedPlaylist({
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
    const deletePath = path.join(weeklyFlowRoot, "delete-removed.flac");
    await fs.writeFile(deletePath, "audio");
    const deleteJobId = downloadTracker.addJob(track, deletePlaylist.id);
    downloadTracker.setDone(deleteJobId, deletePath, track.albumName);

    await updateSharedPlaylist({
      playlistId: deletePlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: deletePlaylist.importSource,
      deleteUnsharedFiles: true,
    });
    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(deletePlaylist.id).tracks, []);
    await assert.rejects(fs.access(deletePath));
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("imported playlist sync preserves enriched jobs while replacing removed tracks", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const pending = {
      artistName: "Artist", trackName: "Pending", albumName: "Album",
      artistMbid: "11111111-1111-1111-1111-111111111111",
    };
    const completed = {
      artistName: "Artist", trackName: "Completed", albumName: "Album",
      albumMbid: "22222222-2222-2222-2222-222222222222",
    };
    const removed = { artistName: "Artist", trackName: "Removed", albumName: "Album" };
    const playlist = flowPlaylistConfig.createSharedPlaylist({
      name: "Imported Job Retention",
      ownerUserId: 7,
      tracks: [pending, completed, removed],
      importSource: {
        provider: "spotify-playlist",
        externalId: "imported-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    const pendingJobId = downloadTracker.addJob(pending, playlist.id);
    const completedJobId = downloadTracker.addJob(completed, playlist.id);
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const completedPath = path.join(weeklyFlowRoot, "imported-retained-completed.flac");
    await fs.writeFile(completedPath, "audio");
    downloadTracker.setDone(completedJobId, completedPath, completed.albumName);
    const removedJobId = downloadTracker.addJob(removed, playlist.id);

    const result = await updateSharedPlaylist({
      playlistId: playlist.id,
      tracks: [
        { artistName: "Artist", trackName: "Pending", albumName: "Album" },
        { artistName: "Artist", trackName: "Completed", albumName: "Album" },
        { artistName: "Artist", trackName: "New", albumName: "Album" },
      ],
      hasTracksUpdate: true,
      mergeImportSource: true,
    });

    assert.equal(result.tracksQueued, 1);
    assert.ok(downloadTracker.getJob(pendingJobId));
    assert.equal(downloadTracker.getJob(completedJobId)?.status, "done");
    await fs.access(completedPath);
    assert.equal(downloadTracker.getJob(removedJobId), null);
    assert.ok(downloadTracker.getByPlaylistType(playlist.id).some((job) => job.trackName === "New"));
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("ListenBrainz sync uses the shared import update path", async (t) => {
  const originalStart = weeklyFlowWorker.start;
  const originalGetGeneratedPlaylistTracks =
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
  const info = t.mock.method(logger, "info", () => {});
  weeklyFlowWorker.start = async () => false;
  try {
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = async () => ({
      tracks: [{ artistName: "New Artist", trackName: "New Song" }],
      stats: { incomplete: 0, duplicate: 0 },
    });

    await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks, [
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
      },
    ]);
    const completed = info.mock.calls.find((call) =>
      call.arguments[1] === "Playlist import sync completed");
    assert.equal(completed?.arguments[2]?.playlistId, playlist.id);
    assert.equal(completed?.arguments[2]?.playlistTrackCount, 1);
    assert.equal(completed?.arguments[2]?.tracksAdded, 1);
    assert.equal(completed?.arguments[2]?.tracksRemoved, 1);
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify sync logs replacement tracks and excluded entries separately from download jobs", async (t) => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const info = t.mock.method(logger, "info", () => {});
  weeklyFlowWorker.start = async () => false;
  try {
    const keep = { artistName: "Artist", trackName: "Keep", albumName: "Album" };
    const removed = { artistName: "Artist", trackName: "Removed", albumName: "Album" };
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
      { track: { name: "Keep", artists: [{ name: "Artist" }], album: { name: "Album" } } },
      { track: { name: "New", artists: [{ name: "Artist" }], album: { name: "Album" } } },
      { track: null },
    ];

    const result = await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.equal(result.trackCount, 2);
    assert.equal(result.tracksQueued, 2);
    assert.equal(flowPlaylistConfig.getSharedPlaylist(playlist.id).trackCount, 2);
    const completed = info.mock.calls.find((call) =>
      call.arguments[1] === "Playlist import sync completed");
    assert.equal(completed?.arguments[2]?.previousTrackCount, 2);
    assert.equal(completed?.arguments[2]?.sourceEntryCount, 3);
    assert.equal(completed?.arguments[2]?.acceptedTrackCount, 2);
    assert.equal(completed?.arguments[2]?.playlistTrackCount, 2);
    assert.equal(completed?.arguments[2]?.tracksAdded, 1);
    assert.equal(completed?.arguments[2]?.tracksRemoved, 1);
    assert.equal(completed?.arguments[2]?.acceptedNotStoredCount, 0);
    assert.equal(completed?.arguments[2]?.sourceSkipped.unavailable, 1);
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify sync identifies source tracks dropped before playlist storage", async (t) => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const { addDiscoveryFeedback } = await importFromRepo(
    "backend/services/discovery/feedback.js",
  );
  const info = t.mock.method(logger, "info", () => {});
  weeklyFlowWorker.start = async () => false;
  try {
    addDiscoveryFeedback("7", { artistName: "Blocked Artist", action: "block_artist" });
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
      { track: { name: "Excluded", artists: [{ name: "Blocked Artist" }] } },
      { track: { name: "Included", artists: [{ name: "Allowed Artist" }] } },
    ];

    const result = await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.equal(result.trackCount, 2);
    const completed = info.mock.calls.find((call) =>
      call.arguments[1] === "Playlist import sync completed");
    assert.equal(completed?.arguments[2]?.sourceEntryCount, 2);
    assert.equal(completed?.arguments[2]?.acceptedTrackCount, 2);
    assert.equal(completed?.arguments[2]?.acceptedNotStoredCount, 1);
    assert.equal(completed?.arguments[2]?.playlistTrackCount, 1);
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("failed import sync logs the reason and preserves it on the playlist", async (t) => {
  const originalGetGeneratedPlaylistTracks =
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
  const errors = t.mock.method(logger, "error", () => {});
  try {
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
      syncSharedPlaylistImport({ playlistId: playlist.id, user: { id: 7 }, force: true }),
      /ListenBrainz request timed out/,
    );

    const failed = errors.mock.calls.find((call) =>
      call.arguments[1] === "Playlist import sync failed");
    assert.equal(failed?.arguments[2]?.playlistId, playlist.id);
    assert.equal(failed?.arguments[2]?.reason, "ListenBrainz request timed out");
    assert.equal(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).importSource.lastSyncError,
      "ListenBrainz request timed out",
    );
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
  }
});

test("Last.fm station sync refreshes the saved station and username", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalGetStationTracks = lastfmStationClient.getStationTracks;
  weeklyFlowWorker.start = async () => false;
  try {
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
    let requested;
    lastfmStationClient.getStationTracks = async (userId, station, username) => {
      requested = { userId, station, username };
      return {
        tracks: [{ artistName: "New Artist", trackName: "New Song" }],
        stats: { incomplete: 0, duplicate: 0 },
      };
    };

    await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.deepEqual(requested, {
      userId: 7,
      station: "mix",
      username: "station-user",
    });
    assert.deepEqual(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks.map(({ artistName, trackName }) => ({
        artistName,
        trackName,
      })),
      [{ artistName: "New Artist", trackName: "New Song" }],
    );
    assert.equal(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).importSource.externalUsername,
      "station-user",
    );
  } finally {
    lastfmStationClient.getStationTracks = originalGetStationTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify sync keeps a retention change made while Spotify is pending", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const finalPath = path.join(weeklyFlowRoot, "pending-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    let resolveSpotifyTracks;
    spotifyClient.listPlaylistTracks = () =>
      new Promise((resolve) => {
        resolveSpotifyTracks = resolve;
      });
    const syncPromise = syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: false,
      },
    });
    resolveSpotifyTracks([]);
    await syncPromise;

    const updated = flowPlaylistConfig.getSharedPlaylist(playlist.id);
    assert.equal(updated.importSource.keepRemovedTracks, false);
    assert.equal(updated.tracks.length, 0);
    await assert.rejects(fs.access(finalPath));
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify cleanup serializes retention updates with file removal", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const originalRm = fs.rm;
  let resolveRemovalStarted;
  let releaseRemoval;
  const removalStarted = new Promise((resolve) => {
    resolveRemovalStarted = resolve;
  });
  const removalBlocked = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Cleanup",
      albumName: "Album",
    };
    const playlist = flowPlaylistConfig.createSharedPlaylist({
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
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const finalPath = path.join(weeklyFlowRoot, "serialized-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    spotifyClient.listPlaylistTracks = async () => [];
    fs.rm = async (...args) => {
      resolveRemovalStarted();
      await removalBlocked;
      return originalRm(...args);
    };
    const syncPromise = syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await removalStarted;

    let retentionUpdated = false;
    const retentionPromise = updateSharedPlaylist({
      playlistId: playlist.id,
      hasImportSourceUpdate: true,
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: true,
      },
    }).then(() => {
      retentionUpdated = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retentionUpdated, false);

    releaseRemoval();
    await syncPromise;
    await retentionPromise;
    assert.equal(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).importSource.keepRemovedTracks,
      true,
    );
    await assert.rejects(fs.access(finalPath));
  } finally {
    fs.rm = originalRm;
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});
