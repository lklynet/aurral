import { requireFixture } from "../playlists/fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, historyModule] = await setupIsolatedBackend(
  "aurral-history",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/aurralHistoryService.ts"),
);

const {
  upsertAurralHistory,
  getAurralHistoryRequests,
  recordTrackJobBlocked,
  recordTrackJobDownloading,
  recordTrackJobSearching,
  recordTrackJobCompleted,
  recordTrackJobQueued,
  toHistoryRequestItem,
} = historyModule;
const { downloadTracker } = await import("../../backend/services/downloadJobs/downloadTracker.ts");
const { upsertLibraryArtist, upsertLibraryAlbum, upsertLibraryTrack, linkLibraryAlbumTrack } =
  await import("../../backend/services/libraryMediaStore.ts");
const { insertJob } = await import("../helpers/jobs.ts");
const { dbOps } = await import("../../backend/db/helpers/index.ts");
const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");

beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM aurral_history").run();
  downloadTracker.clearAll();
});

test("activity reads stay local when Lidarr is disabled", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => false);
  const request = vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("disabled activity reads must not call Lidarr");
  });

  assert.deepEqual(await getAurralHistoryRequests(lidarrClient), []);
  assert.equal(request.mock.calls.length, 0);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("upsertAurralHistory keeps timestamp for unchanged records", async () => {
  const baseTime = Date.now();
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "playlist-1");
  assert.ok(jobId != null);
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Searching slskd for Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId, trackName: "Song", artistName: "Artist" },
    createdAt: baseTime - 4000,
  });

  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Searching slskd for Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId, trackName: "Song", artistName: "Artist" },
    createdAt: baseTime,
  });

  const [entry] = await getAurralHistoryRequests();
  assert.ok(entry);
  assert.equal(new Date(entry.requestedAt).getTime(), baseTime - 4000);
});

test("upsertAurralHistory moves changed records to the top", async () => {
  const baseTime = Date.now();
  const newerJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Newer Song" },
    "playlist-1",
  );
  assert.ok(newerJobId != null);
  upsertAurralHistory({
    referenceId: "job-1",
    kind: "track_download",
    title: "Searching slskd for Older Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId: "job-1", trackName: "Older Song", artistName: "Artist" },
    createdAt: baseTime - 4000,
  });
  upsertAurralHistory({
    referenceId: newerJobId,
    kind: "track_download",
    title: "Searching slskd for Newer Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId: newerJobId, trackName: "Newer Song", artistName: "Artist" },
    createdAt: baseTime - 2000,
  });

  upsertAurralHistory({
    referenceId: "job-1",
    kind: "track_download",
    title: "Failed to download Older Song",
    subtitle: "No suitable slskd search results",
    status: "failed",
    statusLabel: "Failed",
    metadata: { jobId: "job-1", trackName: "Older Song", artistName: "Artist" },
    createdAt: baseTime,
  });

  const entries = await getAurralHistoryRequests();
  assert.equal(entries[0]?.jobId, "job-1");
  assert.equal(entries[0]?.status, "failed");
  assert.equal(new Date(entries[0]?.requestedAt).getTime(), baseTime);
});

test("track download history separates NZBGet from slskd", async () => {
  upsertAurralHistory({
    referenceId: "job-slskd",
    kind: "track_download",
    title: "Searching slskd for Soulseek Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      jobId: "job-slskd",
      trackName: "Soulseek Song",
      artistName: "Artist",
      downloadSource: "slskd",
    },
  });
  upsertAurralHistory({
    referenceId: "job-usenet",
    kind: "track_download",
    title: "Searching NZBGet for Usenet Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      jobId: "job-usenet",
      trackName: "Usenet Song",
      artistName: "Artist",
      downloadSource: "usenet",
    },
  });

  const entries = await getAurralHistoryRequests();
  const slskdEntry = entries.find((entry) => entry.jobId === "job-slskd");
  const usenetEntry = entries.find((entry) => entry.jobId === "job-usenet");

  assert.equal(slskdEntry?.source, "slskd");
  assert.equal(usenetEntry?.source, "nzbget");
});

