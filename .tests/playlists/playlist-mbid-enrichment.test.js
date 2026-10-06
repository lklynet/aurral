import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { getPlaylistMbidEnrichmentQueue },
  {
    enrichStaticPlaylistMbids,
    schedulePlaylistMbidEnrichmentForMissingPlaylists,
  },
] = await setupIsolatedBackend(
  "playlist-mbid-enrichment",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js",
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
    staticPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("enrichStaticPlaylistMbids fills missing playlist and job MBIDs", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Imported",
    tracks: [
      {
        artistName: "Refused",
        trackName: "New Noise",
      },
    ],
  });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Refused", trackName: "New Noise" },
  ]);

  const result = await enrichStaticPlaylistMbids(playlist.id, {
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
    flowPlaylistConfig.getStaticPlaylist(playlist.id)?.tracks?.[0];
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

test("enrichStaticPlaylistMbids rescans the library after updating a downloaded job", async (t) => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Downloaded",
    tracks: [{ artistName: "Refused", trackName: "New Noise" }],
  });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Refused", trackName: "New Noise" },
  ]);
  downloadTracker.setDone(jobId, "/library/Refused/New Noise.flac");
  const scheduleScanLibrary = t.mock.method(
    playlistManager,
    "scheduleScanLibrary",
    () => 1,
  );

  await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "artist-refused",
      albumMbid: "album-shape",
      trackMbid: "track-new-noise",
    }),
  });

  assert.equal(scheduleScanLibrary.mock.callCount(), 1);
});

test("enrichStaticPlaylistMbids returns missing when playlistId is empty", async () => {
  const result = await enrichStaticPlaylistMbids("");
  assert.equal(result.missing, true);
  assert.equal(result.changed, false);
});

test("enrichStaticPlaylistMbids returns missing when playlist not found", async () => {
  const result = await enrichStaticPlaylistMbids("nonexistent-id");
  assert.equal(result.missing, true);
  assert.equal(result.changed, false);
});

test("enrichStaticPlaylistMbids handles resolveTrackContext throwing by falling back to original track", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Fragile",
    tracks: [{ artistName: "Unknown", trackName: "Ghost" }],
  });

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: () => { throw new Error("resolve failed"); },
  });

  assert.equal(result.changed, false);
  const storedTrack = flowPlaylistConfig.getStaticPlaylist(playlist.id)?.tracks?.[0];
  assert.ok(!storedTrack.artistMbid);
});

test("enrichStaticPlaylistMbids leaves already-enriched tracks unchanged", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Enriched",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "radiohead-mbid",
      trackMbid: "creep-mbid",
    }],
  });

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      albumName: "Pablo Honey",
      albumMbid: "pablo-honey-mbid",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.playlistTracksUpdated, 1);
});

test("enrichStaticPlaylistMbids does not re-resolve complete tracks", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => {
      resolverCalls += 1;
      return track;
    },
  });

  assert.equal(resolverCalls, 0);
  assert.equal(result.changed, false);
});

test("enrichStaticPlaylistMbids can reconcile complete tracks once when explicitly requested", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Needs artist repair",
    tracks: [{
      artistName: "Radiohead",
      trackName: "Creep",
      artistMbid: "wrong-artist-mbid",
      albumMbid: "pablo-honey-mbid",
      trackMbid: "creep-mbid",
    }],
  });

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    reconcileArtistMbids: true,
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "radiohead-mbid",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(
    flowPlaylistConfig.getStaticPlaylist(playlist.id)?.tracks?.[0]?.artistMbid,
    "radiohead-mbid",
  );
});

test("startup artist reconciliation is scheduled only once", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
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
