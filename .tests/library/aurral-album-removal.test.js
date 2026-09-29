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
] = await setupIsolatedBackend(
  "aurral-album-removal",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/routes/library/handlers/albums.js",
  "backend/services/lidarrClient.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
);

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
registerAlbums({ get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") });

async function removeAlbum(album, deleteFiles) {
  const response = { statusCode: 200, body: null };
  await routes.get("DELETE /albums/aurral/:canonicalId")(
    {
      params: { canonicalId: String(album.id) },
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
async function createAurralAlbum({ trackCount = 2, filesFor = [0, 1] } = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const artistMbid = `eeeeeeee-eeee-4eee-8eee-${suffix}`;
  const albumMbid = `ffffffff-ffff-4fff-8fff-${suffix}`;
  const artist = libraryStore.upsertLibraryArtist({
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
  const albumDir = path.join(isolatedState.dataDir, "aurral-root", `album-${sequence}`);
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

const albumRow = (id) => db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(id);
const trackRow = (id) => db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(id);
const exists = (filePath) => fs.access(filePath).then(() => true, () => false);

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
  const originalSettings = dbOps.getSettings();
  let providerStatus = 503;
  const provider = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(providerStatus);
    response.end();
  });
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: provider.url, apiKey: "test-key" },
    },
  });
  const { album, tracks, jobFor } = await createAurralAlbum();
  const jobId = jobFor(1);
  const searchId = `search-album-removal-${jobId}`;
  cancellation.registerDownloadProviderWork({
    jobId,
    playlistId: "library",
    provider: "slskd-search",
    workId: searchId,
  });

  try {
    const failed = await removeAlbum(album, true);
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.code, "download_cancellation_failed");
    assert.notEqual(albumRow(album.id), undefined);
    assert.equal(await exists(tracks[0].filePath), true);
    assert.notEqual(downloadTracker.getJob(jobId), null);
    assert.equal(managementStore.getLibraryManagementEntry("album", album.id)?.managedBy, "aurral");

    providerStatus = 204;
    const retried = await removeAlbum(album, true);
    assert.equal(retried.statusCode, 200);
    assert.equal(albumRow(album.id), undefined);
    assert.equal(await exists(tracks[0].filePath), false);
  } finally {
    dbOps.updateSettings(originalSettings);
    cancellation.clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
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
