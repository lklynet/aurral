import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import {
  getCanonicalArtistProjection,
  getCanonicalLibraryPage,
} from "../../backend/services/libraryQueryService.js";
import {
  buildFallbackIdentityKey,
  getLibrarySnapshot,
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "../../backend/services/libraryMediaStore.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";
import { scanConfiguredLibrary } from "../../backend/services/libraryIndexService.js";

test("scan change tracking ignores unrelated database writes", async () => {
  const settingKey = `unrelated-scan-write-${process.pid}`;
  try {
    const result = await withLibraryScan("test-unrelated-write", null, async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(settingKey, "value");
      return { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    });

    assert.equal(result.changed, false);
  } finally {
    db.prepare("DELETE FROM settings WHERE key = ?").run(settingKey);
    db.prepare("DELETE FROM library_scan_runs WHERE source = 'test-unrelated-write'").run();
  }
});

test("overlapping scans keep change tracking isolated", async () => {
  const identityKey = `name:overlapping-scan-${process.pid}`;
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstChanged;

  try {
    const first = withLibraryScan("test-overlap-first", null, async () => {
      upsertLibraryArtist({ identityKey, name: "Overlapping Scan", syncSearch: false });
      firstChanged = true;
      await holdFirst;
      return { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    });
    while (!firstChanged) await new Promise((resolve) => setImmediate(resolve));

    const second = await withLibraryScan("test-overlap-second", null, async () => (
      { filesSeen: 0, filesIndexed: 0, filesFailed: 0 }
    ));
    releaseFirst();

    assert.equal(second.changed, false);
    assert.equal((await first).changed, true);
  } finally {
    releaseFirst?.();
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(identityKey);
    db.prepare("DELETE FROM library_scan_runs WHERE source LIKE 'test-overlap-%'").run();
  }
});

test("a local-only configured scan does not contact Lidarr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-local-only-scan-"));
  let lidarrCalls = 0;
  try {
    const result = await scanConfiguredLibrary({
      musicRoot: root,
      includeLidarr: false,
      lidarrClient: {
        isConfigured: () => true,
        request: async () => {
          lidarrCalls += 1;
          throw new Error("unexpected Lidarr request");
        },
      },
    });
    assert.equal(lidarrCalls, 0);
    assert.equal(result.lidarr.skipped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed provider scan repairs derived library indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-failed-index-repair-"));
  const identityKey = `name:failed-index-repair-${process.pid}`;
  const artist = upsertLibraryArtist({
    identityKey,
    name: "Failed Index Repair",
    syncSearch: false,
  });
  db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
    .run(artist.id);

  try {
    const result = await scanConfiguredLibrary({
      musicRoot: root,
      lidarrClient: {
        isConfigured: () => true,
        request: async () => {
          throw new Error("Lidarr unavailable");
        },
        getAllAlbums: async () => [],
        getRootFolders: async () => [],
      },
    });
    const indexed = db.prepare(
      "SELECT 1 FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?",
    ).get(artist.id);

    assert.equal(result.lidarr.error, "Lidarr unavailable");
    assert.equal(Boolean(indexed), true);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(identityKey);
    await rm(root, { recursive: true, force: true });
  }
});

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
    await createAudioFile(root, "_flows/flow/ignored.flac");
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

test("upsertLibraryArtist promotes a name fallback when its MBID becomes known", () => {
  const name = `Identity Promotion ${process.pid} ${Date.now()}`;
  const mbid = "11111111-1111-4111-8111-111111111112";
  const fallback = upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", name),
    name,
  });
  const album = upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", fallback.identity_key, "Album"),
    artistId: fallback.id,
    title: "Album",
  });

  try {
    const resolved = upsertLibraryArtist({
      identityKey: `mbid:${mbid}`,
      mbid,
      name,
    });
    const fallbackAgain = upsertLibraryArtist({
      identityKey: buildFallbackIdentityKey("artist", name),
      name,
    });
    const artists = db.prepare("SELECT id, mbid FROM library_artists WHERE name = ?").all(name);
    const linkedAlbum = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(album.id);

    assert.deepEqual(artists, [{ id: resolved.id, mbid }]);
    assert.equal(resolved.id, fallback.id);
    assert.equal(fallbackAgain.id, resolved.id);
    assert.equal(linkedAlbum.artist_id, resolved.id);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE name = ?").run(name);
  }
});