test("getAurralHistoryRequests reconciles completed download jobs", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
    },
    "playlist-1",
  );
  assert.ok(jobId != null);
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Downloading Song via slskd",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Downloading",
    metadata: {
      jobId,
      trackName: "Song",
      artistName: "Artist",
      playlistId: "playlist-1",
      downloadSource: "slskd",
    },
    createdAt: Date.now() - 60 * 1000,
  });
  downloadTracker.setDone(jobId, "/tmp/song.flac", "Album");

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "completed");
  assert.equal(entry?.statusLabel, "Downloaded");
  assert.equal(entry?.inQueue, false);
});

test("queued and downloading activity for deleted jobs leaves the queue as cancelled", async () => {
  const jobIds = ["Queued Song", "Downloading Song"].map((trackName) =>
    downloadTracker.addJob({ artistName: "Artist", trackName }, "deleted-playlist"),
  );
  for (const [index, jobId] of jobIds.entries()) {
    assert.ok(jobId != null);
    upsertAurralHistory({
      referenceId: jobId,
      kind: "track_download",
      title: "Queued Song",
      subtitle: "Artist · Playlist",
      status: index === 0 ? "pending" : "processing",
      statusLabel: index === 0 ? "Queued" : "Downloading",
      metadata: { jobId, trackName: "Song", artistName: "Artist", playlistId: "deleted-playlist" },
      createdAt: Date.now() - 60 * 1000,
    });
  }
  downloadTracker.clearByPlaylistId("deleted-playlist");

  const entries = await getAurralHistoryRequests();

  for (const jobId of jobIds) {
    const entry = entries.find((item) => item.jobId === jobId);
    assert.equal(entry?.status, "cancelled");
    assert.equal(entry?.inQueue, false);
  }
});

test("getAurralHistoryRequests reconciles pending queued jobs as reused when tracker job is done", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Reused Song",
    },
    "playlist-1",
  );
  assert.ok(jobId != null);
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Queueing Reused Song",
    subtitle: "Artist · Playlist",
    status: "pending",
    statusLabel: "Queued",
    metadata: {
      jobId,
      trackName: "Reused Song",
      artistName: "Artist",
      playlistId: "playlist-1",
    },
    createdAt: Date.now() - 60 * 1000,
  });
  downloadTracker.setDone(jobId, "/tmp/reused-song.flac", "Album");

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "completed");
  assert.equal(entry?.statusLabel, "Reused");
  assert.equal(entry?.inQueue, false);
});

test("queued library track jobs appear in activity immediately", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Queued Song",
      albumName: "Album",
      trackMbid: "track-mbid",
    },
    "library",
  );

  recordTrackJobQueued(downloadTracker.getJob(jobId));

  const entry = (await getAurralHistoryRequests()).find((item) => item.jobId === jobId);
  assert.equal(entry?.status, "pending");
  assert.equal(entry?.statusLabel, "Queued");
  assert.equal(entry?.inQueue, true);
  assert.equal(entry?.trackName, "Queued Song");
  assert.equal(entry?.source, "unknown");
});

