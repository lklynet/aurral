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
);

const { downloadTracker } = trackerModule;
const {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
  rebuildSharedPlaylistTracksFromJobs,
} = playlistConfigModule;
const { appendSharedPlaylistTracks, processWeeklyFlowOperation } = operationsModule;
const { weeklyFlowWorker } = workerModule;
const { playlistSource } = playlistSourceModule;
const { playlistManager } = playlistManagerModule;

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
  const refreshed = [];
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
      refreshed.push(playlistId);
    };

    await processWeeklyFlowOperation({
      kind: "manual-start-flow",
      flowId: flow.id,
    });

    assert.deepEqual(refreshed, [flow.id]);
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.refreshPlaylist = originalRefresh;
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
