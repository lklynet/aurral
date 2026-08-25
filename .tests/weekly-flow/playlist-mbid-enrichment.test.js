import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { getPlaylistMbidEnrichmentQueue },
  {
    enrichSharedPlaylistMbids,
    schedulePlaylistMbidEnrichmentForMissingPlaylists,
  },
] = await setupIsolatedBackend(
  "playlist-mbid-enrichment",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/honkerDb.js",
  "backend/services/playlistMbidEnrichmentService.js",
);

test.beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("enrichSharedPlaylistMbids fills missing playlist and job MBIDs", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Imported",
    tracks: [
      {
        artistName: "Refused",
        trackName: "New Noise",
      },
    ],
  });
  const jobId = downloadTracker.addJob(
    {
      artistName: "Refused",
      trackName: "New Noise",
    },
    playlist.id,
  );

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      albumName: "The Shape of Punk to Come",
      artistMbid: "artist-refused",
      albumMbid: "album-shape",
      trackMbid: "track-new-noise",
      releaseYear: "1998",
      durationMs: 308000,
      artistAliases: ["Refused SE"],
      trackNumber: 1,
      albumTrackCount: 12,
      albumTrackTitles: ["Worms of the Senses", "New Noise"],
    }),
  });

  const storedTrack =
    flowPlaylistConfig.getSharedPlaylist(playlist.id)?.tracks?.[0];
  const storedJob = downloadTracker.getJob(jobId);

  assert.equal(result.changed, true);
  assert.equal(result.playlistTracksUpdated, 1);
  assert.equal(result.jobsUpdated, 1);
  assert.equal(storedTrack.artistMbid, "artist-refused");
  assert.equal(storedTrack.albumMbid, "album-shape");
  assert.equal(storedTrack.trackMbid, "track-new-noise");
  assert.equal(storedTrack.albumName, "The Shape of Punk to Come");
  assert.equal(storedJob.artistMbid, "artist-refused");
  assert.equal(storedJob.albumMbid, "album-shape");
  assert.equal(storedJob.trackMbid, "track-new-noise");
  assert.equal(storedJob.trackNumber, 1);
  assert.equal(storedJob.albumTrackCount, 12);
});

test("enrichSharedPlaylistMbids rescans the library after updating a downloaded job", async (t) => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Downloaded",
    tracks: [{ artistName: "Refused", trackName: "New Noise" }],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Refused", trackName: "New Noise" },
    playlist.id,
  );
  downloadTracker.setDone(jobId, "/library/Refused/New Noise.flac");
  const scheduleScanLibrary = t.mock.method(
    playlistManager,
    "scheduleScanLibrary",
    () => 1,
  );

  await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "artist-refused",
      albumMbid: "album-shape",
      trackMbid: "track-new-noise",
    }),
  });

  assert.equal(scheduleScanLibrary.mock.callCount(), 1);
});

test("enrichSharedPlaylistMbids returns missing when playlistId is empty", async () => {
  const result = await enrichSharedPlaylistMbids("");
  assert.equal(result.missing, true);
  assert.equal(result.changed, false);
});

test("enrichSharedPlaylistMbids returns missing when playlist not found", async () => {
  const result = await enrichSharedPlaylistMbids("nonexistent-id");
  assert.equal(result.missing, true);
  assert.equal(result.changed, false);
});

test("enrichSharedPlaylistMbids handles resolveTrackContext throwing by falling back to original track", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Fragile",
    tracks: [{ artistName: "Unknown", trackName: "Ghost" }],
  });

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: () => { throw new Error("resolve failed"); },
  });

  assert.equal(result.changed, false);
  const storedTrack = flowPlaylistConfig.getSharedPlaylist(playlist.id)?.tracks?.[0];
  assert.ok(!storedTrack.artistMbid);
});

test("enrichSharedPlaylistMbids leaves already-enriched tracks unchanged", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Enriched",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "radiohead-mbid",
      trackMbid: "creep-mbid",
    }],
  });

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      albumName: "Pablo Honey",
      albumMbid: "pablo-honey-mbid",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.playlistTracksUpdated, 1);
});

test("enrichSharedPlaylistMbids does not re-resolve complete tracks", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Complete",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "radiohead-mbid",
      albumMbid: "pablo-honey-mbid",
      trackMbid: "creep-mbid",
    }],
  });
  let resolverCalls = 0;

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => {
      resolverCalls += 1;
      return track;
    },
  });

  assert.equal(resolverCalls, 0);
  assert.equal(result.changed, false);
});

test("enrichSharedPlaylistMbids can reconcile complete tracks once when explicitly requested", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Needs artist repair",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "wrong-artist-mbid",
      albumMbid: "pablo-honey-mbid",
      trackMbid: "creep-mbid",
    }],
  });

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    reconcileArtistMbids: true,
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "radiohead-mbid",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(
    flowPlaylistConfig.getSharedPlaylist(playlist.id)?.tracks?.[0]?.artistMbid,
    "radiohead-mbid",
  );
});

test("startup artist reconciliation is scheduled only once", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "One-time artist repair",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "radiohead-mbid",
      albumMbid: "pablo-honey-mbid",
      trackMbid: "creep-mbid",
    }],
  });

  const first = schedulePlaylistMbidEnrichmentForMissingPlaylists({
    reason: "startup",
    reconcileArtistMbids: true,
  });
  const second = schedulePlaylistMbidEnrichmentForMissingPlaylists({
    reason: "startup",
    reconcileArtistMbids: true,
  });

  const queue = getPlaylistMbidEnrichmentQueue();
  const getPlaylistId = (jobId) => {
    const payload = queue.getJob(jobId)?.payload;
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    return parsed?.playlistId;
  };
  assert.ok(first.some((jobId) => getPlaylistId(jobId) === playlist.id));
  assert.ok(!second.some((jobId) => getPlaylistId(jobId) === playlist.id));
  for (const jobId of [...first, ...second]) {
    queue.cancel(jobId);
  }
});
