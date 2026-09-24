import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { downloadTracker } from "../../backend/services/weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";
import { dbOps } from "../../backend/db/helpers/index.js";
import {
  clearDownloadProviderWork,
  isDownloadJobCancelled,
  listDownloadProviderWork,
  registerDownloadProviderWork,
  withPipelineCommitLock,
} from "../../backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js";
import { createMockHttpServer } from "../helpers/backendTestHarness.js";

test("deletes Aurral-owned track files without Lidarr", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-delete-"));
  const filePath = path.join(root, "Artist", "Album", "01 Track.flac");
  const identity = `track-delete-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");

  const artist = upsertLibraryArtist({
    identityKey: `${identity}:artist`,
    name: "Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${identity}:album`,
    artistId: artist.id,
    title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${identity}:track`,
    mbid: `${identity}-mbid`,
    title: "Track",
    artistName: "Artist",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    available: true,
  });
  const libraryJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track" },
    "library",
  );
  downloadTracker.setDone(libraryJobId, filePath, "Album");
  const upgradeJobId = downloadTracker.addUpgradeJob(downloadTracker.getJob(libraryJobId));
  const differentTrackJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", trackMbid: `${identity}-different-mbid` },
    "library",
  );

  t.mock.method(lidarrClient, "isConfigured", () => false);

  try {
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
    await assert.rejects(() => access(filePath));
    assert.equal(
      db.prepare(
        "SELECT 1 FROM library_media_files WHERE source = ? AND path = ?",
      ).get("aurral", filePath),
      undefined,
    );
    assert.equal(db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(track.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(album.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM library_artists WHERE id = ?").get(artist.id), undefined);
    for (const [entityKind, entityId] of [["artist", artist.id], ["album", album.id], ["track", track.id]]) {
      assert.equal(
        db.prepare(
          "SELECT 1 FROM library_search_documents WHERE entity_kind = ? AND entity_id = ?",
        ).get(entityKind, entityId),
        undefined,
      );
    }
    assert.equal(downloadTracker.getJob(libraryJobId), null);
    assert.equal(downloadTracker.getJob(upgradeJobId), null);
    assert.notEqual(downloadTracker.getJob(differentTrackJobId), null);
  } finally {
    db.prepare(
      "DELETE FROM library_search_documents WHERE (entity_kind, entity_id) IN ((?, ?), (?, ?), (?, ?))",
    ).run("artist", artist.id, "album", album.id, "track", track.id);
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run("aurral", filePath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(album.id, track.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    if (libraryJobId) downloadTracker.removeJob(libraryJobId);
    if (upgradeJobId) downloadTracker.removeJob(upgradeJobId);
    if (differentTrackJobId) downloadTracker.removeJob(differentTrackJobId);
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a library track preserves a file still referenced by a playlist job", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-delete-shared-file-"));
  const filePath = path.join(root, "Artist", "Album", "01 Track.flac");
  const identity = `track-delete-shared-file-${process.pid}-${Date.now()}`;
  const mbid = `${identity}-mbid`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "shared audio");

  const artist = upsertLibraryArtist({ identityKey: `${identity}:artist`, name: "Artist" });
  const album = upsertLibraryAlbum({
    identityKey: `${identity}:album`,
    artistId: artist.id,
    title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${identity}:track`,
    mbid,
    title: "Track",
    artistName: "Artist",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    available: true,
  });
  const libraryJobId = downloadTracker.addJob({
    artistName: "Artist",
    trackName: "Track",
    trackMbid: mbid,
  }, "library");
  const playlistJobId = downloadTracker.addJob({
    artistName: "Artist",
    trackName: "Track",
    trackMbid: mbid,
  }, "shared-file-survivor");
  downloadTracker.setDone(libraryJobId, filePath, "Album");
  downloadTracker.setDone(playlistJobId, filePath, "Album");

  t.mock.method(lidarrClient, "isConfigured", () => false);

  try {
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
    assert.equal(await fsp.readFile(filePath, "utf8"), "shared audio");
    assert.equal(downloadTracker.getJob(libraryJobId), null);
    assert.equal(downloadTracker.getJob(playlistJobId)?.finalPath, filePath);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run("aurral", filePath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(album.id, track.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    downloadTracker.removeJob(libraryJobId);
    downloadTracker.removeJob(playlistJobId);
    await rm(root, { recursive: true, force: true });
  }
});