test("queued album track jobs open their album, and other library jobs have no link", async () => {
  const albumMbid = "b2222222-2222-4222-8222-222222222201";
  const artist = upsertLibraryArtist({
    identityKey: "mbid:b1111111-1111-4111-8111-111111111111",
    mbid: "b1111111-1111-4111-8111-111111111111",
    name: "Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: "recording:b3333333-3333-4333-8333-333333333301",
    mbid: "b3333333-3333-4333-8333-333333333301",
    title: "One",
    artistName: "Artist",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  const withAlbum = downloadTracker.addJob(
    { artistName: "Artist", trackName: "One", albumName: "Album", albumMbid, trackMbid: "t1" },
    "library",
  );
  const withoutAlbum = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Two", albumName: "Loose", trackMbid: "t2" },
    "library",
  );
  recordTrackJobQueued(downloadTracker.getJob(withAlbum));
  recordTrackJobQueued(downloadTracker.getJob(withoutAlbum));

  const entries = await getAurralHistoryRequests();
  assert.equal(entries.find((item) => item.jobId === withAlbum)?.href, `/album/${albumMbid}`);
  assert.equal(entries.find((item) => item.jobId === withAlbum)?.libraryAlbumId, String(album.id));
  assert.equal(entries.find((item) => item.jobId === withoutAlbum)?.href, null);
  assert.equal(entries.find((item) => item.jobId === withoutAlbum)?.libraryAlbumId, null);

  upsertAurralHistory({
    referenceId: "stored-job",
    kind: "track_download",
    title: "Downloaded One",
    status: "completed",
    href: "/playlists?selected=library",
    metadata: { jobId: "stored-job", playlistId: "library", albumMbid },
  });
  assert.equal(
    (await getAurralHistoryRequests()).find((item) => item.jobId === "stored-job")?.href,
    `/album/${albumMbid}`,
  );

  const { finalizeQualityUpgradeFailure } =
    await import("../../backend/services/qualityUpgradeOutcome.ts");
  await finalizeQualityUpgradeFailure(
    {
      ...requireFixture(downloadTracker.getJob(withAlbum)),
      id: "upgrade-of-one",
      upgradeForJobId: withAlbum,
    },
    "No better file",
  );
  const upgrade = (await getAurralHistoryRequests()).find(
    (item) => item.jobId === "upgrade-of-one",
  );
  assert.equal(upgrade?.href, `/album/${albumMbid}`);
});

test("a quality upgrade stays marked as one from queued to its result", async () => {
  const sourceId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "library");
  const otherId = downloadTracker.addJob({ artistName: "Artist", trackName: "Other" }, "library");
  const upgradeId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "library");
  const upgradeJob = {
    ...requireFixture(downloadTracker.getJob(upgradeId)),
    upgradeForJobId: sourceId,
  };
  const upgradeOf = async (jobId: string | null) =>
    (await getAurralHistoryRequests()).find((item) => item.jobId === jobId)?.upgrade;

  recordTrackJobQueued(upgradeJob, null, { fromQuality: "MP3 320" });
  recordTrackJobQueued(downloadTracker.getJob(otherId));
  recordTrackJobDownloading(upgradeJob);
  assert.deepEqual(await upgradeOf(upgradeId), { fromQuality: "MP3 320" });
  assert.equal(await upgradeOf(otherId), null);

  const { finalizeQualityUpgradeFailure } =
    await import("../../backend/services/qualityUpgradeOutcome.ts");
  await finalizeQualityUpgradeFailure(upgradeJob, "No better file");
  assert.deepEqual(await upgradeOf(upgradeId), { fromQuality: "MP3 320" });
});

test("pending tracker jobs without history appear in activity immediately", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Unrecorded Song",
      albumMbid: "c2222222-2222-4222-8222-222222222201",
    },
    "library",
  );

  const entry = (await getAurralHistoryRequests()).find((item) => item.jobId === jobId);
  assert.equal(entry?.status, "pending");
  assert.equal(entry?.statusLabel, "Queued");
  assert.equal(entry?.inQueue, true);
  assert.equal(entry?.trackName, "Unrecorded Song");
  assert.equal(entry?.source, "unknown");
  assert.equal(entry?.href, "/album/c2222222-2222-4222-8222-222222222201");
});

