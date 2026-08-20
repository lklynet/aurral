import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
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
  "backend/services/importLists/listenbrainzPlaylists.js",
  "backend/services/importLists/lastfmStations.js",
);

const { downloadTracker } = trackerModule;
const {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
  rebuildSharedPlaylistTracksFromJobs,
} = playlistConfigModule;
const { appendSharedPlaylistTracks, processWeeklyFlowOperation, updateSharedPlaylist } = operationsModule;
const { weeklyFlowWorker } = workerModule;
const { playlistSource } = playlistSourceModule;
const { playlistManager } = playlistManagerModule;
const { spotifyClient } = spotifyClientModule;
const { listenbrainzPlaylistClient } = listenbrainzPlaylistsModule;
const { lastfmStationClient } = lastfmStationsModule;
const { syncSharedPlaylistImport } = importSyncModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

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
  });
  downloadTracker.clearAll();
  weeklyFlowWorker.stop();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
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

test("ListenBrainz sync uses the shared import update path", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalGetGeneratedPlaylistTracks =
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
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
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
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
