import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";
import {
  getCanonicalArtistMbids,
  getCanonicalLibrary,
  getCanonicalLibraryForAlbumReferences,
  getCanonicalLibraryForArtists,
  getCanonicalLibraryPage,
  invalidateCanonicalLibraryCache,
} from "../../backend/services/libraryQueryService.js";
import { toPublicLibrary } from "../../backend/routes/library/handlers/canonical.js";
import { getCanonicalLibraryReadModelForAlbumReferences } from "../../backend/services/canonicalLibraryReadAdapter.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryArtist,
  upsertLibraryAlbum,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
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
    assert.strictEqual(getCanonicalLibrary(), all);
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

test("scoped canonical reads keep ownership lookups off unrelated library records", () => {
  const key = `query-scoped-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: `${key}-artist`,
    name: "Scoped Artist",
  });
  const unrelatedArtist = upsertLibraryArtist({
    identityKey: `${key}:unrelated-artist`,
    mbid: `${key}-unrelated-artist`,
    name: "Unrelated Artist",
  });
  const releaseGroupMbid = `${key}-release-group`;
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}-album`,
    releaseGroupMbid,
    artistId: artist.id,
    title: "Scoped Album",
  });
  const unrelatedAlbum = upsertLibraryAlbum({
    identityKey: `${key}:unrelated-album`,
    mbid: `${key}-unrelated-album`,
    artistId: unrelatedArtist.id,
    title: "Unrelated Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: `${key}-owned-track`,
    title: "Owned Track",
    artistName: artist.name,
  });
  const missingTrack = upsertLibraryTrack({
    identityKey: `${key}:missing-track`,
    mbid: `${key}-missing-track`,
    title: "Missing Track",
    artistName: artist.name,
  });
  const unrelatedTrack = upsertLibraryTrack({
    identityKey: `${key}:unrelated-track`,
    mbid: `${key}-unrelated-track`,
    title: "Unrelated Track",
    artistName: unrelatedArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
  linkLibraryAlbumTrack({ albumId: unrelatedAlbum.id, trackId: unrelatedTrack.id, trackNumber: 1 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });
  const unrelatedPath = `/tmp/${key}/unrelated.flac`;
  upsertLibraryMediaFile({
    trackId: unrelatedTrack.id,
    albumId: unrelatedAlbum.id,
    source: "aurral",
    path: unrelatedPath,
  });

  try {
    assert.deepEqual(
      [...getCanonicalArtistMbids({ source: "all", mbids: [artist.mbid] })],
      [artist.mbid],
    );

    const artistLibrary = getCanonicalLibraryForArtists({
      source: "all",
      availableOnly: false,
      mbids: [artist.mbid],
    });
    assert.deepEqual(artistLibrary.artists.map((entry) => entry.mbid), [artist.mbid]);
    assert.deepEqual(artistLibrary.albums.map((entry) => entry.mbid), [album.mbid]);

    const albumLibrary = getCanonicalLibraryForAlbumReferences({
      source: "all",
      availableOnly: false,
      references: [releaseGroupMbid],
    });
    assert.deepEqual(albumLibrary.albums.map((entry) => entry.mbid), [album.mbid]);
    assert.deepEqual(
      albumLibrary.tracks.map((entry) => entry.mbid),
      [ownedTrack.mbid, missingTrack.mbid],
    );
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path IN (?, ?)").run(ownedPath, unrelatedPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)").run(
      album.id,
      unrelatedAlbum.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?, ?)").run(
      ownedTrack.id,
      missingTrack.id,
      unrelatedTrack.id,
    );
    db.prepare("DELETE FROM library_albums WHERE id IN (?, ?)").run(album.id, unrelatedAlbum.id);
    db.prepare("DELETE FROM library_artists WHERE id IN (?, ?)").run(
      artist.id,
      unrelatedArtist.id,
    );
    invalidateCanonicalLibraryCache();
  }
});

