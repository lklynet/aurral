import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { downloadTracker },
  cancellation,
  libraryStore,
  managementStore,
  { registerAlbums },
  { lidarrClient },
  { dbOps },
  { db },
  { registerArtists },
  { libraryManager },
  { resolveDownloadRoot },
] = await setupIsolatedBackend(
  "aurral-library-removal",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadCancellation.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/routes/library/handlers/albums.js",
  "backend/services/lidarrClient.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
  "backend/routes/library/handlers/artists.js",
  "backend/services/libraryManager.js",
  "backend/services/downloadPaths.js",
);

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
const router = { get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") };
registerAlbums(router);
registerArtists(router);

const removeAlbum = (album, deleteFiles) =>
  callRoute("DELETE /albums/aurral/:canonicalId", { canonicalId: String(album.id) }, deleteFiles);
const removeArtist = (artist, deleteFiles) =>
  callRoute("DELETE /artists/:mbid", { mbid: artist.mbid }, deleteFiles);

async function callRoute(key, params, deleteFiles) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    {
      params,
      query: { deleteFiles: String(deleteFiles) },
      user: { role: "admin", permissions: {} },
    },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
    },
  );
  return response;
}

let sequence = 0;
async function createAurralAlbum({ trackCount = 2, filesFor = [0, 1], artist: existingArtist = null } = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const artistMbid = `eeeeeeee-eeee-4eee-8eee-${suffix}`;
  const albumMbid = `ffffffff-ffff-4fff-8fff-${suffix}`;
  const artist = existingArtist || libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: `Removal Artist ${sequence}`,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Removal Album ${sequence}`,
  });
  const albumDir = path.join(resolveDownloadRoot(), `album-${sequence}`);
  await fs.mkdir(albumDir, { recursive: true });
  const tracks = [];
  for (let index = 0; index < trackCount; index += 1) {
    const trackMbid = `abababab-abab-4bab-8bab-${suffix.slice(2)}${String(index).padStart(2, "0")}`;
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `recording:${trackMbid}`,
      mbid: trackMbid,
      title: `Track ${index + 1}`,
      artistName: artist.name,
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    let filePath = null;
    if (filesFor.includes(index)) {
      filePath = path.join(albumDir, `${index + 1}.flac`);
      await fs.writeFile(filePath, `audio ${index + 1}`);
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "aurral",
        path: filePath,
        available: true,
      });
    }
    tracks.push({ ...track, trackMbid, filePath });
  }
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const jobFor = (index) =>
    downloadTracker.addJob(
      {
        artistName: artist.name,
        trackName: tracks[index].title,
        albumName: album.title,
        albumMbid,
        trackMbid: tracks[index].trackMbid,
        managedBy: "aurral",
      },
      "library",
    );
  return { artist, album, tracks, jobFor };
}

const artistRow = (id) => db.prepare("SELECT 1 FROM library_artists WHERE id = ?").get(id);
const albumRow = (id) => db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(id);
const trackRow = (id) => db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(id);
const exists = (filePath) => fs.access(filePath).then(() => true, () => false);

function useFailingSlskd() {
  const originalSettings = dbOps.getSettings();
  const provider = { status: 503 };
  const serverReady = createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(provider.status);
    response.end();
  }).then((server) => {
    dbOps.updateSettings({
      ...originalSettings,
      integrations: {
        ...(originalSettings.integrations || {}),
        slskd: { enabled: true, url: server.url, apiKey: "test-key" },
      },
    });
    provider.close = async () => {
      dbOps.updateSettings(originalSettings);
      await server.close();
    };
    return provider;
  });
  return serverReady;
}

function registerSlskdSearch(jobId) {
  const workId = `search-removal-${jobId}`;
  cancellation.registerDownloadProviderWork({
    jobId,
    playlistId: "library",
    provider: "slskd-search",
    workId,
  });
  return () => cancellation.clearDownloadProviderWork({ provider: "slskd-search", workId });
}

let lidarrCalls;
let originalRequest;
test.beforeEach(() => {
  downloadTracker.clearAll();
  lidarrCalls = [];
  originalRequest = lidarrClient.request;
  lidarrClient.request = async (...args) => {
    lidarrCalls.push(args);
    throw new Error("Lidarr must not be called");
  };
});

test.afterEach(() => {
  lidarrClient.request = originalRequest;
  assert.equal(lidarrCalls.length, 0);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("removing an Aurral album without files keeps them on disk and clears its state", async () => {
  const { album, tracks, jobFor } = await createAurralAlbum({ trackCount: 3, filesFor: [0, 1] });
  const pendingJob = jobFor(2);

  const response = await removeAlbum(album, false);

  assert.equal(response.statusCode, 200);
  assert.equal(albumRow(album.id), undefined);
  for (const track of tracks) assert.equal(trackRow(track.id), undefined);
  assert.equal(await exists(tracks[0].filePath), true);
  assert.equal(await exists(tracks[1].filePath), true);
  assert.equal(downloadTracker.getJob(pendingJob), null);
  assert.equal(managementStore.getLibraryManagementEntry("album", album.id), null);
});

test("removing an Aurral album with files deletes only its own unshared files", async () => {
  const { artist, album, tracks, jobFor } = await createAurralAlbum();
  const other = await createAurralAlbum({ trackCount: 1, filesFor: [0] });
  const libraryJob = jobFor(0);
  downloadTracker.setDone(libraryJob, tracks[0].filePath, album.title);
  const playlistJob = downloadTracker.addJob(
    { artistName: artist.name, trackName: tracks[1].title, trackMbid: tracks[1].trackMbid },
    "shared-playlist",
  );
  downloadTracker.setDone(playlistJob, tracks[1].filePath, album.title);

  const response = await removeAlbum(album, true);

  assert.equal(response.statusCode, 200);
  assert.equal(await exists(tracks[0].filePath), false);
  assert.equal(await exists(tracks[1].filePath), true);
  assert.equal(downloadTracker.getJob(playlistJob)?.finalPath, tracks[1].filePath);
  assert.equal(await exists(other.tracks[0].filePath), true);
  assert.notEqual(albumRow(other.album.id), undefined);
  assert.equal(albumRow(album.id), undefined);
});

test("removing a mixed album keeps the Lidarr file, its track, and the album", async () => {
  const { album, tracks } = await createAurralAlbum();
  const lidarrPath = path.join(isolatedState.dataDir, "lidarr-root", `mixed-${album.id}.flac`);
  libraryStore.upsertLibraryMediaFile({
    trackId: tracks[1].id,
    albumId: album.id,
    source: "lidarr",
    path: lidarrPath,
    available: true,
  });

  const response = await removeAlbum(album, true);

  assert.equal(response.statusCode, 200);
  assert.equal(await exists(tracks[0].filePath), false);
  assert.equal(await exists(tracks[1].filePath), false);
  assert.equal(trackRow(tracks[0].id), undefined);
  assert.notEqual(trackRow(tracks[1].id), undefined);
  assert.notEqual(albumRow(album.id), undefined);
  assert.equal(
    db.prepare("SELECT available FROM library_media_files WHERE source = ? AND path = ?")
      .get("lidarr", lidarrPath)?.available,
    1,
  );
  assert.equal(managementStore.getLibraryManagementEntry("album", album.id), null);
});

test("album removal stops before changing anything when downloads cannot be cancelled", async () => {
  const provider = await useFailingSlskd();
  const { album, tracks, jobFor } = await createAurralAlbum();
  const jobId = jobFor(1);
  const clearSearch = registerSlskdSearch(jobId);

  try {
    const failed = await removeAlbum(album, true);
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.code, "download_cancellation_failed");
    assert.notEqual(albumRow(album.id), undefined);
    assert.equal(await exists(tracks[0].filePath), true);
    assert.notEqual(downloadTracker.getJob(jobId), null);
    assert.equal(managementStore.getLibraryManagementEntry("album", album.id)?.managedBy, "aurral");

    provider.status = 204;
    const retried = await removeAlbum(album, true);
    assert.equal(retried.statusCode, 200);
    assert.equal(albumRow(album.id), undefined);
    assert.equal(await exists(tracks[0].filePath), false);
  } finally {
    clearSearch();
    await provider.close();
  }
});

test("album removal is refused while Aurral monitors the artist, and Lidarr albums are refused", async () => {
  const { artist, album, tracks } = await createAurralAlbum();
  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    managedBy: "aurral",
    monitorMode: "all",
  });

  const monitored = await removeAlbum(album, true);
  assert.equal(monitored.statusCode, 409);
  assert.equal(monitored.body.code, "artist_monitored");
  assert.notEqual(albumRow(album.id), undefined);
  assert.equal(await exists(tracks[0].filePath), true);

  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    managedBy: "aurral",
    monitorMode: "none",
  });
  assert.equal((await removeAlbum(album, false)).statusCode, 200);

  const lidarr = await createAurralAlbum({ trackCount: 1 });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: lidarr.album.id, managedBy: "lidarr" });
  const conflict = await removeAlbum(lidarr.album, true);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "album_owner_conflict");
  assert.equal(await exists(lidarr.tracks[0].filePath), true);
  assert.notEqual(albumRow(lidarr.album.id), undefined);
});

function makeMonitoredArtist(artist, monitorMode = "all") {
  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    managedBy: "aurral",
    monitorMode,
  });
}

test("removing a monitored Aurral artist clears its albums, files, and monitoring", async (t) => {
  const first = await createAurralAlbum();
  const second = await createAurralAlbum({ trackCount: 2, filesFor: [0], artist: first.artist });
  makeMonitoredArtist(first.artist);
  const pendingJob = second.jobFor(1);

  const response = await removeArtist(first.artist, true);

  assert.equal(response.statusCode, 200);
  assert.equal(artistRow(first.artist.id), undefined);
  for (const { album, tracks } of [first, second]) {
    assert.equal(albumRow(album.id), undefined);
    assert.equal(managementStore.getLibraryManagementEntry("album", album.id), null);
    for (const track of tracks) {
      assert.equal(trackRow(track.id), undefined);
      if (track.filePath) assert.equal(await exists(track.filePath), false);
    }
  }
  assert.equal(downloadTracker.getJob(pendingJob), null);
  assert.equal(managementStore.getLibraryManagementEntry("artist", first.artist.id), null);

  const planned = [];
  t.mock.method(libraryManager, "planAurralArtistMonitoring", async (artist) => {
    planned.push(artist.mbid);
    return { releases: [] };
  });
  await libraryManager.reconcileAurralMonitoring();
  assert.equal(planned.includes(first.artist.mbid), false);
});

test("removing an Aurral artist without files keeps them on disk", async () => {
  const { artist, album, tracks } = await createAurralAlbum();
  makeMonitoredArtist(artist, "none");

  const response = await removeArtist(artist, false);

  assert.equal(response.statusCode, 200);
  assert.equal(artistRow(artist.id), undefined);
  assert.equal(albumRow(album.id), undefined);
  assert.equal(await exists(tracks[0].filePath), true);
  assert.equal(await exists(tracks[1].filePath), true);
});

test("a failed artist removal stops monitoring and finishes on retry", async () => {
  const provider = await useFailingSlskd();
  const first = await createAurralAlbum();
  const second = await createAurralAlbum({ artist: first.artist });
  makeMonitoredArtist(first.artist);
  const blockedJob = second.jobFor(0);
  const clearSearch = registerSlskdSearch(blockedJob);

  try {
    const failed = await removeArtist(first.artist, true);
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.code, "download_cancellation_failed");
    assert.notEqual(artistRow(first.artist.id), undefined);
    assert.notEqual(albumRow(second.album.id), undefined);
    assert.equal(await exists(second.tracks[0].filePath), true);
    const artistState = managementStore.getLibraryManagementEntry("artist", first.artist.id);
    assert.equal(artistState?.managedBy, "aurral");
    assert.equal(artistState?.monitorMode, "none");

    provider.status = 204;
    const retried = await removeArtist(first.artist, true);
    assert.equal(retried.statusCode, 200);
    assert.equal(artistRow(first.artist.id), undefined);
    assert.equal(albumRow(first.album.id), undefined);
    assert.equal(albumRow(second.album.id), undefined);
    assert.equal(await exists(second.tracks[0].filePath), false);
  } finally {
    clearSearch();
    await provider.close();
  }
});

test("deleting a Lidarr artist also deletes its Aurral albums and their files", async (t) => {
  const { artist, album, tracks } = await createAurralAlbum();
  managementStore.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "lidarr" });
  const deleted = [];
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getArtistByMbid", async (mbid) => ({
    id: 41,
    foreignArtistId: mbid,
    artistName: artist.name,
  }));
  t.mock.method(lidarrClient, "deleteArtist", async (id, deleteFiles) => {
    deleted.push({ id, deleteFiles });
  });

  const response = await removeArtist(artist, true);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(deleted, [{ id: 41, deleteFiles: true }]);
  assert.equal(managementStore.getLibraryManagementEntry("album", album.id), null);
  assert.equal(await exists(tracks[0].filePath), false);
});

test("album removal keeps downloads that belong to Lidarr or to another album", async () => {
  const { artist, album, tracks, jobFor } = await createAurralAlbum();
  const ownJob = jobFor(0);
  const otherAlbumJob = downloadTracker.addJob(
    {
      artistName: artist.name,
      trackName: tracks[0].title,
      albumName: "Compilation",
      albumMbid: "12121212-1212-4212-8212-121212121212",
      trackMbid: tracks[0].trackMbid,
      managedBy: "aurral",
    },
    "library",
  );
  const lidarrJob = downloadTracker.addJob(
    {
      artistName: artist.name,
      trackName: tracks[1].title,
      trackMbid: tracks[1].trackMbid,
      managedBy: "lidarr",
    },
    "library",
  );

  const response = await removeAlbum(album, false);

  assert.equal(response.statusCode, 200);
  assert.equal(downloadTracker.getJob(ownJob), null);
  assert.notEqual(downloadTracker.getJob(otherAlbumJob), null);
  assert.notEqual(downloadTracker.getJob(lidarrJob), null);
});

test("album removal never deletes a file Lidarr also lists as available", async () => {
  const { album, tracks } = await createAurralAlbum();
  libraryStore.upsertLibraryMediaFile({
    trackId: tracks[0].id,
    albumId: album.id,
    source: "lidarr",
    path: tracks[0].filePath,
    available: true,
  });

  const response = await removeAlbum(album, true);

  assert.equal(response.statusCode, 200);
  assert.equal(await exists(tracks[0].filePath), true);
  assert.equal(await exists(tracks[1].filePath), false);
  assert.equal(
    db.prepare("SELECT available FROM library_media_files WHERE source = ? AND path = ?")
      .get("lidarr", tracks[0].filePath)?.available,
    1,
  );
});

test("album removal never deletes a reused file outside the Downloads Folder", async () => {
  const { album, tracks, jobFor } = await createAurralAlbum({ trackCount: 2, filesFor: [1] });
  const lidarrPath = path.join(isolatedState.baseDir, "music", `reused-${album.id}.flac`);
  await fs.mkdir(path.dirname(lidarrPath), { recursive: true });
  await fs.writeFile(lidarrPath, "lidarr audio");
  const reusedJob = jobFor(0);
  downloadTracker.setDone(reusedJob, lidarrPath, album.title, lidarrPath);

  const response = await removeAlbum(album, true);

  assert.equal(response.statusCode, 200);
  assert.equal(await exists(lidarrPath), true);
  assert.equal(await exists(tracks[1].filePath), false);
  assert.equal(albumRow(album.id), undefined);
});
