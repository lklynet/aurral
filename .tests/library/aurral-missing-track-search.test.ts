import * as v from "valibot";
import { requireFixture } from "../playlists/fixtures.ts";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { downloadTracker },
  { downloadWorker },
  { lidarrClient },
  { libraryManager },
  { getLibraryForAlbumIds },
  { recordMissingTrackSearch },
  { runMissingTrackSearch },
  { SCHEDULED_SYSTEM_TASKS },
  { processSystemTask, systemTaskSchema },
  { scanMusicRoot },
] = await setupIsolatedBackend(
  "aurral-missing-track-search",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/aurralHistoryService.ts"),
  () => import("../../backend/services/aurralMissingTrackSearch.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const lidarrCalls: unknown[][] = [];
let sequence = 0;

function atTime<T>(now: number, create: () => T) {
  vi.useFakeTimers({ toFake: ["Date"], now: now });
  try {
    return create();
  } finally {
    vi.useRealTimers();
  }
}

function addTrackJob({
  artist,
  album,
  albumMbid,
  track,
  trackMbid,
  state,
}: {
  artist: ReturnType<typeof libraryStore.upsertLibraryArtist>;
  album: ReturnType<typeof libraryStore.upsertLibraryAlbum>;
  albumMbid: string | null;
  track: ReturnType<typeof libraryStore.upsertLibraryTrack>;
  trackMbid: string;
  state: string;
}) {
  const jobId = downloadTracker.addJob(
    {
      artistName: artist.name,
      trackName: track.title,
      albumName: album.title,
      albumMbid,
      trackMbid,
      managedBy: "aurral",
    },
    "library",
  );
  assert.ok(jobId != null);
  if (state === "failed") downloadTracker.setFailed(jobId, "No matching source result");
  if (state === "cancelled") downloadTracker.setCancelled(jobId);
  if (state === "blocked") downloadTracker.setBlocked(jobId, "Blocked for review");
  return jobId;
}

function createAlbum({
  managedBy = "aurral",
  monitored = true,
  artistMode = null,
  lastSearchedAt = null,
  jobsAt = Date.now() - 10 * DAY_MS,
  tracks = ["missing"],
  withMbid = true,
  requested = true,
}: {
  managedBy?: string;
  monitored?: boolean;
  artistMode?: string | null;
  lastSearchedAt?: number | null;
  jobsAt?: number;
  tracks?: string[];
  withMbid?: boolean;
  requested?: boolean;
} = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const artistMbid = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  const albumMbid = withMbid ? `cccccccc-cccc-4ccc-8ccc-${suffix}` : null;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: `Search Artist ${sequence}`,
  });
  if (artistMode) {
    managementStore.setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      managedBy: "aurral",
      monitorMode: artistMode,
    });
  }
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: albumMbid ? `release-group:${albumMbid}` : `album:search-album-${sequence}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Search Album ${sequence}`,
    metadata: {
      monitored,
      ...(managedBy === "aurral" && requested ? { librarySource: "aurral" } : {}),
    },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy,
    monitorMode: monitored ? null : "unmonitored",
  });
  if (lastSearchedAt != null) {
    db.prepare(
      "UPDATE library_management SET last_missing_search_at = ? WHERE entity_kind = 'album' AND entity_id = ?",
    ).run(lastSearchedAt, album.id);
  }
  const jobIds: string[] = [];
  return atTime(jobsAt, () => {
    const albumTracks = tracks.map((state, index) => {
      const trackMbid = `dddddddd-dddd-4ddd-8ddd-${suffix.slice(2)}${String(index).padStart(2, "0")}`;
      const track = libraryStore.upsertLibraryTrack({
        identityKey: `recording:${trackMbid}`,
        mbid: trackMbid,
        title: `Track ${index + 1}`,
        artistName: artist.name,
      });
      libraryStore.linkLibraryAlbumTrack({
        albumId: album.id,
        trackId: track.id,
        trackNumber: index + 1,
      });
      if (state === "available") {
        libraryStore.upsertLibraryMediaFile({
          scanId: undefined,
          trackId: track.id,
          albumId: album.id,
          source: managedBy,
          path: path.join(isolatedState.dataDir, `album-${sequence}`, `${index + 1}.flac`),
        });
      } else if (state !== "missing") {
        jobIds[index] = addTrackJob({ artist, album, albumMbid, track, trackMbid, state });
      }
      return { ...track, mbid: trackMbid };
    });
    if (!monitored) for (const track of albumTracks) setTrackMonitored(track.id, false);
    return { artist, album, albumMbid, tracks: albumTracks, jobIds };
  });
}

