import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
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
  { requestLibraryTrack },
] = await setupIsolatedBackend(
  "aurral-track-monitoring",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/libraryMediaStore.ts",
  "backend/services/libraryManagementStore.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/downloadJobs/downloadWorker.ts",
  "backend/services/lidarrClient.ts",
  "backend/services/libraryManager.ts",
  "backend/services/libraryTrackRequests.ts",
);

const lidarrCalls = [];
let sequence = 0;

async function createAlbum({ managedBy = "aurral", monitored = true, tracks = ["missing"] } = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const artistMbid = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  const albumMbid = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: `Monitoring Artist ${sequence}`,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Monitoring Album ${sequence}`,
    metadata: { monitored },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy,
    monitorMode: monitored ? null : "unmonitored",
  });
  const jobIds = [];
  const filePaths = [];
  const albumTracks = [];
  for (const [index, state] of tracks.entries()) {
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
      const filePath = path.join(isolatedState.dataDir, `album-${sequence}`, `${index + 1}.flac`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "audio");
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: managedBy,
        path: filePath,
      });
      filePaths[index] = filePath;
    } else if (state === "pending") {
      jobIds[index] = downloadTracker.addJob(
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
    }
    albumTracks.push({ ...track, mbid: trackMbid });
  }
  return { artist, album, albumMbid, tracks: albumTracks, jobIds, filePaths };
}

const trackMonitored = (trackId) =>
  db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(trackId)?.monitored;

const albumJobs = (albumMbid) =>
  downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);

const originalSettings = dbOps.getSettings();
const originalLidarr = {
  isConfigured: lidarrClient.isConfigured,
  request: lidarrClient.request,
  getArtist: lidarrClient.getArtist,
  getArtistByMbid: lidarrClient.getArtistByMbid,
};
const originalWorkerStart = downloadWorker.start;

beforeAll(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    },
  });
  lidarrClient.isConfigured = () => false;
  for (const method of ["request", "getArtist", "getArtistByMbid"]) {
    lidarrClient[method] = async (...args) => {
      lidarrCalls.push([method, ...args]);
      throw new Error("Lidarr must not be called");
    };
  }
  downloadWorker.start = async () => {};
});

beforeEach(() => {
  downloadTracker.clearAll();
  lidarrCalls.length = 0;
});

afterAll(async () => {
  Object.assign(lidarrClient, originalLidarr);
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await cleanupIsolatedState(isolatedState);
});

test("unmonitoring a track cancels its unfinished download and keeps finished files", async () => {
  const { tracks, jobIds, filePaths } = await createAlbum({ tracks: ["available", "pending"] });

  const downloading = await libraryManager.setAurralTrackMonitoring(tracks[1].id, {
    monitored: false,
  });
  const finished = await libraryManager.setAurralTrackMonitoring(tracks[0].id, {
    monitored: false,
  });

  assert.equal(downloading.monitored, false);
  assert.equal(trackMonitored(tracks[1].id), 0);
  assert.equal(downloadTracker.getJob(jobIds[1]).status, "cancelled");
  assert.equal(finished.monitored, false);
  assert.equal(await fs.readFile(filePaths[0], "utf8"), "audio");
});

test("monitoring a track again fetches only that track when its album is monitored", async () => {
  const { albumMbid, tracks } = await createAlbum({ tracks: ["missing", "missing"] });
  await libraryManager.setAurralTrackMonitoring(tracks[0].id, { monitored: false });

  const result = await libraryManager.setAurralTrackMonitoring(tracks[0].id, { monitored: true });

  assert.equal(result.monitored, true);
  assert.deepEqual(
    albumJobs(albumMbid).map((job) => [job.trackMbid, job.status]),
    [[tracks[0].mbid, "pending"]],
  );
});

test("monitoring a track in an unmonitored album queues only that track", async () => {
  const { album, albumMbid, tracks } = await createAlbum({ tracks: ["missing", "missing"] });
  await libraryManager.setAurralAlbumMonitoring(album.id, { monitored: false });

  const result = await libraryManager.setAurralTrackMonitoring(tracks[0].id, { monitored: true });

  assert.equal(result.monitored, true);
  assert.deepEqual(
    tracks.map((track) => trackMonitored(track.id)),
    [1, 0],
  );
  assert.deepEqual(
    albumJobs(albumMbid).map((job) => [job.trackMbid, job.status]),
    [[tracks[0].mbid, "pending"]],
  );
});

test("a track unmonitored while its album is turned back on is not queued", async () => {
  const { album, albumMbid, tracks } = await createAlbum({
    monitored: false,
    tracks: ["missing", "missing"],
  });
  const missingFileJob = downloadTracker.addJob(
    {
      artistName: "Monitoring Artist",
      trackName: tracks[0].title,
      albumName: album.title,
      albumMbid,
      trackMbid: tracks[0].mbid,
      managedBy: "aurral",
    },
    "library",
  );
  downloadTracker.setDone(
    missingFileJob,
    path.join(isolatedState.dataDir, "gone", "1.flac"),
    album.title,
  );

  const monitoring = libraryManager.setAurralAlbumMonitoring(album.id, { monitored: true });
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  db.prepare("UPDATE library_tracks SET monitored = 0 WHERE id = ?").run(tracks[1].id);
  await monitoring;

  assert.equal(
    albumJobs(albumMbid).some((job) => job.trackMbid === tracks[1].mbid),
    false,
  );
});

test("one track asked for is a track request, asking for the album's missing tracks makes every queued one an album request, and a failed one asked for alone is a track request again", async () => {
  const { album, tracks } = await createAlbum({ tracks: ["missing", "missing", "missing"] });
  const requestKinds = () =>
    Object.fromEntries(
      db
        .prepare(
          "SELECT track_mbid, request_kind FROM playlist_download_jobs WHERE track_mbid IN (?, ?, ?)",
        )
        .all(...tracks.map((track) => track.mbid))
        .map((row) => [row.track_mbid.slice(-2), row.request_kind]),
    );

  const single = await libraryManager.monitorAurralTrack({ canonicalTrackId: tracks[0].id });
  assert.equal(single.queuedJobIds.length, 1);
  assert.deepEqual(requestKinds(), { "00": "track" });

  await libraryManager.searchAurralAlbumMissingTracks(album.id);
  assert.deepEqual(requestKinds(), { "00": "album", "01": "album", "02": "album" });

  const second = downloadTracker.getAll().find((job) => job.trackMbid === tracks[1].mbid);
  downloadTracker.setFailed(second.id, "No source had the track");
  const retried = await libraryManager.monitorAurralTrack({ canonicalTrackId: tracks[1].id });
  assert.deepEqual(retried.queuedJobIds, [second.id]);
  assert.deepEqual(requestKinds(), { "00": "album", "01": "track", "02": "album" });
});

test("unmonitoring a track without an MBID leaves a same-titled track's download alone", async () => {
  const { album, albumMbid, tracks, jobIds } = await createAlbum({
    tracks: ["missing", "pending"],
  });
  const untagged = libraryStore.upsertLibraryTrack({
    identityKey: `track:untagged-${album.id}`,
    title: tracks[1].title,
    artistName: "Monitoring Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: untagged.id, trackNumber: 3 });

  await libraryManager.setAurralTrackMonitoring(untagged.id, { monitored: false });

  assert.equal(downloadTracker.getJob(jobIds[1]).status, "pending");
  assert.equal(albumJobs(albumMbid).filter((job) => job.status === "cancelled").length, 0);
});

test("a track in a Lidarr album is unmonitored by Aurral without calling Lidarr", async () => {
  const { artist, tracks, jobIds } = await createAlbum({
    managedBy: "lidarr",
    tracks: ["pending"],
  });
  libraryStore.upsertLibraryTrack({
    identityKey: tracks[0].identity_key,
    mbid: tracks[0].mbid,
    title: tracks[0].title,
    artistName: `${artist.name} feat. Guest`,
  });
  const ownerJob = downloadTracker.addJob(
    { artistName: artist.name, trackName: tracks[0].title },
    "library",
  );
  const otherArtistJob = downloadTracker.addJob(
    { artistName: "Another Artist", trackName: tracks[0].title },
    "library",
  );

  const result = await libraryManager.setAurralTrackMonitoring(tracks[0].id, { monitored: false });

  assert.equal(result.error, undefined);
  assert.equal(trackMonitored(tracks[0].id), 0);
  assert.equal(downloadTracker.getJob(jobIds[0]).status, "cancelled");
  assert.equal(downloadTracker.getJob(ownerJob).status, "cancelled");
  assert.equal(downloadTracker.getJob(otherArtistJob).status, "pending");
  assert.deepEqual(lidarrCalls, []);
});

test("downloading a missing track in a Lidarr album leaves the download to the track route", async () => {
  const { tracks } = await createAlbum({ managedBy: "lidarr", tracks: ["missing"] });

  const result = await libraryManager.monitorAurralTrack({ canonicalTrackId: tracks[0].id });

  assert.equal(result, null);
  assert.equal(trackMonitored(tracks[0].id), 1);
  assert.deepEqual(lidarrCalls, []);
});

test("requesting a guest track retains canonical album ownership for acquisition", async () => {
  const { artist, album, albumMbid, tracks } = await createAlbum();
  const track = tracks[0];
  libraryStore.upsertLibraryTrack({
    identityKey: track.identity_key,
    mbid: track.mbid,
    title: track.title,
    artistName: "Guest & Owner",
  });

  const result = await requestLibraryTrack(
    {
      artistName: "Guest & Owner",
      artistMbid: null,
      trackName: track.title,
      albumName: album.title,
      albumMbid,
      trackMbid: track.mbid,
    },
    { canonicalTrackId: track.id },
  );

  assert.equal(result.monitored, true);
  const job = downloadTracker.getJob(result.jobId);
  assert.equal(job.artistName, artist.name);
  assert.equal(job.artistMbid, artist.mbid);
  assert.equal(job.albumMbid, albumMbid);
  assert.equal(job.trackMbid, track.mbid);
});

test("a Lidarr track request keeps the album owner's identity on its fallback job", async () => {
  const { artist, album, albumMbid, tracks } = await createAlbum({ managedBy: "lidarr" });
  const track = tracks[0];
  libraryStore.upsertLibraryTrack({
    identityKey: track.identity_key,
    mbid: track.mbid,
    title: track.title,
    artistName: "Guest & Owner",
  });

  const result = await requestLibraryTrack(
    {
      artistName: artist.name,
      artistMbid: artist.mbid,
      trackName: track.title,
      albumName: album.title,
      albumMbid,
      trackMbid: track.mbid,
    },
    { canonicalTrackId: track.id },
  );

  assert.equal(result.queued, true);
  assert.equal(result.monitored, undefined);
  const job = downloadTracker.getJob(result.jobId);
  assert.equal(job.artistName, artist.name);
  assert.equal(job.artistMbid, artist.mbid);
  assert.equal(job.albumMbid, albumMbid);
  assert.equal(job.trackMbid, track.mbid);
  assert.deepEqual(lidarrCalls, []);
});