test("deletes a library file committed while track removal waits for its lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-delete-commit-race-"));
  const originalPath = path.join(root, "Artist", "Album", "Original.flac");
  const committedPath = path.join(root, "Artist", "Album", "Committed.flac");
  const identity = `track-delete-commit-race-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(originalPath), { recursive: true });
  await writeFile(originalPath, "original audio");

  const artist = upsertLibraryArtist({ identityKey: `${identity}:artist`, name: "Artist" });
  const album = upsertLibraryAlbum({
    identityKey: `${identity}:album`,
    artistId: artist.id,
    title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${identity}:track`,
    mbid: `${identity}-mbid`,
    title: "Track",
    artistName: "Artist",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: originalPath,
    available: true,
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, "library");
  const job = downloadTracker.getJob(jobId);
  const payload = {
    jobId,
    playlistId: "library",
    playlistGeneration: job.playlistGeneration,
  };
  let signalCommitEntered;
  let releaseCommit;
  const commitEntered = new Promise((resolve) => { signalCommitEntered = resolve; });
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  const commit = withPipelineCommitLock(payload, async () => {
    signalCommitEntered();
    await commitGate;
    await writeFile(committedPath, "committed audio");
    downloadTracker.setDone(jobId, committedPath, "Album");
  });
  let deletion;
  try {
    await commitEntered;
    t.mock.method(lidarrClient, "isConfigured", () => false);
    deletion = libraryManager.deleteTrack(track.id);
    const deadline = Date.now() + 2000;
    while (!isDownloadJobCancelled(jobId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(isDownloadJobCancelled(jobId), true);
    releaseCommit();
    await commit;
    assert.deepEqual(await deletion, { success: true });
    await assert.rejects(() => access(originalPath), { code: "ENOENT" });
    await assert.rejects(() => access(committedPath), { code: "ENOENT" });
    assert.equal(downloadTracker.getJob(jobId), null);
  } finally {
    releaseCommit();
    await Promise.allSettled([commit, deletion].filter(Boolean));
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run("aurral", originalPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(album.id, track.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    downloadTracker.removeJob(jobId);
    await rm(root, { recursive: true, force: true });
  }
});

test("records successful Aurral deletions when another file fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-delete-partial-"));
  const deletedPath = path.join(root, "Artist", "Album", "01 Track.flac");
  const failedPath = path.join(root, "Artist", "Album", "02 Track.flac");
  const identity = `track-delete-partial-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(deletedPath), { recursive: true });
  await writeFile(deletedPath, "fixture");
  await writeFile(failedPath, "fixture");

  const artist = upsertLibraryArtist({
    identityKey: `${identity}:artist`,
    name: "Artist",
    syncSearch: false,
  });
  const album = upsertLibraryAlbum({
    identityKey: `${identity}:album`,
    artistId: artist.id,
    title: "Album",
    syncSearch: false,
  });
  const track = upsertLibraryTrack({
    identityKey: `${identity}:track`,
    title: "Track",
    artistName: "Artist",
    syncSearch: false,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, syncSearch: false });
  for (const filePath of [deletedPath, failedPath]) {
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: filePath,
      available: true,
    });
  }
  const libraryJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track" },
    "library",
  );

  let failDeletion = true;
  const originalUnlink = fsp.unlink;
  t.mock.method(fsp, "unlink", async (filePath) => {
    if (failDeletion && filePath === failedPath) {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(filePath);
  });
  t.mock.method(lidarrClient, "isConfigured", () => false);

  try {
    assert.deepEqual(await libraryManager.deleteTrack(track.id), {
      success: false,
      code: "failed",
      error: "permission denied",
    });
    assert.equal(
      db.prepare(
        "SELECT available FROM library_media_files WHERE source = ? AND path = ?",
      ).get("aurral", deletedPath)?.available,
      0,
    );
    assert.equal(downloadTracker.getJob(libraryJobId), null);
    assert.equal(
      db.prepare(
        "SELECT available FROM library_media_files WHERE source = ? AND path = ?",
      ).get("aurral", failedPath)?.available,
      1,
    );
    await assert.rejects(() => access(deletedPath));
    await access(failedPath);
    failDeletion = false;
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
    await assert.rejects(() => access(failedPath));
    assert.equal(db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(track.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(album.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM library_artists WHERE id = ?").get(artist.id), undefined);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path IN (?, ?)").run(
      "aurral",
      deletedPath,
      failedPath,
    );
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(album.id, track.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    if (libraryJobId) downloadTracker.removeJob(libraryJobId);
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a library job and track when provider cancellation fails, then retries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-delete-cancel-"));
  const filePath = path.join(root, "Artist", "Album", "Track.flac");
  const identity = `track-delete-cancel-${process.pid}-${Date.now()}`;
  const searchId = `search-${identity}`;
  const originalSettings = dbOps.getSettings();
  let providerStatus = 503;
  const mock = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(providerStatus);
    response.end();
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");

  const artist = upsertLibraryArtist({
    identityKey: `${identity}:artist`,
    name: "Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${identity}:album`,
    artistId: artist.id,
    title: "Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${identity}:track`,
    title: "Track",
    artistName: "Artist",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    available: true,
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", downloadSource: "slskd" },
    "library",
  );
  registerDownloadProviderWork({
    jobId,
    playlistId: "library",
    provider: "slskd-search",
    workId: searchId,
  });
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...(originalSettings.integrations || {}),
      slskd: { enabled: true, url: mock.url, apiKey: "test-key" },
    },
  });
  t.mock.method(lidarrClient, "isConfigured", () => false);

  try {
    const failedDeletion = await libraryManager.deleteTrack(track.id);

    assert.equal(failedDeletion.success, false);
    assert.equal(failedDeletion.code, "download_cancellation_failed");
    assert.notEqual(downloadTracker.getJob(jobId), null);
    assert.equal(listDownloadProviderWork({ jobIds: [jobId] }).length, 1);
    await access(filePath);

    providerStatus = 204;
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
    assert.equal(downloadTracker.getJob(jobId), null);
    assert.equal(listDownloadProviderWork({ jobIds: [jobId] }).length, 0);
    await assert.rejects(() => access(filePath));
  } finally {
    dbOps.updateSettings(originalSettings);
    clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
    downloadTracker.removeJob(jobId);
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "aurral",
      filePath,
    );
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(
      album.id,
      track.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
