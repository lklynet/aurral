import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";
import { getCanonicalLibrary } from "../../backend/services/libraryQueryService.js";
import { toPublicLibrary } from "../../backend/routes/library/handlers/canonical.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
} from "../../backend/services/libraryMediaStore.js";

const metadata = {
  common: {
    albumartist: "Query Fixture",
    artist: "Query Fixture",
    album: "Canonical Reads",
    title: "One Source, Two Files",
    track: { no: 1 },
    disk: { no: 1 },
    musicbrainz_albumartistid: "11111111-1111-4111-8111-111111111111",
    musicbrainz_releasegroupid: "22222222-2222-4222-8222-222222222222",
    musicbrainz_recordingid: "33333333-3333-4333-8333-333333333333",
  },
  format: { duration: 123.4, codec: "FLAC" },
};

async function createAudioFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  return filePath;
}

test("getCanonicalLibrary merges sources and preserves normalized hierarchy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-query-"));
  const source = `query-aurral-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Query Fixture/Canonical Reads/01 One Source, Two Files.flac");
    await scanMusicRoot({ rootPath: root, source, metadataReader: async () => metadata });

    await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{ id: 7, artistName: "Query Fixture", foreignArtistId: metadata.common.musicbrainz_albumartistid }],
        getAllAlbums: async () => [{
          id: 8,
          artistId: 7,
          title: "Canonical Reads",
          foreignAlbumId: metadata.common.musicbrainz_releasegroupid,
          path: path.join(root, "Query Fixture", "Canonical Reads"),
        }],
        getTracksByAlbumId: async () => [{
          id: 9,
          albumId: 8,
          title: "One Source, Two Files",
          trackNumber: 1,
          foreignRecordingId: metadata.common.musicbrainz_recordingid,
          trackFileId: 10,
        }],
        getTrackFilesByAlbumId: async () => [{ id: 10, path: filePath, trackIds: [9] }],
        getRootFolders: async () => [{ path: root }],
      },
    });

    const all = getCanonicalLibrary();
    assert.equal(all.artists.length, 1);
    assert.equal(all.albums.length, 1);
    assert.equal(all.tracks.length, 1);
    assert.deepEqual(all.tracks[0].sources, ["lidarr", source]);
    assert.equal(all.tracks[0].files.length, 2);
    assert.equal(all.albums[0].trackIds[0], all.tracks[0].id);
    assert.equal(all.artists[0].albumIds[0], all.albums[0].id);
    assert.equal(all.tracks[0].available, true);

    const lidarr = getCanonicalLibrary({ source: "lidarr" });
    assert.equal(lidarr.tracks.length, 1);
    assert.deepEqual(lidarr.tracks[0].sources, ["lidarr"]);

    db.prepare("UPDATE library_media_files SET available = 0 WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
    const available = getCanonicalLibrary({ availableOnly: true });
    assert.equal(available.tracks.length, 1);
    assert.deepEqual(available.tracks[0].sources, [source]);
    assert.equal(available.tracks[0].files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source IN (?, ?) AND path = ?").run(
      source,
      "lidarr",
      filePath,
    );
  }
});

test("getCanonicalLibrary deduplicates a file shared by multiple album relationships", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-query-duplicate-"));
  let filePath;
  let duplicateAlbumId;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    await scanMusicRoot({ rootPath: root, source: "aurral", metadataReader: async () => metadata });
    const first = getCanonicalLibrary({ source: "aurral" });
    const track = first.tracks.find((entry) => entry.files.some((file) => file.path === filePath));
    const album = first.albums.find((entry) => entry.trackIds.includes(track.id));
    const duplicateAlbum = upsertLibraryAlbum({
      identityKey: `duplicate-album:${process.pid}`,
      artistId: album.artistId,
      title: "Duplicate Relationship",
    });
    duplicateAlbumId = duplicateAlbum.id;
    linkLibraryAlbumTrack({ albumId: duplicateAlbum.id, trackId: track.id, trackNumber: 1 });

    const result = getCanonicalLibrary({ source: "aurral" });
    const resultTrack = result.tracks.find((entry) => entry.files.some((file) => file.path === filePath));
    assert.equal(resultTrack.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (duplicateAlbumId) {
      db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(duplicateAlbumId);
      db.prepare("DELETE FROM library_albums WHERE id = ?").run(duplicateAlbumId);
    }
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run("aurral", filePath);
  }
});

test("getCanonicalLibrary rejects unknown source filters", () => {
  assert.throws(() => getCanonicalLibrary({ source: "plex" }), /Unsupported library source/);
});

test("canonical library responses do not expose filesystem paths", () => {
  const response = toPublicLibrary({
    artists: [{ metadata: { path: "/music/private", tags: { genre: "rock" } } }],
    albums: [{ metadata: { rootFolderPath: "/music/private" } }],
    tracks: [{
      id: 1,
      metadata: { nested: { filePath: "/music/private.flac" } },
      files: [{ id: 2, path: "/music/private.flac", source: "aurral" }],
    }],
  });

  assert.deepEqual(response.artists[0].metadata, { tags: { genre: "rock" } });
  assert.deepEqual(response.albums[0].metadata, {});
  assert.deepEqual(response.tracks[0].metadata, { nested: {} });
  assert.deepEqual(response.tracks[0].files, [{ id: 2, source: "aurral" }]);
});