test("pending playlist imports appear in activity before the worker starts", async () => {
  const operationId = insertJob(db, "playlist-operation", {
    kind: "static-playlist-create",
    playlistId: "pending-playlist",
    name: "Pending Playlist",
    sourceName: "ListenBrainz",
    ownerUserId: 42,
    tracks: [{ artistName: "Artist", trackName: "Song" }],
  });

  const entry = (await getAurralHistoryRequests()).find(
    (item) => item.id === `aurral-playlist_import-${operationId}`,
  );
  assert.equal(entry?.kind, "playlist_import");
  assert.equal(entry?.status, "pending");
  assert.equal(entry?.statusLabel, "Queued");
  assert.equal(entry?.playlistName, "Pending Playlist");
  assert.equal(entry?.subtitle, "ListenBrainz · 1 track waiting for download");
});

test("getAurralHistoryRequests fails stale active download history, but not a track its album's release attempt still downloads", async () => {
  const staleDownload = (trackName: string) => {
    const jobId = downloadTracker.addJob({ artistName: "Artist", trackName }, "playlist-1");
    assert.ok(jobId != null);
    upsertAurralHistory({
      referenceId: jobId,
      kind: "track_download",
      title: `Searching slskd for ${trackName}`,
      subtitle: "Artist · Playlist",
      status: "processing",
      statusLabel: "Searching",
      metadata: {
        jobId,
        trackName,
        artistName: "Artist",
        playlistId: "playlist-1",
        downloadSource: "slskd",
      },
      createdAt: Date.now() - 20 * 60 * 1000,
    });
    downloadTracker.setDownloading(jobId);
    const job = downloadTracker.getJob(jobId);
    assert.ok(job != null);
    job.createdAt = Date.now() - 20 * 60 * 1000;
    job.startedAt = job.createdAt;
    return jobId;
  };
  const jobId = staleDownload("Stale Song");
  const waitingId = staleDownload("Waiting Song");
  insertJob(db, "download-pipeline", {
    jobId: "lead-job",
    albumGrab: true,
    albumGroupJobIds: ["lead-job", waitingId],
  });

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "failed");
  assert.equal(entry?.inQueue, false);
  assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
  assert.equal(entries.find((item) => item.jobId === waitingId)?.status, "processing");
  assert.equal(downloadTracker.getJob(waitingId)?.status, "downloading");
});

test("reading the queue does not rewrite an unchanged Review job", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
      albumName: "Album",
      albumMbid: "b2222222-2222-4222-8222-222222222222",
      requestGroupId: "group-1",
    },
    "playlist-1",
  );
  assert.ok(jobId != null);
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch");
  recordTrackJobBlocked(downloadTracker.getJob(jobId)!, "blocked-duration-mismatch");
  const insert = vi.spyOn(dbOps, "insertAurralHistory");

  await getAurralHistoryRequests();

  assert.equal(insert.mock.calls.length, 0);
});

test("reading a Review queue bigger than history keeps older activity", async () => {
  upsertAurralHistory({
    referenceId: "earlier-job",
    kind: "track_download",
    title: "Downloaded Earlier Song",
    status: "completed",
    statusLabel: "Downloaded",
    metadata: { jobId: "earlier-job", trackName: "Earlier Song", artistName: "Artist" },
    createdAt: Date.now() - 60_000,
  });
  const blockedIds = Array.from({ length: 1001 }, (_, index) => {
    const jobId = downloadTracker.addJob(
      { artistName: "Artist", trackName: `Song ${index}` },
      "playlist-1",
    );
    assert.ok(jobId != null);
    downloadTracker.setBlocked(jobId, "blocked-duration-mismatch");
    return jobId;
  });

  await getAurralHistoryRequests();
  const entries = await getAurralHistoryRequests();

  assert.ok(entries.some((item) => item.jobId === "earlier-job"));
  const blocked = entries.filter((item) => item.status === "blocked");
  assert.equal(blocked.length, blockedIds.length);
  assert.ok(blocked.every((item) => item.subtitle === "blocked-duration-mismatch"));
});

