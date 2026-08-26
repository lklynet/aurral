import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, historyModule] = await setupIsolatedBackend(
  "aurral-history",
  "backend/config/db-sqlite.js",
  "backend/services/aurralHistoryService.js",
);

const {
  upsertAurralHistory,
  getAurralHistoryRequests,
  recordTrackJobBlocked,
  recordTrackJobQueued,
} = historyModule;
const { downloadTracker } = await importFromRepo(
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
);
const { getHonkerDb } = await importFromRepo("backend/services/honkerDb.js");

test.beforeEach(() => {
  resetDatabase(db);
  const transaction = getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live WHERE queue = ?", ["weekly-flow-operation"]);
  transaction.commit();
  downloadTracker.clearAll();
});

test.after(async () => {
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
  const operationId = getHonkerDb().queue("weekly-flow-operation").enqueue({
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

test("getAurralHistoryRequests fails stale active download history", async () => {
  const jobId = downloadTracker.addJob(
    {
      artistName: "Artist",
      trackName: "Stale Song",
    },
    "playlist-1",
  );
  upsertAurralHistory({
    referenceId: jobId,
    kind: "track_download",
    title: "Searching slskd for Stale Song",
    subtitle: "Artist · Playlist",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      jobId,
      trackName: "Stale Song",
      artistName: "Artist",
      playlistId: "playlist-1",
      downloadSource: "slskd",
    },
    createdAt: Date.now() - 20 * 60 * 1000,
  });
  downloadTracker.setDownloading(jobId);
  const job = downloadTracker.getJob(jobId);
  job.createdAt = Date.now() - 20 * 60 * 1000;
  job.startedAt = job.createdAt;

  const entries = await getAurralHistoryRequests();
  const entry = entries.find((item) => item.jobId === jobId);

  assert.equal(entry?.status, "failed");
  assert.equal(entry?.inQueue, false);
  assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
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
  downloadTracker.updateDownloadMetadata(jobId, {
    remoteFilename: "Artist - Song (2024).flac",
  });
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", "/tmp/staging/other-name.mp3");
  recordTrackJobBlocked(downloadTracker.getJob(jobId), "blocked-duration-mismatch");

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
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", "/tmp/staging/downloaded-track.mp3");
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