const searchTime = (albumId: number) =>
  db
    .prepare<
      unknown[],
      {
        last_missing_search_at: import("../../backend/db/rows.ts").LibraryManagementRow["last_missing_search_at"];
      }
    >(
      "SELECT last_missing_search_at FROM library_management WHERE entity_kind = 'album' AND entity_id = ?",
    )
    .get(albumId)?.last_missing_search_at ?? null;

const trackMonitored = (trackId: number) =>
  db
    .prepare<
      unknown[],
      { monitored: import("../../backend/db/rows.ts").LibraryTracksRow["monitored"] }
    >("SELECT monitored FROM library_tracks WHERE id = ?")
    .get(trackId)?.monitored;

const setTrackMonitored = (trackId: number, monitored: boolean) =>
  db
    .prepare("UPDATE library_tracks SET monitored = ? WHERE id = ?")
    .run(monitored ? 1 : 0, trackId);

const albumJobs = (albumMbid: string | null) =>
  downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);

const albumActivity = (albumId: number) =>
  dbOps.getAurralHistory({ limit: 500 }).filter((entry) => entry.metadata?.albumId === albumId);

function setDownloadSourceConfigured(configured: boolean) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      slskd: configured
        ? { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" }
        : { enabled: false },
      ytdlp: { enabled: false },
    },
  });
}

const originalSettings = dbOps.getSettings();
const originalLidarr = {
  isConfigured: lidarrClient.isConfigured,
  request: lidarrClient.request,
  getArtist: lidarrClient.getArtist,
  getArtistByMbid: lidarrClient.getArtistByMbid,
};
const originalWorkerStart = downloadWorker.start;

beforeAll(() => {
  setDownloadSourceConfigured(true);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    missingTrackSearch: { enabled: true, intervalDays: 1 },
  });
  lidarrClient.isConfigured = () => false;
  for (const method of ["request", "getArtist", "getArtistByMbid"] as const) {
    lidarrClient[method] = async (...args: unknown[]) => {
      lidarrCalls.push([method, ...args]);
      throw new Error("Lidarr must not be called");
    };
  }
  downloadWorker.start = async () => {};
});

beforeEach(() => {
  downloadTracker.clearAll();
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_media_files").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  lidarrCalls.length = 0;
});

afterAll(async () => {
  Object.assign(lidarrClient, originalLidarr);
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await cleanupIsolatedState(isolatedState);
});

test("a due album gets its failed and missing tracks queued and an Activity entry", async () => {
  const { album, albumMbid, tracks, jobIds } = createAlbum({
    tracks: ["failed", "missing", "available"],
  });
  const startedAt = Date.now();

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(getJob(jobIds[0]).status, "pending");
  assert.equal(
    albumJobs(albumMbid).find((job) => job.trackMbid === tracks[1].mbid)?.status,
    "pending",
  );
  assert.equal(
    albumJobs(albumMbid).some((job) => job.trackMbid === tracks[2].mbid),
    false,
  );
  const searchedAt = searchTime(album.id);
  assert.ok(searchedAt !== null && searchedAt >= startedAt);
  assert.equal(albumActivity(album.id).length, 1);
  assert.deepEqual([...lidarrCalls], []);
});

test("repeated searches of an album keep one Activity entry", () => {
  const { album, artist } = createAlbum();
  const search = (queuedTrackCount: number) =>
    recordMissingTrackSearch({
      albumId: album.id,
      albumName: album.title,
      artistName: artist.name,
      artistMbid: artist.mbid!,
      queuedTrackCount,
    });

  search(2);
  search(1);

  const entries = albumActivity(album.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].metadata!.queuedTrackCount, 1);
});

test("an album searched within the interval waits while an older search is due", async () => {
  const recent = createAlbum({ lastSearchedAt: Date.now() - HOUR_MS });
  const stale = createAlbum({ lastSearchedAt: Date.now() - 2 * DAY_MS });
  const recentSearchTime = searchTime(recent.album.id);

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(albumJobs(recent.albumMbid).length, 0);
  assert.equal(searchTime(recent.album.id), recentSearchTime);
  assert.equal(albumJobs(stale.albumMbid).length, 1);
});