test("blocked track download history exposes source filename", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
      albumName: "Album",
    },
    "playlist-1",
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    remoteFilename: "Artist - Song (2024).flac",
  });
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", "/tmp/staging/other-name.mp3");
  recordTrackJobBlocked(downloadTracker.getJob(jobId)!, "blocked-duration-mismatch");

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "blocked");
  assert.equal(entry?.sourceFilename, "Artist - Song (2024).flac");
  assert.equal(entry?.albumName, "Album");
});

test("blocked track download history falls back to staging basename", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
    },
    "playlist-1",
  );
  assert.ok(jobId != null);
  downloadTracker.setBlocked(
    jobId,
    "blocked-duration-mismatch",
    "/tmp/staging/downloaded-track.mp3",
  );
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Review needed for Song",
    subtitle: "blocked-duration-mismatch",
    status: "blocked",
    statusLabel: "Review",
    metadata: {
      jobId,
      trackName: "Song",
      artistName: "Artist",
      playlistId: "playlist-1",
      downloadSource: "slskd",
    },
  });

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.sourceFilename, "downloaded-track.mp3");
});

test("blocked Usenet download history names the held track file and its release", async () => {
  const release = '[01/41] "Artist-Album-Deluxe_Edition-WEB-FLAC.par2"';
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "playlist-1",
  );
  assert.ok(jobId != null);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadSource: "usenet",
    releaseTitle: release,
    remoteFilename: release,
  });
  downloadTracker.setBlocked(
    jobId,
    "blocked-duration-mismatch",
    "/tmp/usenet/Artist-Album-Deluxe_Edition/05-artist-song.flac",
  );
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Review needed for Song",
    subtitle: "blocked-duration-mismatch",
    status: "blocked",
    statusLabel: "Review",
    metadata: {
      jobId,
      trackName: "Song",
      artistName: "Artist",
      playlistId: "playlist-1",
      downloadSource: "usenet",
      sourceFilename: release,
    },
  });

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.sourceFilename, "05-artist-song.flac");
  assert.equal(entry?.releaseTitle, release);
});

test("cancelled album track downloads show as cancelled, never as failed", async () => {
  const { cancelDownloadJobs } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Cancelled Song",
      albumName: "Album",
      managedBy: "aurral",
      requestGroupId: "cancelled-history-group",
    },
    "library",
  );
  assert.ok(jobId != null);
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Downloading Cancelled Song",
    subtitle: "Artist · Library",
    status: "processing",
    statusLabel: "Downloading",
    metadata: {
      jobId,
      trackName: "Cancelled Song",
      artistName: "Artist",
      playlistId: "library",
      downloadSource: "slskd",
    },
    createdAt: Date.now() - 20 * 60 * 1000,
  });
  downloadTracker.setDownloading(jobId);
  cancelDownloadJobs([jobId]);
  downloadTracker.setCancelled(jobId);
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
  job.createdAt = Date.now() - 20 * 60 * 1000;
  job.startedAt = job.createdAt;

  const entry = (await getAurralHistoryRequests()).find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "cancelled");
  assert.equal(entry?.statusLabel, "Cancelled");
  assert.equal(entry?.inQueue, false);
  assert.equal(downloadTracker.getJob(jobId)?.status, "cancelled");
});

const lidarrWithAlbum = (getAlbum: typeof lidarrClient.getAlbum) => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getQueue").mockResolvedValue([]);
  vi.spyOn(lidarrClient, "getHistory").mockResolvedValue([]);
  vi.spyOn(lidarrClient, "request").mockResolvedValue([]);
  vi.spyOn(lidarrClient, "getAlbum").mockImplementation(getAlbum);
  return lidarrClient;
};

test("a request for an album since deleted from Lidarr leaves the activity feed", async (t: import("vite-plus/test").TestContext) => {
  t.onTestFinished(() => {
    db.prepare("DELETE FROM aurral_history").run();
  });
  historyModule.recordAlbumRequested({
    albumId: "5151",
    albumName: "Deleted Album",
    artistName: "Artist",
    searching: true,
  });

  // lidarrClient.getAlbum resolves null when Lidarr answers 404.
  const entries = await getAurralHistoryRequests(lidarrWithAlbum(async () => null));

  assert.equal(
    entries.find((item) => item.albumName === "Deleted Album"),
    undefined,
  );
});

