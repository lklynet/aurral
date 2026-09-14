import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, subsonic, libraryStore] =
  await setupIsolatedBackend(
    "subsonic-library",
    "backend/config/db-sqlite.js",
    "backend/services/subsonicLibraryService.js",
    "backend/services/libraryMediaStore.js",
  );

const {
  getAlbumList,
  getMusicDirectory,
  getTopSongs,
  idFor,
  parseId,
  starMany,
} = subsonic;

const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

function addAlbum({ artist, title, releaseDate, trackTitle }) {
  const album = upsertLibraryAlbum({
    identityKey: `test-album:${title}`,
    artistId: artist.id,
    title,
    albumArtist: artist.name,
    releaseDate,
  });
  const track = upsertLibraryTrack({
    identityKey: `test-track:${trackTitle}`,
    title: trackTitle,
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id,
    source: "lidarr",
    path: `/test/${title}/${trackTitle}.flac`,
    format: "flac",
    available: true,
  });
}

test("keeps Subsonic IDs readable while safely encoding key content", () => {
  const key = "release-group:44444444-4444-4444-8444-444444444444";
  const specialKey = `${key}%&`;
  const encoded = `album:${encodeURIComponent(key)}`;

  assert.equal(idFor("album", key), `album:${key}`);
  assert.deepEqual(parseId(idFor("album", key)), { kind: "album", key });
  assert.equal(idFor("album", specialKey), `album:${key}%25%26`);
  assert.deepEqual(parseId(idFor("album", specialKey)), {
    kind: "album",
    key: specialKey,
  });
  assert.deepEqual(parseId(encoded), { kind: "album", key });
});

test("starMany validates duplicate and equivalent encoded canonical targets", () => {
  const user = db.prepare(
    "INSERT INTO users (username, password_hash, role, permissions) VALUES (?, '', 'user', '{}') RETURNING id",
  ).get("subsonic-star-many");
  const key = "test-track:Old Song";
  const encoded = `song:${encodeURIComponent(key)}`;
  const alternate = encoded.replaceAll("%3A", "%3a");
  assert.equal(starMany(user, [encoded, encoded]), true);
  assert.equal(starMany(user, [encoded, alternate]), true);
  assert.equal(starMany(user, [encoded, "song:missing"]), false);
});

test.before(() => {
  resetDatabase(db);
  const artistA = upsertLibraryArtist({
    identityKey: "test-artist:artist-a",
    name: "Artist A",
  });
  const artistB = upsertLibraryArtist({
    identityKey: "test-artist:artist-b",
    name: "Artist B",
  });
  addAlbum({
    artist: artistA,
    title: "Old Album",
    releaseDate: "2010-01-01",
    trackTitle: "Old Song",
  });
  addAlbum({
    artist: artistA,
    title: "New Album",
    releaseDate: "2024-01-01",
    trackTitle: "New Song",
  });
  addAlbum({
    artist: artistB,
    title: "Artist A Collection",
    releaseDate: "2022-01-01",
    trackTitle: "Other Artist Song",
  });
  db.prepare(
    `UPDATE library_media_files
     SET created_at = CASE
       WHEN path LIKE '%Old Album%' THEN 300
       WHEN path LIKE '%New Album%' THEN 200
       ELSE 100
     END`,
  ).run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("orders newest albums by media arrival before applying pagination", () => {
  assert.deepEqual(
    getAlbumList({ type: "newest", size: 1 }).map((album) => album.title),
    ["Old Album"],
  );
  assert.deepEqual(
    getAlbumList({ type: "newest", size: 1, offset: 1 }).map((album) => album.title),
    ["New Album"],
  );
  assert.deepEqual(
    getAlbumList({ type: "byYear", fromYear: 2024, toYear: 2010 }).map((album) => album.title),
    ["New Album", "Artist A Collection", "Old Album"],
  );
});

test("returns top songs only for the requested artist", () => {
  const songs = getTopSongs("Artist A", { count: 10 });
  assert.deepEqual(songs.map((song) => song.title), ["New Song", "Old Song"]);
  assert.equal(songs.every((song) => song.artist === "Artist A"), true);
  assert.deepEqual(
    getTopSongs("  test-artist:artist-a  ", { count: 10 }).map((song) => song.title),
    ["New Song", "Old Song"],
  );
});

test("marks album entries as directories in artist music directories", () => {
  const directory = getMusicDirectory(`artist:${encodeURIComponent("test-artist:artist-a")}`);

  assert.ok(directory);
  assert.equal(directory.child.length, 2);
  assert.equal(directory.child.every((album) => album.isDir === true), true);
});
