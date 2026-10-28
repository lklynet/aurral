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
  recordTrackJobQueued,
  toHistoryRequestItem,
} = historyModule;
const { downloadTracker } = await import("../../backend/services/downloadJobs/downloadTracker.ts");
const { upsertLibraryArtist, upsertLibraryAlbum, upsertLibraryTrack, linkLibraryAlbumTrack } =
  await import("../../backend/services/libraryMediaStore.ts");
const { getHonkerDb } = await import("../../backend/services/honkerDb.ts");
const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");

beforeEach(() => {
  resetDatabase(db);
  const transaction = getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live WHERE queue IN (?, ?)", [
    "weekly-flow-operation",
    "slskd-pipeline",
  ]);
  transaction.commit();
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
  upsertAurralHistory({
    referenceId: "job-1",
    kind: "track_download",
    title: "Searching slskd for Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId: "job-1", trackName: "Song", artistName: "Artist" },
    createdAt: baseTime - 4000,
  });

  upsertAurralHistory({
    referenceId: "job-1",
    kind: "track_download",
    title: "Searching slskd for Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId: "job-1", trackName: "Song", artistName: "Artist" },
    createdAt: baseTime,
  });

  const [entry] = await getAurralHistoryRequests();
  assert.equal(new Date(entry.requestedAt).getTime(), baseTime - 4000);
});

test("upsertAurralHistory moves changed records to the top", async () => {
  const baseTime = Date.now();
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
    referenceId: "job-2",
    kind: "track_download",
    title: "Searching slskd for Newer Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: { jobId: "job-2", trackName: "Newer Song", artistName: "Artist" },
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
});

test("queued album track jobs open their album, and other library jobs open the library playlist", async () => {
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
  assert.equal(
    entries.find((item) => item.jobId === withAlbum)?.href,
    `/library/album/${album.id}`,
  );
  assert.equal(
    entries.find((item) => item.jobId === withoutAlbum)?.href,
    "/playlists?selected=library",
  );

  const { finalizeQualityUpgradeFailure } =
    await import("../../backend/services/qualityProfileService.ts");
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
  assert.equal(upgrade?.href, `/library/album/${album.id}`);
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
    await import("../../backend/services/qualityProfileService.ts");
  await finalizeQualityUpgradeFailure(upgradeJob, "No better file");
  assert.deepEqual(await upgradeOf(upgradeId), { fromQuality: "MP3 320" });
});

test("pending tracker jobs without history appear in activity immediately", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Unrecorded Song",
    },
    "playlist-1",
  );

  const entry = (await getAurralHistoryRequests()).find((item) => item.jobId === jobId);
  assert.equal(entry?.status, "pending");
  assert.equal(entry?.statusLabel, "Queued");
  assert.equal(entry?.inQueue, true);
  assert.equal(entry?.trackName, "Unrecorded Song");
});

test("pending playlist imports appear in activity before the worker starts", async () => {
  const operationId = getHonkerDb()
    .queue("weekly-flow-operation")
    .enqueue({
      kind: "shared-playlist-create",
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
  getHonkerDb()
    .queue("slskd-pipeline")
    .enqueue({
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

test("getAurralHistoryRequests fails orphaned download history", async () => {
  upsertAurralHistory({
    referenceId: "missing-job",
    kind: "track_download",
    title: "Searching slskd for Missing Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      jobId: "missing-job",
      trackName: "Missing Song",
      artistName: "Artist",
      playlistId: "playlist-1",
      downloadSource: "slskd",
    },
    createdAt: Date.now() - 20 * 60 * 1000,
  });

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === "missing-job");

  assert.equal(entry?.status, "failed");
  assert.equal(entry?.inQueue, false);
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
  vi.spyOn(lidarrClient, "getHistory").mockResolvedValue({ records: [] });
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
