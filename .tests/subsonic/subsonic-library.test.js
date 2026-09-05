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

const { getAlbumList, getTopSongs, resolveCanonicalTracks, starMany } = subsonic;

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

test("resolves playlist descriptors to library tracks in bulk", () => {
  const artistB = upsertLibraryArtist({ identityKey: "test-artist:artist-b-mbid", name: "Artist B" });
  const album = upsertLibraryAlbum({
    identityKey: "test-album:Mbid Album",
    artistId: artistB.id,
    title: "Mbid Album",
    albumArtist: artistB.name,
  });
  const track = upsertLibraryTrack({
    identityKey: "test-track:Mbid Song",
    mbid: "44444444-4444-4444-8444-444444444444",
    title: "Mbid Song",
    artistName: artistB.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id,
    source: "lidarr",
    path: "/test/Mbid Album/Mbid Song.flac",
    format: "flac",
    available: true,
  });

  const descriptors = [
    { artistName: "Artist A", trackName: "Old Song" },
    { artistName: "Artist B", trackName: "Mbid Song", trackMbid: "44444444-4444-4444-8444-444444444444" },
    { artistName: "Artist B", trackName: "Old Song" },
    null,
    ...Array.from({ length: 1000 }, (_, index) => ({ artistName: "Artist A", trackName: `Missing ${index}` })),
  ];
  const prepare = db.prepare;
  let statements = 0;
  db.prepare = function spy(...args) {
    statements += 1;
    return prepare.apply(this, args);
  };
  let resolved;
  try {
    resolved = resolveCanonicalTracks(descriptors);
  } finally {
    db.prepare = prepare;
  }
  assert.equal(resolved.length, descriptors.length);
  assert.equal(resolved[0].track.title, "Old Song");
  assert.equal(resolved[0].track.artistName, "Artist A");
  assert.equal(resolved[1].track.identityKey, "test-track:Mbid Song");
  assert.equal(resolved[2], null);
  assert.equal(resolved[3], null);
  assert.equal(resolved.slice(4).every((entry) => entry === null), true);
  assert.ok(statements <= 4, `expected a handful of statements, ran ${statements}`);
});