test("upsertLibraryArtist repairs an existing fallback and MBID duplicate", () => {
  const name = `Identity Repair ${process.pid} ${Date.now()}`;
  const mbid = "11111111-1111-4111-8111-111111111113";
  const fallbackKey = buildFallbackIdentityKey("artist", name);
  const fallback = upsertLibraryArtist({
    identityKey: fallbackKey,
    name,
  });
  const album = upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", fallback.identity_key, "Album"),
    artistId: fallback.id,
    title: "Album",
  });
  const timestamp = Date.now();
  const resolvedId = Number(db.prepare(
    `INSERT INTO library_artists
      (identity_key, mbid, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`mbid:${mbid}`, mbid, name, timestamp, timestamp).lastInsertRowid);
  const userId = Number(db.prepare(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
  ).run(`identity-repair-${process.pid}-${timestamp}`, "hash").lastInsertRowid);
  db.prepare(
    `INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
     VALUES (?, 'artist', ?, ?)`,
  ).run(userId, fallbackKey, timestamp);

  try {
    const resolved = upsertLibraryArtist({ identityKey: `mbid:${mbid}`, mbid, name });
    const artists = db.prepare("SELECT id, mbid FROM library_artists WHERE name = ?").all(name);
    const linkedAlbum = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(album.id);
    const star = db.prepare(
      "SELECT entity_key FROM subsonic_stars WHERE user_id = ? AND entity_kind = 'artist'",
    ).get(userId);

    assert.deepEqual(artists, [{ id: resolvedId, mbid }]);
    assert.equal(resolved.id, resolvedId);
    assert.equal(linkedAlbum.artist_id, resolvedId);
    assert.equal(star.entity_key, `mbid:${mbid}`);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    db.prepare("DELETE FROM library_artists WHERE name = ?").run(name);
  }
});

test("scanMusicRoot applies trusted job metadata when file tags omit identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-job-metadata-"));
  const source = `test-job-metadata-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({ common: {}, format: {} }),
      metadataEnricher: () => ({
        artistMbid: "11111111-1111-4111-8111-111111111111",
        albumMbid: "22222222-2222-4222-8222-222222222222",
        trackMbid: "33333333-3333-4333-8333-333333333333",
        artistName: "Aurral Artist",
        albumName: "Aurral Album",
        trackName: "Track",
      }),
    });
    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      releaseGroupMbid: "22222222-2222-4222-8222-222222222222",
      trackMbid: "33333333-3333-4333-8333-333333333333",
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot reads Aurral identity markers from portable comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-comment-metadata-"));
  const source = `test-comment-metadata-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({
        common: {
          comment: [{
            text: 'AURRAL_IDS={"artistMbid":"11111111-1111-4111-1111-111111111111","albumMbid":"22222222-2222-2222-2222-222222222222","trackMbid":"33333333-3333-3333-3333-333333333333"}',
          }],
        },
        format: {},
      }),
    });
    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-1111-111111111111",
      releaseGroupMbid: "22222222-2222-2222-2222-222222222222",
      trackMbid: "33333333-3333-3333-3333-333333333333",
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

test("an unchanged Lidarr rescan does not rewrite library rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-unchanged-"));
  const filePath = await createAudioFile(root, "Stable Artist/Stable Album/01 Stable Track.flac");
  const artistMbid = "10101010-1010-4010-8010-101010101010";
  const albumMbid = "20202020-2020-4020-8020-202020202020";
  const trackMbid = "30303030-3030-4030-8030-303030303030";
  const genreStatsKey = `libraryGenreStats:unchanged-${process.pid}`;
  const client = {
    isConfigured: () => true,
    request: async () => [{ id: 1010, artistName: "Stable Artist", foreignArtistId: artistMbid }],
    getAllAlbums: async () => [{
      id: 2020,
      artistId: 1010,
      title: "Stable Album",
      foreignAlbumId: albumMbid,
      path: path.dirname(filePath),
    }],
    getTracksByAlbumId: async () => [{
      id: 3030,
      albumId: 2020,
      title: "Stable Track",
      trackNumber: 1,
      foreignRecordingId: trackMbid,
      trackFileId: 4040,
    }],
    getTrackFilesByAlbumId: async () => [{ id: 4040, path: filePath, trackIds: [3030] }],
    getRootFolders: async () => [{ path: root }],
  };

  try {
    await indexLidarrLibrary({ client, syncSearch: false });
    db.prepare("UPDATE library_artists SET updated_at = 1 WHERE mbid = ?").run(artistMbid);
    db.prepare("UPDATE library_albums SET updated_at = 1 WHERE release_group_mbid = ?").run(albumMbid);
    db.prepare("UPDATE library_tracks SET updated_at = 1 WHERE mbid = ?").run(trackMbid);
    db.prepare("UPDATE library_media_files SET updated_at = 1 WHERE source = 'lidarr' AND path = ?")
      .run(filePath);

    const changesBefore = db.prepare("SELECT total_changes() AS count").get().count;
    const result = await indexLidarrLibrary({ client, syncSearch: false });
    const changesAfter = db.prepare("SELECT total_changes() AS count").get().count;

    assert.equal(result.changed, false);
    assert.equal(changesAfter - changesBefore, 2);
    assert.deepEqual({
      artist: db.prepare("SELECT updated_at FROM library_artists WHERE mbid = ?").get(artistMbid)?.updated_at,
      album: db.prepare("SELECT updated_at FROM library_albums WHERE release_group_mbid = ?").get(albumMbid)?.updated_at,
      track: db.prepare("SELECT updated_at FROM library_tracks WHERE mbid = ?").get(trackMbid)?.updated_at,
      media: db.prepare("SELECT updated_at FROM library_media_files WHERE source = 'lidarr' AND path = ?")
        .get(filePath)?.updated_at,
    }, { artist: 1, album: 1, track: 1, media: 1 });

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(genreStatsKey, "preserved");
    const configuredChangesBefore = db.prepare("SELECT total_changes() AS count").get().count;
    const configured = await scanConfiguredLibrary({
      musicRoot: path.join(root, "empty-aurral-root"),
      lidarrClient: client,
    });
    const configuredChangesAfter = db.prepare("SELECT total_changes() AS count").get().count;

    assert.equal(configured.local.changed, false);
    assert.equal(configured.lidarr.changed, false);
    assert.equal(configuredChangesAfter - configuredChangesBefore, 4);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(genreStatsKey)?.value, "preserved");
  } finally {
    db.prepare("DELETE FROM settings WHERE key = ?").run(genreStatsKey);
    deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("Lidarr persistence yields between album transactions", async () => {
  const artistMbid = "40404040-4040-4040-8040-404040404040";
  const firstAlbumMbid = "50505050-5050-4050-8050-505050505050";
  const secondAlbumMbid = "60606060-6060-4060-8060-606060606060";
  let scanning = true;
  const yieldedBetweenAlbums = new Promise((resolve) => {
    const inspect = () => {
      const firstExists = Boolean(db.prepare(
        "SELECT 1 FROM library_albums WHERE release_group_mbid = ?",
      ).get(firstAlbumMbid));
      const secondExists = Boolean(db.prepare(
        "SELECT 1 FROM library_albums WHERE release_group_mbid = ?",
      ).get(secondAlbumMbid));
      if (firstExists && !secondExists) return resolve(true);
      if (!scanning) return resolve(false);
      setImmediate(inspect);
    };
    setImmediate(inspect);
  });

  try {
    await indexLidarrLibrary({
      syncSearch: false,
      client: {
        isConfigured: () => true,
        request: async () => [{ id: 4040, artistName: "Yield Artist", foreignArtistId: artistMbid }],
        getAllAlbums: async () => [
          { id: 5050, artistId: 4040, title: "First Yield Album", foreignAlbumId: firstAlbumMbid },
          { id: 6060, artistId: 4040, title: "Second Yield Album", foreignAlbumId: secondAlbumMbid },
        ],
        getTracksByAlbumId: async () => [],
        getTrackFilesByAlbumId: async () => [],
        getRootFolders: async () => [],
      },
    });
    scanning = false;

    assert.equal(await yieldedBetweenAlbums, true);
  } finally {
    scanning = false;
    db.prepare("DELETE FROM library_artists WHERE mbid = ?").run(artistMbid);
  }
});

test("indexLidarrLibrary keeps artists without albums and refreshes monitoring metadata", async () => {
  const providerArtistId = "1212@deezer";
  let monitored = false;
  const client = {
    isConfigured: () => true,
    request: async () => [{
      id: 1212,
      artistName: "Albumless Artist",
      foreignArtistId: providerArtistId,
      monitored,
      monitor: monitored ? "all" : "none",
    }],
    getAllAlbums: async () => [],
    getRootFolders: async () => [],
  };

  try {
    await indexLidarrLibrary({ client });
    let projection = getCanonicalArtistProjection({ reference: providerArtistId })[0];
    assert.equal(projection?.name, "Albumless Artist");
    assert.equal(projection?.foreignArtistId, providerArtistId);
    assert.equal(projection?.providerId, "1212");
    assert.equal(projection?.id, projection?.canonicalId);
    assert.deepEqual(projection?.sources, ["lidarr"]);
    assert.equal(projection?.lidarrManaged, true);
    assert.equal(projection?.monitored, false);

    monitored = true;
    await indexLidarrLibrary({ client });
    projection = getCanonicalArtistProjection({ reference: providerArtistId })[0];
    assert.equal(projection?.monitored, true);
    assert.equal(projection?.monitorOption, "all");
  } finally {
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(
      `lidarr-artist:${providerArtistId}`,
    );
  }
});

test("indexLidarrLibrary keeps fully missing albums in canonical reads", async () => {
  const artistMbid = "13131313-1313-4131-8131-131313131313";
  const albumMbid = "14141414-1414-4141-8141-141414141414";
  const trackMbid = "15151515-1515-4151-8151-151515151515";
  const client = {
    isConfigured: () => true,
    request: async () => [{
      id: 1313,
      artistName: "Missing Album Artist",
      foreignArtistId: artistMbid,
    }],
    getAllAlbums: async () => [{
      id: 1414,
      artistId: 1313,
      title: "Fully Missing Album",
      foreignAlbumId: albumMbid,
      releaseDate: "2026-08-20",
      statistics: { sizeOnDisk: 0 },
    }],
    getTracksByAlbumId: async () => [{
      id: 1515,
      albumId: 1414,
      title: "Missing Track",
      trackNumber: 1,
      foreignRecordingId: trackMbid,
    }],
    getTrackFilesByAlbumId: async () => [],
    getRootFolders: async () => [],
  };

  try {
    await indexLidarrLibrary({ client });
    const page = getCanonicalLibraryPage({
      kind: "albums",
      page: 1,
      pageSize: 10,
      query: "Fully Missing Album",
    });

    assert.equal(page.items[0]?.title, "Fully Missing Album");
    assert.equal(page.items[0]?.availableTrackCount, 0);
    const albumMetadata = db.prepare(
      "SELECT metadata_json FROM library_albums WHERE mbid = ?",
    ).get(albumMbid);
    assert.equal(JSON.parse(albumMetadata.metadata_json).librarySource, "lidarr");
  } finally {
    db.prepare("DELETE FROM library_artists WHERE mbid = ?").run(artistMbid);
    db.prepare("DELETE FROM library_tracks WHERE mbid = ?").run(trackMbid);
  }
});

test("indexLidarrLibrary uses bulk track reads when Lidarr provides them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-bulk-index-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Bulk Artist/Bulk Album/01 Bulk Track.flac");
    const calls = [];
    const client = {
      isConfigured: () => true,
      request: async () => [{
        id: 707,
        artistName: "Bulk Artist",
        foreignArtistId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }],
      getAllAlbums: async () => [{
        id: 808,
        artistId: 707,
        title: "Bulk Album",
        foreignAlbumId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        path: path.join(root, "Bulk Artist", "Bulk Album"),
      }],
      getAllTracks: async ({ artistIds }) => {
        assert.deepEqual(artistIds, [707]);
        calls.push("tracks");
        return [{
          id: 809,
          albumId: 808,
          title: "Bulk Track",
          trackNumber: 1,
          foreignRecordingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          trackFileId: 810,
        }];
      },
      getTrackFilesByIds: async (trackFileIds) => {
        assert.deepEqual(trackFileIds, [810]);
        calls.push("files");
        return [{ id: 810, path: filePath, trackIds: [809], mediaInfo: { audioFormat: "FLAC" } }];
      },
      getAllTrackFiles: async () => {
        throw new Error("artist-scoped file read should not run when ID batches exist");
      },
      getTracksByAlbumId: async () => {
        throw new Error("per-album track read should not run when bulk reads exist");
      },
      getTrackFilesByAlbumId: async () => {
        throw new Error("per-album file read should not run when bulk reads exist");
      },
      getRootFolders: async () => [{ path: root }],
    };

    const result = await indexLidarrLibrary({ client });
    const snapshot = getLibrarySnapshot();
    const file = snapshot.files.find((entry) => entry.path === filePath);

    assert.deepEqual(calls, ["tracks", "files"]);
    assert.equal(result.filesIndexed, 1);
    assert.equal(file?.source, "lidarr");
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
  }
});

test("indexLidarrLibrary does not fan out per album when a bulk track read fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-bulk-fallback-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Fallback Artist/Fallback Album/01 Fallback Track.flac");
    const calls = [];
    const client = {
      isConfigured: () => true,
      request: async () => [{
        id: 717,
        artistName: "Fallback Artist",
        foreignArtistId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }],
      getAllAlbums: async () => [{
        id: 818,
        artistId: 717,
        title: "Fallback Album",
        foreignAlbumId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        path: path.join(root, "Fallback Artist", "Fallback Album"),
      }],
      getAllTracks: async () => {
        calls.push("bulk-tracks");
        throw new Error("bulk track read failed");
      },
      getAllTrackFiles: async () => {
        calls.push("bulk-files");
        return [];
      },
      getTracksByAlbumId: async (albumId) => {
        calls.push(`tracks:${albumId}`);
        return [{
          id: 819,
          albumId,
          title: "Fallback Track",
          trackNumber: 1,
          foreignRecordingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          trackFileId: 820,
        }];
      },
      getTrackFilesByAlbumId: async (albumId) => {
        calls.push(`files:${albumId}`);
        return [{ id: 820, path: filePath, trackIds: [819], mediaInfo: { audioFormat: "FLAC" } }];
      },
      getRootFolders: async () => [{ path: root }],
    };

    await assert.rejects(() => indexLidarrLibrary({ client }), /bulk track read failed/);
    assert.deepEqual(calls, ["bulk-tracks", "bulk-files"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
  }
});

test("indexLidarrLibrary does not fan out per album when a bulk track-file read fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-bulk-file-fallback-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "File Fallback Artist/File Fallback Album/01 File Fallback Track.flac");
    const calls = [];
    const client = {
      isConfigured: () => true,
      request: async () => [{
        id: 727,
        artistName: "File Fallback Artist",
        foreignArtistId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }],
      getAllAlbums: async () => [{
        id: 828,
        artistId: 727,
        title: "File Fallback Album",
        foreignAlbumId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        path: path.join(root, "File Fallback Artist", "File Fallback Album"),
      }],
      getAllTracks: async () => {
        calls.push("bulk-tracks");
        return [{ id: 829, albumId: 828 }];
      },
      getAllTrackFiles: async () => {
        calls.push("bulk-files");
        throw new Error("bulk track-file read failed");
      },
      getTracksByAlbumId: async (albumId) => {
        calls.push(`tracks:${albumId}`);
        return [{
          id: 829,
          albumId,
          title: "File Fallback Track",
          trackNumber: 1,
          foreignRecordingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          trackFileId: 830,
        }];
      },
      getTrackFilesByAlbumId: async (albumId) => {
        calls.push(`files:${albumId}`);
        return [{ id: 830, path: filePath, trackIds: [829], mediaInfo: { audioFormat: "FLAC" } }];
      },
      getRootFolders: async () => [{ path: root }],
    };

    await assert.rejects(() => indexLidarrLibrary({ client }), /bulk track-file read failed/);
    assert.deepEqual(calls, ["bulk-tracks", "bulk-files"]);
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
  const aurralPath = path.join(root, "Aurral/Eve 6/01 Showerhead.flac");
  try {
    const artist = upsertLibraryArtist({
      identityKey: `mbid:${artistMbid}`,
      mbid: artistMbid,
      name: "Eve 6",
    });
    const album = upsertLibraryAlbum({
      identityKey: `release-group:${secondAlbumMbid}`,
      mbid: secondAlbumMbid,
      releaseGroupMbid: secondAlbumMbid,
      artistId: artist.id,
      title: "Inside Out",
    });
    const track = upsertLibraryTrack({
      identityKey: `recording:${recordingMbid}`,
      mbid: recordingMbid,
      title: "Showerhead",
      artistName: "Eve 6",
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: aurralPath,
    });

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
        AND media.album_id = album_track.album_id
        AND media.source = 'lidarr'
        AND media.available = 1
       WHERE album.identity_key IN (?, ?)
       GROUP BY album.id
       ORDER BY album.title`,
    ).all(`release-group:${firstAlbumMbid}`, `release-group:${secondAlbumMbid}`);
    assert.deepEqual(albumRows, [
      { title: "Eve 6", files: 1 },
      { title: "Inside Out", files: 0 },
    ]);
    const lidarrPage = getCanonicalLibraryPage({
      source: "lidarr",
      kind: "albums",
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(lidarrPage.items.map((item) => item.title), ["Eve 6"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = 'lidarr' AND path = ?").run(filePath);
    db.prepare("DELETE FROM library_media_files WHERE source = 'aurral' AND path = ?").run(aurralPath);
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

test("a Lidarr rescan marks the final removed media file unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-final-removal-"));
  let filePath;
  const artist = { id: 47, artistName: "Removal Artist", foreignArtistId: "47474747-4747-4747-8747-474747474747" };
  const album = { id: 48, artistId: 47, title: "Removal Album", foreignAlbumId: "48484848-4848-4848-8848-484848484848" };
  const track = { id: 49, albumId: 48, title: "Removal Track", trackNumber: 1, foreignRecordingId: "49494949-4949-4949-8949-494949494949", trackFileId: 50 };
  try {
    filePath = await createAudioFile(root, "Removal Artist/Removal Album/01 Removal Track.flac");
    const client = {
      isConfigured: () => true,
      request: async () => [artist],
      getAllAlbums: async () => [album],
      getTracksByAlbumId: async () => [track],
      getTrackFilesByAlbumId: async () => [{ id: 50, path: filePath, trackIds: [49] }],
      getRootFolders: async () => [{ path: root }],
    };
    await indexLidarrLibrary({ client });
    client.getTrackFilesByAlbumId = async () => [];
    await indexLidarrLibrary({ client });
    const file = getLibrarySnapshot().files.find((entry) => entry.path === filePath);

    assert.equal(file?.available, 0);
  } finally {
    if (filePath) deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});
