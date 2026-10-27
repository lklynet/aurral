import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { getPlaylistMbidEnrichmentQueue },
  { enrichStaticPlaylistMbids, schedulePlaylistMbidEnrichmentForMissingPlaylists },
] = await setupIsolatedBackend(
  "playlist-mbid-enrichment",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/playlistMbidEnrichmentService.ts"),
);

type Resolver = NonNullable<
  NonNullable<Parameters<typeof enrichStaticPlaylistMbids>[1]>["resolveTrackContext"]
>;
type ResolvedTrack = Awaited<ReturnType<Resolver>>;

const resolved = (
  track: Parameters<Resolver>[0],
  overrides: Partial<ResolvedTrack> = {},
): ResolvedTrack => ({
  albumName: null,
  artistMbid: null,
  albumMbid: null,
  trackMbid: null,
  releaseMbid: null,
  durationMs: null,
  ...track,
  artistName: track.artistName ?? "",
  trackName: track.trackName ?? "",
  recordingMbidAliases: track.recordingMbidAliases ?? [],
  releaseYear: track.releaseYear == null ? null : String(track.releaseYear),
  artistAliases: track.artistAliases ?? [],
  ...overrides,
});

beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterAll(async () => {
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
  const jobId = downloadTracker.addJob(
    {
      artistName: "Refused",
      trackName: "New Noise",
    },
    playlist.id,
  );

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: async (track) =>
      resolved(track, {
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

  const storedTrack = flowPlaylistConfig.getStaticPlaylist(playlist.id)?.tracks?.[0];
  assert.ok(storedTrack != null);
  const storedJob = downloadTracker.getJob(jobId);
  assert.ok(storedJob != null);

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

test("enrichStaticPlaylistMbids rescans the library after updating a downloaded job", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Downloaded",
    tracks: [{ artistName: "Refused", trackName: "New Noise" }],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Refused", trackName: "New Noise" },
    playlist.id,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, "/library/Refused/New Noise.flac");
  const scheduleScanLibrary = vi
    .spyOn(playlistManager, "scheduleScanLibrary")
    .mockImplementation(() => 1);

  await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: async (track) =>
      resolved(track, {
        artistMbid: "artist-refused",
        albumMbid: "album-shape",
        trackMbid: "track-new-noise",
      }),
  });

  assert.equal(scheduleScanLibrary.mock.calls.length, 1);
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
    resolveTrackContext: () => {
      throw new Error("resolve failed");
    },
  });

  assert.equal(result.changed, false);
  const storedTrack = flowPlaylistConfig.getStaticPlaylist(playlist.id)?.tracks?.[0];
  assert.ok(storedTrack != null);
  assert.ok(!storedTrack.artistMbid);
});

test("enrichStaticPlaylistMbids stops retrying the same unavailable album within one sweep", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Unavailable album",
    tracks: ["First", "Second", "Third"].map((trackName) => ({
      artistName: "Tool",
      albumName: "Undertow",
      albumMbid: "undertow-mbid",
      trackName,
    })),
  });
  let resolverCalls = 0;

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: () => {
      resolverCalls += 1;
      throw new Error("metadata unavailable");
    },
  });

  assert.equal(resolverCalls, 1);
  assert.equal(result.changed, false);
});

test("enrichStaticPlaylistMbids leaves already-enriched tracks unchanged", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Enriched",
    tracks: [
      {
        artistName: "Radiohead",
        trackName: "Creep",
        artistMbid: "radiohead-mbid",
        trackMbid: "creep-mbid",
      },
    ],
  });

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: async (track) =>
      resolved(track, {
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
    tracks: [
      {
        artistName: "Radiohead",
        trackName: "Creep",
        artistMbid: "radiohead-mbid",
        albumMbid: "pablo-honey-mbid",
        trackMbid: "creep-mbid",
      },
    ],
  });
  let resolverCalls = 0;

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    resolveTrackContext: async (track) => {
      resolverCalls += 1;
      return resolved(track);
    },
  });

  assert.equal(resolverCalls, 0);
  assert.equal(result.changed, false);
});

test("enrichStaticPlaylistMbids can reconcile complete tracks once when explicitly requested", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Needs artist repair",
    tracks: [
      {
        artistName: "Radiohead",
        trackName: "Creep",
        artistMbid: "wrong-artist-mbid",
        albumMbid: "pablo-honey-mbid",
        trackMbid: "creep-mbid",
      },
    ],
  });

  const result = await enrichStaticPlaylistMbids(playlist.id, {
    reconcileArtistMbids: true,
    resolveTrackContext: async (track) =>
      resolved(track, {
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
    tracks: [
      {
        artistName: "Radiohead",
        trackName: "Creep",
        artistMbid: "radiohead-mbid",
        albumMbid: "pablo-honey-mbid",
        trackMbid: "creep-mbid",
      },
    ],
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
  const getPlaylistId = (jobId: number) => {
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