test("album-reference reads preserve identity keys and album-specific ownership", () => {
  const key = `query-album-ownership-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Shared Artist" });
  const ownedAlbum = upsertLibraryAlbum({
    identityKey: `${key}:owned-album`,
    artistId: artist.id,
    title: "Owned Album",
  });
  const missingAlbum = upsertLibraryAlbum({
    identityKey: `${key}:missing-album`,
    artistId: artist.id,
    title: "Missing Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    mbid: `${key}-track`,
    title: "Shared Track",
    artistName: artist.name,
  });
  const missingAlbumTrack = upsertLibraryTrack({
    identityKey: `${key}:missing-album-track`,
    mbid: `${key}-missing-album-track`,
    title: "Owned Only By Missing Album",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: ownedAlbum.id, trackId: track.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: missingAlbum.id, trackId: track.id, trackNumber: 1 });
  linkLibraryAlbumTrack({
    albumId: missingAlbum.id,
    trackId: missingAlbumTrack.id,
    trackNumber: 2,
  });
  const ownedPath = `/tmp/${key}/owned.flac`;
  const missingAlbumPath = `/tmp/${key}/missing-album.flac`;
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: ownedAlbum.id,
    source: "aurral",
    path: ownedPath,
  });
  upsertLibraryMediaFile({
    trackId: missingAlbumTrack.id,
    albumId: missingAlbum.id,
    source: "aurral",
    path: missingAlbumPath,
  });

  try {
    const readModel = getCanonicalLibraryReadModelForAlbumReferences({
      source: "aurral",
      availableOnly: false,
      references: [ownedAlbum.identity_key, missingAlbum.identity_key],
    });
    const owned = readModel.albums.find((album) => album.canonicalId === ownedAlbum.id);
    const missing = readModel.albums.find((album) => album.canonicalId === missingAlbum.id);
    assert.equal(owned?.identityKey, ownedAlbum.identity_key);
    assert.equal(missing?.identityKey, missingAlbum.identity_key);
    assert.equal(owned?.statistics.trackFileCount, 1);
    assert.equal(missing?.statistics.trackFileCount, 1);
    assert.equal(
      readModel.tracks.find((entry) => entry.albumId === missingAlbum.id)?.hasFile,
      false,
    );
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path IN (?, ?)").run(
      ownedPath,
      missingAlbumPath,
    );
    db.prepare("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)").run(
      ownedAlbum.id,
      missingAlbum.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(
      track.id,
      missingAlbumTrack.id,
    );
    db.prepare("DELETE FROM library_albums WHERE id IN (?, ?)").run(
      ownedAlbum.id,
      missingAlbum.id,
    );
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateCanonicalLibraryCache();
  }
});

test("canonical newest ordering follows library arrival time", () => {
  const key = `query-newest-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Newest Fixture" });
  const oldAlbum = upsertLibraryAlbum({
    identityKey: `${key}:old-album`,
    artistId: artist.id,
    title: "Old Album",
    releaseDate: "2020-01-01",
  });
  const newAlbum = upsertLibraryAlbum({
    identityKey: `${key}:new-album`,
    artistId: artist.id,
    title: "Recently Added",
    releaseDate: "1990-01-01",
  });
  const oldTrack = upsertLibraryTrack({
    identityKey: `${key}:old-track`,
    title: "Old Track",
    artistName: "Newest Fixture",
  });
  const newTrack = upsertLibraryTrack({
    identityKey: `${key}:new-track`,
    title: "New Track",
    artistName: "Newest Fixture",
  });
  linkLibraryAlbumTrack({ albumId: oldAlbum.id, trackId: oldTrack.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: newAlbum.id, trackId: newTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: oldTrack.id,
    albumId: oldAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/old.flac`,
  });
  upsertLibraryMediaFile({
    trackId: newTrack.id,
    albumId: newAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/new.flac`,
  });
  const now = Date.now();
  db.prepare("UPDATE library_media_files SET created_at = ? WHERE path = ?").run(
    now - 60_000,
    `/tmp/${key}/old.flac`,
  );
  db.prepare("UPDATE library_media_files SET created_at = ? WHERE path = ?").run(
    now,
    `/tmp/${key}/new.flac`,
  );

  try {
    const page = getCanonicalLibraryPage({
      source: "aurral",
      kind: "albums",
      page: 1,
      pageSize: 2,
      sort: "newest",
    });
    assert.deepEqual(page.items.map((item) => item.title), ["Recently Added", "Old Album"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path LIKE ?").run(`/tmp/${key}/%`);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)").run(
      oldAlbum.id,
      newAlbum.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(oldTrack.id, newTrack.id);
    db.prepare("DELETE FROM library_albums WHERE id IN (?, ?)").run(oldAlbum.id, newAlbum.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("canonical album track pages keep the selected album relationship", () => {
  const key = `query-album-scope-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Eve 6" });
  const firstAlbum = upsertLibraryAlbum({
    identityKey: `${key}:first-album`,
    artistId: artist.id,
    title: "Eve 6",
    releaseDate: "1998",
  });
  const selectedAlbum = upsertLibraryAlbum({
    identityKey: `${key}:selected-album`,
    artistId: artist.id,
    title: "Inside Out",
    releaseDate: "1998",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Showerhead",
    artistName: "Eve 6",
  });
  linkLibraryAlbumTrack({ albumId: firstAlbum.id, trackId: track.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: selectedAlbum.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: selectedAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/track.flac`,
  });

  try {
    const page = getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: selectedAlbum.id,
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(page.items[0].albums.map((entry) => entry.albumId), [selectedAlbum.id]);
    assert.deepEqual(page.albums.map((album) => album.title), ["Inside Out"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(`/tmp/${key}/track.flac`);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)").run(
      firstAlbum.id,
      selectedAlbum.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id IN (?, ?)").run(
      firstAlbum.id,
      selectedAlbum.id,
    );
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("canonical album track pages include indexed tracks without media", () => {
  const key = `query-album-missing-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Partial Fixture" });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: artist.id,
    title: "Partial Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: `${key}-owned`,
    title: "Owned Track",
    artistName: "Partial Fixture",
  });
  const missingTrack = upsertLibraryTrack({
    identityKey: `${key}:missing-track`,
    mbid: `${key}-missing`,
    title: "Missing Track",
    artistName: "Partial Fixture",
    metadata: { genres: ["Electronic"] },
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });

  try {
    const page = getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: album.id,
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(page.items.map((track) => track.title), ["Owned Track", "Missing Track"]);
    assert.equal(page.items[0].files.length, 1);
    assert.deepEqual(page.items[1].files, []);
    assert.equal(page.albums[0].trackCount, 2);
    assert.equal(page.albums[0].availableTrackCount, 1);

    const filtered = getCanonicalLibraryPage({
      kind: "tracks",
      albumId: album.id,
      page: 1,
      pageSize: 10,
      query: "missing",
      genre: "electronic",
      sort: "name",
      direction: "desc",
    });
    assert.deepEqual(filtered.items.map((track) => track.title), ["Missing Track"]);

    const artistScoped = getCanonicalLibraryPage({
      kind: "tracks",
      albumId: album.id,
      artistId: artist.id,
      page: 1,
      pageSize: 10,
      sort: "name",
      direction: "desc",
    });
    assert.deepEqual(artistScoped.items.map((track) => track.title), ["Owned Track", "Missing Track"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(ownedPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(ownedTrack.id, missingTrack.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
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

test("canonical album responses proxy public metadata artwork", () => {
  const remoteUrl = "https://cdn.example.test/cover.jpg?size=500";
  const response = toPublicLibrary({
    artists: [],
    albums: [{
      id: 1,
      metadata: {
        images: [
          { url: "/MediaCover/Albums/1/cover.jpg" },
          { remoteUrl },
        ],
      },
    }],
    tracks: [],
  });

  assert.equal(
    response.albums[0].coverUrl,
    "/api/image-proxy?src=" + encodeURIComponent(remoteUrl),
  );
});
