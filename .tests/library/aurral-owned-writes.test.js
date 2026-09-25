import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createMockHttpServer, setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
import { joinUnderRoot } from "../../backend/services/playlistDownloadUtils.js";

const [isolatedState, { db }, { dbOps }, { libraryManager }, libraryStore, managementStore, trackerModule, workerModule, { scanMusicRoot }] =
  await setupIsolatedBackend(
    "aurral-owned-writes",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryManager.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
    "backend/services/weeklyFlow/weeklyFlowWorker.js",
    "backend/services/libraryFileScanner.js",
  );

const { downloadTracker } = trackerModule;
const { weeklyFlowWorker } = workerModule;

const artistMbid = "11111111-1111-4111-8111-111111111111";
const albumMbid = "22222222-2222-4222-8222-222222222222";
const ambiguousAlbumMbid = "88888888-8888-4888-8888-888888888888";
const trackMbids = [
  "33333333-3333-4333-8333-333333333331",
  "33333333-3333-4333-8333-333333333332",
];

function metadataAlbum(mbid, tracks, title = "Aurral Album") {
  return {
    id: mbid,
    title,
    artistid: artistMbid,
    artists: [{ id: artistMbid, artistname: "Aurral Artist" }],
    releasedate: "2026-01-02",
    releases: [{
      id: `${mbid}-release`,
      status: "Official",
      tracks: tracks.map((id, index) => ({
        id: `${id}-recording`,
        recordingid: id,
        trackname: `Track ${index + 1}`,
        trackposition: index + 1,
        mediumnumber: 1,
        durationms: 180000,
      })),
    }],
  };
}

