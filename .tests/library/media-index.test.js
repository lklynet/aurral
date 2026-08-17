import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { getLibrarySnapshot } from "../../backend/services/libraryMediaStore.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";
import { scanConfiguredLibrary } from "../../backend/services/libraryIndexService.js";

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

function deleteIndexedFile(source, filePath) {
  const links = db.prepare(
    `SELECT media.track_id AS trackId, album_track.album_id AS albumId, album.artist_id AS artistId
     FROM library_media_files AS media
     LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = media.track_id
     LEFT JOIN library_albums AS album ON album.id = album_track.album_id
     WHERE media.source = ? AND media.path = ?`,
  ).all(source, filePath);
  db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(source, filePath);

  for (const { trackId, albumId, artistId } of links) {
    const remainingFiles = db.prepare(
      "SELECT COUNT(*) AS count FROM library_media_files WHERE track_id = ?",
    ).get(trackId).count;
    if (remainingFiles === 0) {
      db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(trackId);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(trackId);
    }
    if (albumId != null) {
      db.prepare(
        "DELETE FROM library_albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)",
      ).run(albumId, albumId);
    }
    if (artistId != null) {
      db.prepare(
        "DELETE FROM library_artists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)",
      ).run(artistId, artistId);
    }
  }
}

test("scanMusicRoot indexes tagged media and ignores Flow output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-scan-"));
  const source = `test-aurral-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Fixture/Playback Roadmap/01 First Step.flac");
    await createAudioFile(root, "aurral-weekly-flow/flow/ignored.flac");
    await createAudioFile(root, "_playlists/ignored.flac");
    await createAudioFile(root, "_staging/ignored.flac");
    await createAudioFile(root, "_fallback/ignored.flac");
    await createAudioFile(root, ".hidden/ignored.flac");

    const result = await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });
    const snapshot = getLibrarySnapshot();
    const files = snapshot.files.filter((file) => file.source === source);

    assert.equal(result.filesSeen, 1);
    assert.equal(result.filesIndexed, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, filePath);
    assert.equal(snapshot.artists.some((artist) => artist.name === "Aurral Fixture"), true);
    assert.equal(snapshot.albums.some((album) => album.title === "Playback Roadmap"), true);
    assert.equal(snapshot.tracks.some((track) => track.title === "First Step"), true);
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot derives stable fallback records when tags are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-fallback-"));
  const source = `test-fallback-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Fallback Artist/Fallback Album/02 Fallback Track.mp3");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({ common: {}, format: {} }),
    });
    const indexed = db.prepare(
      `SELECT artist.name AS artistName, album.title AS albumTitle,
        track.title AS trackTitle, media.available
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistName: "Fallback Artist",
      albumTitle: "Fallback Album",
      trackTitle: "Fallback Track",
      available: 1,
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
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
  let filePath;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
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
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
  }
});

test("indexLidarrLibrary does not reuse a file from another album", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-album-scope-"));
  const artistId = 10000 + (process.pid % 1000);
  const firstAlbumId = artistId + 1;
  const secondAlbumId = artistId + 2;
  const filePath = await createAudioFile(root, "Artist/Eve 6/01 Showerhead.flac");
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const firstAlbumMbid = "22222222-2222-4222-8222-222222222222";
  const secondAlbumMbid = "33333333-3333-4333-8333-333333333333";
  const recordingMbid = "44444444-4444-4444-8444-444444444444";
  const trackFileId = artistId + 10;
  try {
    await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{
          id: artistId,
          artistName: "Eve 6",
          foreignArtistId: artistMbid,
          path: path.join(root, "Artist"),
        }],
        getAllAlbums: async () => [
          {
            id: firstAlbumId,
            artistId,
            title: "Eve 6",
            foreignAlbumId: firstAlbumMbid,
            statistics: { sizeOnDisk: 1 },
          },
          {
            id: secondAlbumId,
            artistId,
            title: "Inside Out",
            foreignAlbumId: secondAlbumMbid,
            statistics: { sizeOnDisk: 0 },
          },
        ],
        getTracksByAlbumId: async (albumId) => [{
          id: albumId + 100,
          albumId,
          title: "Showerhead",
          trackNumber: 1,
          foreignRecordingId: recordingMbid,
          trackFileId,
        }],
        getTrackFilesByAlbumId: async (albumId) => albumId === firstAlbumId
          ? [{ id: trackFileId, albumId: firstAlbumId, path: filePath }]
          : [],
        getRootFolders: async () => [{ path: root }],
      },
    });

    const albumRows = db.prepare(
      `SELECT album.title AS title, COUNT(DISTINCT media.id) AS files
       FROM library_albums AS album
       JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
       LEFT JOIN library_media_files AS media
         ON media.track_id = album_track.track_id
        AND media.source = 'lidarr'
        AND media.available = 1
       WHERE album.identity_key IN (?, ?)
       GROUP BY album.id
       ORDER BY album.title`,
    ).all(`release-group:${firstAlbumMbid}`, `release-group:${secondAlbumMbid}`);
    assert.deepEqual(albumRows, [{ title: "Eve 6", files: 1 }]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = 'lidarr' AND path = ?").run(filePath);
    const albumRows = db.prepare(
      "SELECT id FROM library_albums WHERE identity_key IN (?, ?)",
    ).all(`release-group:${firstAlbumMbid}`, `release-group:${secondAlbumMbid}`);
    const albumIds = albumRows.map((row) => row.id);
    if (albumIds.length) {
      db.prepare(
        `DELETE FROM library_album_tracks WHERE album_id IN (${albumIds.map(() => "?").join(",")})`,
      ).run(...albumIds);
      db.prepare(
        `DELETE FROM library_albums WHERE id IN (${albumIds.map(() => "?").join(",")})`,
      ).run(...albumIds);
    }
    db.prepare("DELETE FROM library_tracks WHERE identity_key = ?").run(`recording:${recordingMbid}`);
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(`mbid:${artistMbid}`);
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial Lidarr rescan preserves existing file availability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-partial-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    const client = {
      isConfigured: () => true,
      request: async () => [{ id: 17, artistName: "Artist", foreignArtistId: "77777777-7777-4777-8777-777777777777" }],
      getAllAlbums: async () => [{
        id: 18,
        artistId: 17,
        title: "Album",
        foreignAlbumId: "88888888-8888-4888-8888-888888888888",
        path: path.join(root, "Artist", "Album"),
      }],
      getTracksByAlbumId: async () => [{
        id: 19,
        albumId: 18,
        title: "Track",
        trackNumber: 1,
        foreignRecordingId: "99999999-9999-4999-8999-999999999999",
        trackFileId: 20,
      }],
      getTrackFilesByAlbumId: async () => [{ id: 20, path: filePath, trackIds: [19] }],
      getRootFolders: async () => [{ path: root }],
    };

    await indexLidarrLibrary({ client });
    await rm(filePath);
    const result = await indexLidarrLibrary({ client });
    const file = getLibrarySnapshot().files.find((entry) => entry.path === filePath);

    assert.equal(result.filesFailed, 1);
    assert.equal(file?.available, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
  }
});

test("a Lidarr outage leaves the last indexed library available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-outage-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Outage Artist/Outage Album/01 Outage Track.flac");
    await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{
          id: 27,
          artistName: "Outage Artist",
          foreignArtistId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }],
        getAllAlbums: async () => [{
          id: 28,
          artistId: 27,
          title: "Outage Album",
          foreignAlbumId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          path: path.dirname(filePath),
        }],
        getTracksByAlbumId: async () => [{
          id: 29,
          albumId: 28,
          title: "Outage Track",
          trackNumber: 1,
          foreignRecordingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          trackFileId: 30,
        }],
        getTrackFilesByAlbumId: async () => [{ id: 30, path: filePath, trackIds: [29] }],
        getRootFolders: async () => [{ path: root }],
      },
    });

    const result = await scanConfiguredLibrary({
      musicRoot: path.join(root, "empty-aurral-root"),
      lidarrClient: {
        isConfigured: () => true,
        request: async () => {
          throw new Error("Lidarr unavailable");
        },
        getAllAlbums: async () => [],
        getRootFolders: async () => [],
      },
    });
    const file = getLibrarySnapshot().files.find((entry) => entry.path === filePath);

    assert.equal(result.lidarr.error, "Lidarr unavailable");
    assert.equal(file?.available, 1);
  } finally {
    if (filePath) deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty Lidarr response leaves the last indexed library available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-empty-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Empty Artist/Empty Album/01 Empty Track.flac");
    const indexedClient = {
      isConfigured: () => true,
      request: async () => [{ id: 37, artistName: "Empty Artist", foreignArtistId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
      getAllAlbums: async () => [{ id: 38, artistId: 37, title: "Empty Album", foreignAlbumId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
      getTracksByAlbumId: async () => [{ id: 39, albumId: 38, title: "Empty Track", trackNumber: 1, foreignRecordingId: "ffffffff-ffff-4fff-8fff-ffffffffffff", trackFileId: 40 }],
      getTrackFilesByAlbumId: async () => [{ id: 40, path: filePath, trackIds: [39] }],
      getRootFolders: async () => [{ path: root }],
    };

    await indexLidarrLibrary({ client: indexedClient });
    const result = await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{ id: 37, artistName: "Empty Artist", foreignArtistId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
        getAllAlbums: async () => [{ id: 38, artistId: 37, title: "Empty Album", foreignAlbumId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
        getTracksByAlbumId: async () => [],
        getTrackFilesByAlbumId: async () => [],
        getRootFolders: async () => [{ path: root }],
      },
    });
    const file = getLibrarySnapshot().files.find((entry) => entry.path === filePath);

    assert.equal(result.filesIndexed, 0);
    assert.equal(file?.available, 1);
  } finally {
    if (filePath) deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});
