import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
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
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    available: true,
  });

  t.mock.method(lidarrClient, "isConfigured", () => false);

  try {
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
    await assert.rejects(() => access(filePath));
    assert.equal(
      db.prepare(
        "SELECT available FROM library_media_files WHERE source = ? AND path = ?",
      ).get("aurral", filePath)?.available,
      0,
    );
    assert.deepEqual(await libraryManager.deleteTrack(track.id), { success: true });
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run("aurral", filePath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?").run(album.id, track.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    await rm(root, { recursive: true, force: true });
  }
});