test.before(() => {
  db.prepare("DELETE FROM library_management").run();
  downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("Aurral writes canonical album state, queues missing tracks, and reports conflicts", async () => {
  const server = await createMockHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "application/json");
    if (pathname === `/artist/${artistMbid}`) {
      response.end(JSON.stringify({ id: artistMbid, artistname: "Aurral Artist", sortname: "Aurral Artist" }));
      return;
    }
    if (pathname === `/album/${albumMbid}`) {
      response.end(JSON.stringify(metadataAlbum(albumMbid, trackMbids)));
      return;
    }
    if (pathname === `/album/${ambiguousAlbumMbid}`) {
      response.end(JSON.stringify(metadataAlbum(albumMbid, trackMbids, "Ambiguous Album")));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  const originalSettings = dbOps.getSettings();
  const originalIsConfigured = (await import("../../backend/services/lidarrClient.js")).lidarrClient.isConfigured;
  const originalWorkerStart = weeklyFlowWorker.start;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  const { clearMetadataProviderCaches } = await import("../../backend/services/providers/brainzmashProvider.js");
  clearMetadataProviderCaches();
  const lidarrClient = (await import("../../backend/services/lidarrClient.js")).lidarrClient;
  lidarrClient.isConfigured = () => false;
  weeklyFlowWorker.start = async () => {};

  try {
    const artist = await libraryManager.addArtist(artistMbid, "Aurral Artist");
    assert.equal(artist.managedBy, "aurral");
    assert.equal(managementStore.getManagedBy("artist", artist.id), "aurral");

    const request = await libraryManager.requestAlbumFromSearch({
      albumMbid,
      albumName: "Aurral Album",
      artistMbid,
      artistName: "Aurral Artist",
      user: { permissions: { addArtist: true } },
    });
    assert.equal(request.managedBy, "aurral");
    assert.equal(request.status, "queued");
    assert.equal(request.albumStatus.status, "queued");
    assert.equal(request.albumStatus.counts.pending, 2);
    assert.equal(request.albumStatus.requestGroupId, downloadTracker.getJob(request.jobIds[0]).requestGroupId);
    assert.equal(request.jobIds.length, 2);
    assert.equal(new Set(request.jobIds.map((id) => downloadTracker.getJob(id).requestGroupId)).size, 1);
    assert.equal(downloadTracker.getAll().every((job) => job.managedBy === "aurral"), true);

    const duplicate = await libraryManager.requestAlbumFromSearch({
      albumMbid,
      albumName: "Aurral Album",
      artistMbid,
      artistName: "Aurral Artist",
      user: { permissions: { addArtist: true } },
    });
    assert.deepEqual(duplicate.jobIds, request.jobIds);
    assert.equal(downloadTracker.getAll().length, 2);

    const firstJob = downloadTracker.getJob(request.jobIds[0]);
    const aurralRoot = process.env.DOWNLOAD_FOLDER;
    const mediaPath = path.join(aurralRoot, "Aurral Artist", "Aurral Album", "Track 1.mp3");
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(mediaPath, "aurral fixture");
    downloadTracker.setDone(firstJob.id, mediaPath, "Aurral Album");
    const scan = await scanMusicRoot({
      rootPath: aurralRoot,
      source: "aurral",
      changedPaths: [mediaPath],
      metadataReader: async () => ({
        common: {
          albumartist: "Aurral Artist",
          artist: "Aurral Artist",
          album: "Aurral Album",
          title: "Track 1",
          track: { no: 1 },
          musicbrainz_artistid: artistMbid,
          musicbrainz_albumartistid: artistMbid,
          musicbrainz_albumid: albumMbid,
          musicbrainz_releasegroupid: albumMbid,
          musicbrainz_recordingid: trackMbids[0],
        },
        format: { duration: 180 },
      }),
      syncSearch: false,
    });
    assert.equal(scan.filesIndexed, 1);
    assert.throws(
      () => joinUnderRoot(aurralRoot, "../outside"),
      /inside the configured root/,
    );
    const scannedAlbum = await libraryManager.addAlbum(
      artist.id,
      albumMbid,
      "Aurral Album",
      { managedBy: "aurral" },
    );
    assert.deepEqual(scannedAlbum.sources, ["aurral"]);
    assert.equal(scannedAlbum.statistics.trackFileCount, 1);
    assert.equal(path.relative(aurralRoot, mediaPath).startsWith(".."), false);

    lidarrClient.isConfigured = () => true;
    assert.equal((await libraryManager.getArtist(artistMbid)).managedBy, "aurral");
    assert.equal((await libraryManager.getAlbums(artist.id)).length, 1);
    assert.equal((await libraryManager.getAlbumById(scannedAlbum.id)).managedBy, "aurral");
    assert.equal((await libraryManager.getTracks(scannedAlbum.id)).length, 2);
    lidarrClient.isConfigured = () => false;

    downloadTracker.clearAll();
    const partialMbid = "44444444-4444-4444-8444-444444444444";
    const partialTracks = [
      "55555555-5555-4555-8555-555555555551",
      "55555555-5555-4555-8555-555555555552",
      "55555555-5555-4555-8555-555555555553",
    ];
    const partialAlbum = libraryStore.upsertLibraryAlbum({
      identityKey: `release-group:${partialMbid}`,
      mbid: partialMbid,
      releaseGroupMbid: partialMbid,
      artistId: artist.id,
      title: "Partial Album",
      albumArtist: artist.artistName,
    });
    const partialRecords = partialTracks.map((mbid, index) => {
      const track = libraryStore.upsertLibraryTrack({
        identityKey: `recording:${mbid}`,
        mbid,
        title: `Partial Track ${index + 1}`,
        artistName: artist.artistName,
      });
      libraryStore.linkLibraryAlbumTrack({
        albumId: partialAlbum.id,
        trackId: track.id,
        trackNumber: index + 1,
      });
      return track;
    });
    libraryStore.upsertLibraryMediaFile({
      trackId: partialRecords[0].id,
      albumId: partialAlbum.id,
      source: "lidarr",
      path: "/lidarr-root/Aurral Artist/Partial Album/01 Partial Track 1.flac",
    });
    libraryStore.upsertLibraryMediaFile({
      trackId: partialRecords[1].id,
      albumId: partialAlbum.id,
      source: "aurral",
      path: path.join(isolatedState.dataDir, "Aurral Artist/Partial Album/02 Partial Track 2.flac"),
    });
    const staleJobId = downloadTracker.addJob({
      artistName: artist.artistName,
      trackName: "Partial Track 3",
      albumName: "Partial Album",
      artistMbid,
      albumMbid: partialMbid,
      trackMbid: partialTracks[2],
      managedBy: "aurral",
    }, "library");
    downloadTracker.setDone(
      staleJobId,
      path.join(aurralRoot, "Aurral Artist/Partial Album/03 missing.flac"),
      "Partial Album",
    );
    managementStore.setLibraryManagement({
      entityKind: "album",
      entityId: partialAlbum.id,
      managedBy: "aurral",
    });

    const partial = await libraryManager.addAlbum(
      artist.id,
      partialMbid,
      "Partial Album",
      { managedBy: "aurral" },
    );
    assert.deepEqual(partial.sources, ["aurral", "lidarr"]);
    assert.equal(partial.statistics.trackFileCount, 2);
    assert.equal(partial.jobIds.length, 1);
    assert.equal(partial.jobIds[0], staleJobId);
    assert.equal(downloadTracker.getJob(partial.jobIds[0]).trackMbid, partialTracks[2]);
    assert.equal(downloadTracker.getJob(staleJobId).status, "pending");
    const restartedTracker = new trackerModule.WeeklyFlowDownloadTracker();
    assert.equal(restartedTracker.getJob(staleJobId).status, "pending");
    assert.equal(restartedTracker.getJob(staleJobId).managedBy, "aurral");

    downloadTracker.setFailed(staleJobId, "Aurral write failed");
    const retried = await libraryManager.addAlbum(
      artist.id,
      partialMbid,
      "Partial Album",
      { managedBy: "aurral" },
    );
    assert.deepEqual(retried.jobIds, [staleJobId]);
    assert.equal(downloadTracker.getJob(staleJobId).status, "pending");

    const ambiguous = await libraryManager.addAlbum(
      artist.id,
      ambiguousAlbumMbid,
      "Ambiguous Album",
      { managedBy: "aurral" },
    );
    assert.equal(ambiguous.statusCode, 422);
    assert.equal(ambiguous.code, "ambiguous_identity");
    assert.equal(
      db.prepare("SELECT id FROM library_albums WHERE mbid = ?").get(ambiguousAlbumMbid),
      undefined,
    );

    downloadTracker.clearAll();
    const conflictMbid = "66666666-6666-4666-8666-666666666666";
    const conflictAlbum = libraryStore.upsertLibraryAlbum({
      identityKey: `release-group:${conflictMbid}`,
      mbid: conflictMbid,
      releaseGroupMbid: conflictMbid,
      artistId: artist.id,
      title: "Lidarr Album",
      metadata: { id: "lidarr-album-42" },
    });
    const conflictTrack = libraryStore.upsertLibraryTrack({
      identityKey: "recording:77777777-7777-4777-8777-777777777777",
      mbid: "77777777-7777-4777-8777-777777777777",
      title: "Lidarr Track",
      artistName: artist.artistName,
    });
    libraryStore.linkLibraryAlbumTrack({
      albumId: conflictAlbum.id,
      trackId: conflictTrack.id,
      trackNumber: 1,
    });
    libraryStore.upsertLibraryMediaFile({
      trackId: conflictTrack.id,
      albumId: conflictAlbum.id,
      source: "lidarr",
      path: "/lidarr-root/Aurral Artist/Lidarr Album/01 Lidarr Track.flac",
    });
    managementStore.setLibraryManagement({
      entityKind: "album",
      entityId: conflictAlbum.id,
      managedBy: "lidarr",
    });

    const conflict = await libraryManager.addAlbum(
      artist.id,
      conflictMbid,
      "Lidarr Album",
      { managedBy: "aurral" },
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.code, "album_owner_conflict");
    assert.equal(conflict.managedBy, "lidarr");
    assert.equal(conflict.canonicalId, String(conflictAlbum.id));
    assert.equal(conflict.providerId, "lidarr-album-42");
    assert.deepEqual(conflict.sources, ["lidarr"]);
    assert.equal(conflict.availability.available, true);
    assert.equal(downloadTracker.getAll().length, 0);
  } finally {
    weeklyFlowWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearMetadataProviderCaches();
    await server.close();
  }
});
