import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { getLibrarySnapshot } from "../../backend/services/libraryMediaStore.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";

const metadata = {
  common: {
    albumartist: "Aurral Fixture",
    artist: "Aurral Fixture",
    album: "Playback Roadmap",
    title: "First Step",
    track: { no: 1, of: 4 },
    disk: { no: 1, of: 1 },
    musicbrainz_albumartistid: "11111111-1111-4111-8111-111111111111",
    musicbrainz_releasegroupid: "22222222-2222-4222-8222-222222222222",
    musicbrainz_recordingid: "33333333-3333-4333-8333-333333333333",
  },
  format: {
    duration: 123.4,
    codec: "FLAC",
    sampleRate: 44100,
    bitsPerSample: 16,
  },
};

async function createAudioFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  return filePath;
}

test("scanMusicRoot indexes tagged media and ignores Flow output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-scan-"));
  try {
    const filePath = await createAudioFile(root, "Aurral Fixture/Playback Roadmap/01 First Step.flac");
    await createAudioFile(root, "aurral-weekly-flow/flow/ignored.flac");

    const result = await scanMusicRoot({
      rootPath: root,
      source: `test-aurral-${process.pid}`,
      metadataReader: async () => metadata,
    });
    const snapshot = getLibrarySnapshot();
    const files = snapshot.files.filter((file) => file.source === `test-aurral-${process.pid}`);

    assert.equal(result.filesSeen, 1);
    assert.equal(result.filesIndexed, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, filePath);
    assert.equal(snapshot.artists.some((artist) => artist.name === "Aurral Fixture"), true);
    assert.equal(snapshot.albums.some((album) => album.title === "Playback Roadmap"), true);
    assert.equal(snapshot.tracks.some((track) => track.title === "First Step"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful rescan marks removed files unavailable without removing media records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-reconcile-"));
  const source = `test-reconcile-${process.pid}`;
  try {
    const filePath = await createAudioFile(root, "Artist/Album/01 Track.mp3");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });
    await rm(filePath);

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });
    const snapshot = getLibrarySnapshot();
    const file = snapshot.files.find((entry) => entry.path === filePath);

    assert.equal(file?.available, 0);
    assert.equal(snapshot.tracks.some((track) => track.title === "First Step"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial rescan preserves the last known-good file availability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-partial-"));
  const source = `test-partial-${process.pid}`;
  try {
    await createAudioFile(root, "Artist/Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => {
        throw new Error("metadata unavailable");
      },
    });
    const file = getLibrarySnapshot().files.find((entry) => entry.source === source);

    assert.equal(file?.available, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexLidarrLibrary imports logical media and readable track files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-index-"));
  const source = `lidarr-${process.pid}`;
  try {
    const filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    const client = {
      isConfigured: () => true,
      request: async () => [
        {
          id: 7,
          artistName: "Artist",
          foreignArtistId: "44444444-4444-4444-8444-444444444444",
          path: path.join(root, "Artist"),
        },
      ],
      getAllAlbums: async () => [
        {
          id: 8,
          artistId: 7,
          title: "Album",
          foreignAlbumId: "55555555-5555-4555-8555-555555555555",
          path: path.join(root, "Artist", "Album"),
        },
      ],
      getTracksByAlbumId: async () => [
        {
          id: 9,
          albumId: 8,
          title: "Track",
          trackNumber: 1,
          foreignRecordingId: "66666666-6666-4666-8666-666666666666",
          trackFileId: 10,
        },
      ],
      getTrackFilesByAlbumId: async () => [
        { id: 10, path: filePath, trackIds: [9], mediaInfo: { audioFormat: "FLAC" } },
      ],
      getRootFolders: async () => [{ path: root }],
    };

    const result = await indexLidarrLibrary({ client });
    const snapshot = getLibrarySnapshot();
    const file = snapshot.files.find((entry) => entry.path === filePath);

    assert.equal(result.filesIndexed, 1);
    assert.equal(file?.source, "lidarr");
    assert.equal(snapshot.artists.some((artist) => artist.name === "Artist"), true);
    assert.equal(snapshot.albums.some((album) => album.title === "Album"), true);
    assert.equal(snapshot.tracks.some((track) => track.title === "Track"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source IN (?, ?)").run(
      source,
      `test-aurral-${process.pid}`,
    );
  }
});