test("an album waits a full interval after its last download attempt", async () => {
  const justFailed = createAlbum({ tracks: ["failed"], jobsAt: Date.now() - HOUR_MS });
  const failedLongAgo = createAlbum({ tracks: ["failed"], jobsAt: Date.now() - 2 * DAY_MS });

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(getJob(justFailed.jobIds[0]).status, "failed");
  assert.equal(searchTime(justFailed.album.id), null);
  assert.equal(getJob(failedLongAgo.jobIds[0]).status, "pending");
});

test("a run searches every due album and leaves complete albums alone", async () => {
  const complete = [
    createAlbum({ tracks: ["available"] }),
    createAlbum({ tracks: ["available", "available"] }),
  ];
  const due = Array.from({ length: 30 }, (_, index) =>
    createAlbum({ lastSearchedAt: Date.now() - (60 - index) * DAY_MS }),
  );

  const searched = await runMissingTrackSearch();

  assert.equal(searched, due.length);
  for (const album of due) assert.equal(albumJobs(album.albumMbid).length, 1);
  for (const album of complete) assert.equal(searchTime(album.album.id), null);
});

test("a daily run counts an album as due when its wait ends within the hour", async () => {
  const almostDue = createAlbum({ lastSearchedAt: Date.now() - DAY_MS + 30 * 60 * 1000 });
  const notYetDue = createAlbum({ lastSearchedAt: Date.now() - DAY_MS + 2 * HOUR_MS });

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(albumJobs(almostDue.albumMbid).length, 1);
  assert.equal(albumJobs(notYetDue.albumMbid).length, 0);
});

test("only Aurral albums someone asked for with monitored missing tracks and no cancelled or active downloads are searched", async () => {
  const unmonitored = createAlbum({ monitored: false });
  const scannedNotRequested = createAlbum({ requested: false });
  const singleFromPlaylist = createAlbum({ monitored: false, tracks: ["missing", "missing"] });
  setTrackMonitored(singleFromPlaylist.tracks[0].id, true);
  const lidarrManaged = createAlbum({ managedBy: "lidarr" });
  const downloading = createAlbum({ tracks: ["pending", "missing"] });
  const cancelledByUser = createAlbum({ tracks: ["cancelled", "failed"] });
  const waitingForReview = createAlbum({ tracks: ["blocked", "available"] });
  const withoutMbid = createAlbum({ withMbid: false });
  const underUnmonitoredArtist = createAlbum({ artistMode: "none" });

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 2);
  assert.equal(albumJobs(underUnmonitoredArtist.albumMbid).length, 1);
  assert.deepEqual(
    albumJobs(singleFromPlaylist.albumMbid).map((job) => job.trackMbid),
    [singleFromPlaylist.tracks[0].mbid],
  );
  for (const skipped of [
    unmonitored,
    scannedNotRequested,
    lidarrManaged,
    downloading,
    cancelledByUser,
    waitingForReview,
    withoutMbid,
  ]) {
    assert.equal(searchTime(skipped.album.id), null);
  }
  assert.equal(albumJobs(unmonitored.albumMbid).length, 0);
  assert.equal(albumJobs(scannedNotRequested.albumMbid).length, 0);
  assert.equal(albumJobs(lidarrManaged.albumMbid).length, 0);
  assert.equal(albumJobs(downloading.albumMbid).length, 1);
  assert.deepEqual(
    albumJobs(cancelledByUser.albumMbid)
      .map((job) => job.status)
      .sort(),
    ["cancelled", "failed"],
  );
  assert.deepEqual(
    albumJobs(waitingForReview.albumMbid).map((job) => job.status),
    ["blocked"],
  );
  assert.equal(
    downloadTracker.getAll().some((job) => job.albumMbid == null),
    false,
  );
  assert.deepEqual([...lidarrCalls], []);
});

test("a track whose only file belongs to another album still counts as missing", async () => {
  const needsTrack = createAlbum({ tracks: ["missing"] });
  const otherAlbum = createAlbum({ tracks: ["available"] });
  const sharedTrack = needsTrack.tracks[0];
  libraryStore.linkLibraryAlbumTrack({
    albumId: otherAlbum.album.id,
    trackId: sharedTrack.id,
    trackNumber: 2,
  });
  libraryStore.upsertLibraryMediaFile({
    scanId: undefined,
    trackId: sharedTrack.id,
    albumId: otherAlbum.album.id,
    source: "aurral",
    path: path.join(isolatedState.dataDir, "shared", "single.flac"),
  });

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(albumJobs(needsTrack.albumMbid).length, 1);
  assert.equal(albumJobs(otherAlbum.albumMbid).length, 0);
});