test("a request survives Lidarr being unreachable", async (t: import("vite-plus/test").TestContext) => {
  t.onTestFinished(() => {
    db.prepare("DELETE FROM aurral_history").run();
  });
  historyModule.recordAlbumRequested({
    albumId: "5252",
    albumName: "Kept Album",
    artistName: "Artist",
    searching: true,
  });

  const entries = await getAurralHistoryRequests(
    lidarrWithAlbum(async () => {
      throw new Error("connect ECONNREFUSED");
    }),
  );

  assert.notEqual(
    entries.find((item) => item.albumName === "Kept Album"),
    undefined,
  );
});

test("a request without its Lidarr album ID finds it among its artist's albums, never the whole library", async (t: import("vite-plus/test").TestContext) => {
  t.onTestFinished(() => {
    db.prepare("DELETE FROM aurral_history").run();
  });
  const lookups: string[] = [];
  const lidarrStub = lidarrWithAlbum(async (id) => {
    lookups.push(String(id));
    return { id: Number(id), foreignAlbumId: "found", statistics: { trackFileCount: 0 } };
  });
  vi.spyOn(lidarrStub, "getArtistByMbid").mockImplementation(async (mbid) =>
    mbid === "artist-mbid" ? { id: 9, artistName: "Artist", foreignArtistId: mbid } : null,
  );
  const albumLists: unknown[] = [];
  vi.spyOn(lidarrStub, "getAllAlbums").mockImplementation(async (options) => {
    albumLists.push(options.artistIds);
    return [
      { id: 6161, foreignAlbumId: "other", title: "Other Album" },
      { id: 6262, foreignAlbumId: "found", title: "Found Album" },
    ];
  });
  historyModule.recordAlbumRequested({
    albumName: "Found Album",
    artistName: "Artist",
    artistMbid: "artist-mbid",
    searching: true,
  });

  await getAurralHistoryRequests(lidarrStub);

  assert.deepEqual(albumLists, [[9]]);
  assert.deepEqual(lookups, ["6262"]);
});

test("Aurral album requests are not checked against Lidarr by library album ID", async () => {
  const lidarrAlbumLookups: string[] = [];
  const lidarrStub = lidarrWithAlbum(async (id) => {
    lidarrAlbumLookups.push(String(id));
    return { id: Number(id), foreignAlbumId: String(id), statistics: { trackFileCount: 0 } };
  });
  historyModule.recordAlbumRequested({
    albumId: "4242",
    albumName: "Aurral Owned Album",
    artistName: "Artist",
    managedBy: "aurral",
    searching: true,
  });
  historyModule.recordAlbumRequested({
    albumId: "4343",
    albumName: "Lidarr Album",
    artistName: "Artist",
    searching: true,
  });

  const entries = await getAurralHistoryRequests(lidarrStub);

  assert.deepEqual(lidarrAlbumLookups, ["4343"]);
  const aurralEntry = entries.find((item) => item.albumName === "Aurral Owned Album");
  assert.notEqual(aurralEntry?.status, "failed");
  assert.doesNotMatch(aurralEntry?.title || "", /Lidarr/);
  assert.equal(aurralEntry?.source, "aurral");
  assert.equal(entries.find((item) => item.albumName === "Lidarr Album")?.source, "lidarr");
});

test("a history entry kind named like an Object method falls back to the Aurral source", () => {
  const entry = {
    id: "aurral-constructor-1",
    kind: "constructor",
    title: "Entry",
    subtitle: null,
    status: "completed",
    statusLabel: null,
    href: null,
    metadata: null,
    createdAt: Date.now(),
  };
  assert.equal(toHistoryRequestItem(entry).source, "aurral");
  assert.equal(toHistoryRequestItem({ ...entry, kind: "album_requested" }).source, "lidarr");
});

