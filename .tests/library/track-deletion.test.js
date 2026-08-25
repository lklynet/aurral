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