test("an album is searched even when its artist row id matches another artist's name", async () => {
  const { artist, albumMbid } = createAlbum();
  libraryStore.upsertLibraryArtist({
    identityKey: "name:artist-id-collision",
    name: String(artist.id),
  });

  assert.equal(await runMissingTrackSearch(), 1);
  assert.equal(albumJobs(albumMbid).length, 1);
});

test("the search skips an unmonitored track and still queues the album's other missing tracks", async () => {
  const { albumMbid, tracks, jobIds } = createAlbum({ tracks: ["missing", "failed", "missing"] });
  setTrackMonitored(tracks[0].id, false);

  assert.equal(await runMissingTrackSearch(), 1);

  assert.equal(
    albumJobs(albumMbid).some((job) => job.trackMbid === tracks[0].mbid),
    false,
  );
  assert.equal(getJob(jobIds[1]).status, "pending");
  assert.equal(
    albumJobs(albumMbid).find((job) => job.trackMbid === tracks[2].mbid)?.status,
    "pending",
  );
});

test("an album whose only missing tracks are unmonitored is not due", async () => {
  const { album, albumMbid, tracks } = createAlbum({ tracks: ["missing", "available"] });
  setTrackMonitored(tracks[0].id, false);

  assert.equal(await runMissingTrackSearch(), 0);
  assert.equal(albumJobs(albumMbid).length, 0);
  assert.equal(searchTime(album.id), null);
});

test("Retry skips unmonitored tracks, and turning an album back on monitors all of its tracks", async () => {
  const retried = createAlbum({ tracks: ["missing", "missing"] });
  setTrackMonitored(retried.tracks[0].id, false);
  await libraryManager.addAlbum(
    retried.artist.id,
    requireFixture(retried.albumMbid),
    retried.album.title,
    {
      managedBy: "aurral",
    },
  );
  assert.deepEqual(
    albumJobs(retried.albumMbid).map((job) => job.trackMbid),
    [retried.tracks[1].mbid],
  );

  const toggled = createAlbum({ tracks: ["missing", "missing"] });
  setTrackMonitored(toggled.tracks[1].id, false);
  await libraryManager.setAurralAlbumMonitoring(toggled.album.id, { monitored: false });
  await libraryManager.setAurralAlbumMonitoring(toggled.album.id, { monitored: true });
  assert.deepEqual(
    albumJobs(toggled.albumMbid)
      .map((job) => job.trackMbid)
      .sort(),
    toggled.tracks.map((track) => track.mbid).sort(),
  );
  assert.deepEqual(
    toggled.tracks.map((track) => trackMonitored(track.id)),
    [1, 1],
  );
});

test("a library rescan keeps a track unmonitored, and the Library reports it", () => {
  const { album, artist, tracks } = createAlbum({ tracks: ["missing", "missing"] });
  setTrackMonitored(tracks[0].id, false);

  libraryStore.upsertLibraryTrack({
    identityKey: `recording:${tracks[0].mbid}`,
    mbid: tracks[0].mbid,
    title: tracks[0].title,
    artistName: artist.name,
    metadata: { rescanned: true },
  });

  const library = getLibraryForAlbumIds({ ids: [album.id] });
  const monitoredById = new Map(library.tracks.map((track) => [track.id, track.monitored]));
  assert.equal(monitoredById.get(tracks[0].id), false);
  assert.equal(monitoredById.get(tracks[1].id), true);
});

test("scanning an album's downloaded file keeps the album monitored and searched", async () => {
  const { artist, album, albumMbid, tracks } = createAlbum({ tracks: ["missing", "missing"] });
  const root = path.join(isolatedState.dataDir, `scan-${album.id}`);
  const filePath = path.join(root, artist.name, album.title, "01 Track 1.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");

  await scanMusicRoot({
    rootPath: root,
    source: "aurral",
    filePaths: [filePath],
    metadataReader: async () => ({
      common: {
        albumartist: artist.name,
        artist: artist.name,
        album: album.title,
        title: tracks[0].title,
        track: { no: 1, of: 2 },
        musicbrainz_albumartistid: artist.mbid ? [artist.mbid] : [],
        musicbrainz_releasegroupid: albumMbid ?? undefined,
        musicbrainz_recordingid: tracks[0].mbid ?? undefined,
      },
      format: {},
    }),
  });

  assert.equal(await runMissingTrackSearch(), 1);
  assert.deepEqual(
    albumJobs(albumMbid).map((job) => job.trackMbid),
    [tracks[1].mbid],
  );
  assert.equal(getLibraryForAlbumIds({ ids: [album.id] }).albums[0].monitored, true);
});