test("a history entry with an unreadable field keeps the rest of its details", async () => {
  upsertAurralHistory({
    referenceId: "job-1",
    kind: "track_download",
    title: "Downloaded Song",
    status: "completed",
    metadata: { jobId: "job-1", trackName: "Song", artistName: "Artist" },
  });
  db.prepare("UPDATE aurral_history SET metadata = ?").run(
    JSON.stringify({
      jobId: "job-1",
      trackName: "Song",
      artistName: "Artist",
      userId: "1",
      playlistName: {},
    }),
  );

  const [entry] = await getAurralHistoryRequests();
  assert.ok(entry);

  assert.equal(entry.trackName, "Song");
  assert.equal(entry.artistName, "Artist");
  assert.equal(entry.playlistName, null);
  assert.equal(entry.requestedBy, null);
});

test.each([
  [null, null, "unknown"],
  ["", null, "unknown"],
  ["unrecognized", null, "unknown"],
  ["slskd", null, "slskd"],
  [" DEEMIX ", null, "deemix"],
  ["ytdlp", null, "ytdlp"],
  ["share", null, "share"],
  ["usenet", null, "nzbget"],
  ["usenet", "sabnzbd", "sabnzbd"],
  ["usenet", "tidarr", "tidarr"],
])(
  "stored track history resolves source %s with client %s as %s",
  async (downloadSource, downloadClient, source) => {
    upsertAurralHistory({
      referenceId: "stored-track",
      kind: "track_download",
      title: "Downloaded Song",
      status: "completed",
      metadata: { jobId: "stored-track", downloadSource, downloadClient },
    });

    const entry = (await getAurralHistoryRequests()).find((item) => item.jobId === "stored-track");
    assert.equal(entry?.source, source);
  },
);

test("track activity preserves an unknown source until a provider is selected", async () => {
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "library");
  assert.ok(jobId != null);
  const job = () => requireFixture(downloadTracker.getJob(jobId));
  const entry = async () =>
    requireFixture((await getAurralHistoryRequests()).find((item) => item.jobId === jobId));

  const queued = recordTrackJobQueued(job());
  assert.equal(queued?.metadata?.downloadSource, null);
  recordTrackJobSearching(job());
  assert.equal((await entry()).source, "unknown");
  assert.equal((await entry()).title, "Searching for Song");
  recordTrackJobDownloading(job());
  assert.equal((await entry()).title, "Downloading Song");

  downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "deemix" });
  recordTrackJobDownloading(job());
  assert.equal((await entry()).source, "deemix");
  assert.equal((await entry()).title, "Downloading Song via deemix");
  recordTrackJobCompleted(job());
  assert.equal((await entry()).source, "deemix");
});

test.each([null, "deemix"])(
  "tracker source %s corrects older Soulseek defaults in queued and completed history",
  async (downloadSource) => {
    const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "library");
    assert.ok(jobId != null);
    upsertAurralHistory({
      referenceId: jobId,
      kind: "track_download",
      title: "Queued Song",
      status: "pending",
      statusLabel: "Queued",
      metadata: { jobId, downloadSource: "slskd" },
    });
    if (downloadSource) downloadTracker.updateDownloadMetadata(jobId, { downloadSource });
    const entry = async () =>
      requireFixture((await getAurralHistoryRequests()).find((item) => item.jobId === jobId));
    assert.equal((await entry()).source, downloadSource || "unknown");

    upsertAurralHistory({
      referenceId: jobId,
      kind: "track_download",
      title: "Downloaded Song",
      status: "completed",
      metadata: { jobId, downloadSource: "slskd" },
    });
    downloadTracker.setDone(jobId, "/tmp/song.flac", "Album");
    assert.equal((await entry()).source, downloadSource || "unknown");
  },
);
