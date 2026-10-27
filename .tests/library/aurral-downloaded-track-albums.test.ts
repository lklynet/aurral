import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

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
  { scanMusicRoot },
  { clearMetadataProviderCaches },
  { api },
] = await setupIsolatedBackend(
  "aurral-downloaded-track-albums",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

const postJson = (path: string, body: Record<string, unknown>) =>
  app.request(`/library${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const artistMbid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const albumMbid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const trackMbids = [
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
];
const musicRoot = path.join(isolatedState.dataDir, "music");

const metadataServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname !== `/album/${albumMbid}`) {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  response.end(
    JSON.stringify({
      id: albumMbid,
      title: "Playlist Album",
      artistid: artistMbid,
      artists: [{ id: artistMbid, artistname: "Playlist Artist" }],
      releases: [
        {
          id: `${albumMbid}-release`,
          status: "Official",
          tracks: trackMbids.map((id, index) => ({
            id: `${id}-track`,
            recordingid: id,
            trackname: `Track ${index + 1}`,
            trackposition: index + 1,
            mediumnumber: 1,
          })),
        },
      ],
    }),
  );
});

async function scanFile(
  index: number,
  {
    downloadedByAurral,
    albumTitle = "Playlist Album",
    releaseGroupMbid = albumMbid,
  }: { downloadedByAurral: boolean; albumTitle?: string; releaseGroupMbid?: string },
) {
  const filePath = path.join(musicRoot, "Playlist Artist", albumTitle, `0${index + 1}.flac`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  await scanMusicRoot({
    rootPath: musicRoot,
    source: "aurral",
    filePaths: [filePath],
    metadataReader: async () => ({
      common: {
        albumartist: "Playlist Artist",
        artist: "Playlist Artist",
        album: albumTitle,
        title: `Track ${index + 1}`,
        track: { no: index + 1, of: null },
        musicbrainz_albumartistid: [artistMbid],
        musicbrainz_releasegroupid: releaseGroupMbid,
        musicbrainz_recordingid: trackMbids[index],
      },
      format: {},
    }),
    metadataEnricher: async () => (downloadedByAurral ? { trackName: `Track ${index + 1}` } : null),
  });
}

const albumState = () => {
  const albumId = requireFixture(db)
    .prepare<unknown[], { id: number }>(
      "SELECT id FROM library_albums WHERE release_group_mbid = ?",
    )!
    .get(albumMbid)!.id;
  const library = getLibraryForAlbumIds({ ids: [albumId] });
  const monitoredByMbid = Object.fromEntries(
    library.tracks.map((track) => [track.mbid, track.monitored]),
  );
  return {
    albumId,
    album: library.albums[0],
    monitored: trackMbids.map((mbid) => monitoredByMbid[mbid]),
  };
};

const queuedTrackMbids = () =>
  downloadTracker
    .getAll()
    .filter((job) => job.status === "pending" && job.albumMbid === albumMbid)
    .map((job) => job.trackMbid)
    .sort();

const originalSettings = dbOps.getSettings();
const originalLidarrConfigured = lidarrClient.isConfigured;
const originalWorkerStart = downloadWorker.start;

beforeAll(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadataServer.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  lidarrClient.isConfigured = () => false;
  downloadWorker.start = async () => {};
});

afterAll(async () => {
  lidarrClient.isConfigured = originalLidarrConfigured;
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

test("a downloaded single's album becomes Aurral's, the album can be downloaded, and that monitors it", async () => {
  await scanFile(0, { downloadedByAurral: true });
  await scanFile(1, { downloadedByAurral: false });

  const adopted = albumState();
  assert.equal(adopted.album.managedBy, "aurral");
  assert.equal(adopted.album.monitored, false);
  assert.deepEqual(adopted.monitored, [true, false, undefined]);

  const requested = await postJson("/albums/request", {
    albumMbid,
    albumName: "Playlist Album",
    artistMbid,
    artistName: "Playlist Artist",
    managedBy: "aurral",
  });

  assert.equal(requested.status, 201);
  const downloaded = albumState();
  assert.equal(downloaded.album.monitored, true);
  assert.equal(downloaded.album.trackIds.length, 3);
  assert.deepEqual(downloaded.monitored, [true, true, true]);
  assert.deepEqual(queuedTrackMbids(), [trackMbids[2]]);

  await libraryManager.setAurralAlbumMonitoring(downloaded.albumId, { monitored: false });
  assert.deepEqual(albumState().monitored, [false, false, false]);
  assert.deepEqual(queuedTrackMbids(), []);

  await postJson("/albums/request", {
    albumMbid,
    albumName: "Playlist Album",
    artistMbid,
    artistName: "Playlist Artist",
    managedBy: "aurral",
  });
  assert.equal(albumState().album.monitored, true);
  assert.deepEqual(albumState().monitored, [true, true, true]);
  assert.deepEqual(queuedTrackMbids(), [trackMbids[2]]);
});

test("downloading a missing track of an unmonitored Aurral album monitors and queues only that track", async () => {
  const { albumId } = albumState();
  await libraryManager.setAurralAlbumMonitoring(albumId, { monitored: false });
  const missing = albumState()
    .album.trackIds.map((id) =>
      getLibraryForAlbumIds({ ids: [albumId] }).tracks.find((track) => track.id === id),
    )
    .find((track) => requireFixture(track).mbid === trackMbids[2]);
  assert.ok(missing != null);

  const response = await postJson("/downloads/track", {
    artistName: "Playlist Artist",
    trackName: missing.title,
    albumName: "Playlist Album",
    canonicalTrackId: String(missing.id),
  });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.monitored, true);
  assert.equal(downloadTracker.getJob(body.jobId)!.albumMbid, albumMbid);
  assert.deepEqual(queuedTrackMbids(), [trackMbids[2]]);
  assert.deepEqual(albumState().monitored, [false, false, true]);
  assert.equal(albumState().album.monitored, false);
});

test("a file scanned into a Lidarr album stays Lidarr's", async () => {
  const lidarrAlbumMbid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const artist = db
    .prepare<unknown[], { id: number }>("SELECT id FROM library_artists WHERE mbid = ?")
    .get(artistMbid);
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${lidarrAlbumMbid}`,
    mbid: lidarrAlbumMbid,
    releaseGroupMbid: lidarrAlbumMbid,
    artistId: requireFixture(artist).id,
    title: "Lidarr Album",
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "lidarr",
  });

  await scanFile(0, {
    downloadedByAurral: true,
    albumTitle: "Lidarr Album",
    releaseGroupMbid: lidarrAlbumMbid,
  });

  assert.equal(managementStore.getManagedBy("album", album.id), "lidarr");
});