test("searching an album leaves cancelled tracks alone, including an older cancelled job", async () => {
  const { artist, album, albumMbid, tracks, jobIds } = createAlbum({
    tracks: ["cancelled", "missing", "missing"],
  });
  const secondTrack = { artist, album, albumMbid, track: tracks[1], trackMbid: tracks[1].mbid };
  const olderCancelled = atTime(Date.now() - 5 * DAY_MS, () =>
    addTrackJob({ ...secondTrack, state: "cancelled" }),
  );
  const newerFailed = addTrackJob({ ...secondTrack, state: "failed" });

  const result = await libraryManager.searchAurralAlbumMissingTracks(album.id);

  assert.equal(getJob(jobIds[0]).status, "cancelled");
  assert.equal(getJob(olderCancelled).status, "cancelled");
  assert.equal(getJob(newerFailed).status, "pending");
  assert.equal(
    albumJobs(albumMbid).find((job) => job.trackMbid === tracks[2].mbid)?.status,
    "pending",
  );
  assert.equal(result.queuedTrackCount, 2);
});

test("searching an album after it was unmonitored queues nothing", async () => {
  const { album, albumMbid, jobIds } = createAlbum({ tracks: ["failed", "missing"] });
  await libraryManager.setAurralAlbumMonitoring(album.id, { monitored: false });

  await libraryManager.searchAurralAlbumMissingTracks(album.id);

  assert.equal(getJob(jobIds[0]).status, "failed");
  assert.equal(albumJobs(albumMbid).length, 1);
});

test("the stored interval and switch control the run", async () => {
  const settings = dbOps.getSettings();
  const withinInterval = createAlbum({ lastSearchedAt: Date.now() - 2 * DAY_MS });
  const pastInterval = createAlbum({ lastSearchedAt: Date.now() - 4 * DAY_MS });
  try {
    dbOps.updateSettings({ ...settings, missingTrackSearch: { enabled: false, intervalDays: 3 } });
    assert.equal(await runMissingTrackSearch(), 0);
    assert.equal(albumJobs(pastInterval.albumMbid).length, 0);

    dbOps.updateSettings({ ...settings, missingTrackSearch: { enabled: true, intervalDays: 3 } });
    assert.equal(await runMissingTrackSearch(), 1);
    assert.equal(albumJobs(withinInterval.albumMbid).length, 0);
    assert.equal(albumJobs(pastInterval.albumMbid).length, 1);
  } finally {
    dbOps.updateSettings(settings);
  }
});

test("a fresh install does not search until the search is turned on", async () => {
  const { album, albumMbid } = createAlbum();
  const settings = dbOps.getSettings();
  db.prepare("DELETE FROM settings WHERE key = 'missingTrackSearch'").run();
  dbOps.invalidateSettingsCache();
  try {
    assert.equal(await runMissingTrackSearch(), 0);
  } finally {
    dbOps.updateSettings(settings);
  }

  assert.equal(albumJobs(albumMbid).length, 0);
  assert.equal(searchTime(album.id), null);
});

test("without a download source nothing is queued or marked as searched", async () => {
  const { album, albumMbid } = createAlbum();
  setDownloadSourceConfigured(false);
  try {
    assert.equal(await runMissingTrackSearch(), 0);
  } finally {
    setDownloadSourceConfigured(true);
  }

  assert.equal(albumJobs(albumMbid).length, 0);
  assert.equal(searchTime(album.id), null);
});

test("the scheduled system task searches due albums", async () => {
  const scheduled = SCHEDULED_SYSTEM_TASKS.find(
    (task) => task.payload?.kind === "aurral-missing-track-search",
  );
  assert.ok(scheduled, "the missing-track search has a schedule");
  const { albumMbid } = createAlbum({ tracks: ["failed", "missing"] });

  await processSystemTask(v.parse(systemTaskSchema, scheduled.payload));

  assert.deepEqual(
    albumJobs(albumMbid).map((job) => job.status),
    ["pending", "pending"],
  );
  assert.deepEqual([...lidarrCalls], []);
});

function getJob(id: Parameters<typeof downloadTracker.getJob>[0]) {
  const job = downloadTracker.getJob(id);
  assert.ok(job, `Expected download job ${id}`);
  return job;
}
