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
  const lidarrRoot = await mkdtemp(path.join(tmpdir(), "aurral-library-query-lidarr-"));
  const source = `query-aurral-${process.pid}`;
  try {
    const filePath = await createAudioFile(root, "Query Fixture/Canonical Reads/01 One Source, Two Files.flac");
    const lidarrFilePath = await createAudioFile(
      lidarrRoot,
      "Query Fixture/Canonical Reads/01 One Source, Two Files.flac",
    );
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
          path: path.join(lidarrRoot, "Query Fixture", "Canonical Reads"),
        }],
        getTracksByAlbumId: async () => [{
          id: 9,
          albumId: 8,
          title: "One Source, Two Files",
          trackNumber: 1,
          foreignRecordingId: metadata.common.musicbrainz_recordingid,
          trackFileId: 10,
        }],
        getTrackFilesByAlbumId: async () => [{ id: 10, path: lidarrFilePath, trackIds: [9] }],
        getRootFolders: async () => [{ path: lidarrRoot }],
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

    db.prepare("UPDATE library_media_files SET available = 0 WHERE path = ?").run(lidarrFilePath);
    const available = getCanonicalLibrary({ availableOnly: true });
    assert.equal(available.tracks.length, 1);
    assert.deepEqual(available.tracks[0].sources, [source]);
    assert.equal(available.tracks[0].files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(lidarrRoot, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source IN (?, ?)").run(source, "lidarr");
  }
});

test("getCanonicalLibrary rejects unknown source filters", () => {
  assert.throws(() => getCanonicalLibrary({ source: "plex" }), /Unsupported library source/);
});

test("canonical library responses do not expose filesystem paths", () => {
  const response = toPublicLibrary({
    artists: [],
    albums: [],
    tracks: [{ id: 1, files: [{ id: 2, path: "/music/private.flac", source: "aurral" }] }],
  });

  assert.deepEqual(response.tracks[0].files, [{ id: 2, source: "aurral" }]);
});
