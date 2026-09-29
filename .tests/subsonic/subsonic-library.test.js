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
  resolveCanonicalTracks,
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
    { artistName: "Artist B", trackName: "Mbid Song (Remaster)", trackMbid: "44444444-4444-4444-8444-444444444444" },
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
  // Same recording MBID, different title: the canonical track (and its playlist id) still wins.
  assert.equal(resolved[4].track.identityKey, "test-track:Mbid Song");
  assert.equal(resolved.slice(5).every((entry) => entry === null), true);
  assert.ok(statements <= 4, `expected a handful of statements, ran ${statements}`);
});

test("favorite reads preserve shared relationships, media filters, and user isolation", async () => {
  const { getCanonicalLibrary } = await import("../../backend/services/libraryQueryService.js");
  const existing = db.prepare("SELECT id, identity_key FROM library_tracks WHERE title = 'Old Song'").get();
  const guest = upsertLibraryArtist({ identityKey: "favorite:guest", name: "Guest Artist" });
  const guestAlbum = upsertLibraryAlbum({
    identityKey: "favorite:guest-album",
    artistId: guest.id,
    title: "Guest Album",
  });
  linkLibraryAlbumTrack({ albumId: guestAlbum.id, trackId: existing.id });
  const missing = upsertLibraryTrack({ identityKey: "favorite:no-media", title: "Unfinished Song" });
  linkLibraryAlbumTrack({ albumId: guestAlbum.id, trackId: missing.id });
  const scoped = upsertLibraryMediaFile({
    albumId: guestAlbum.id,
    trackId: existing.id,
    source: "aurral",
    path: "/test/favorite/guest.flac",
    available: false,
  });
  const createUser = db.prepare(
    "INSERT INTO users (username, password_hash, role, permissions) VALUES (?, '', 'user', '{}') RETURNING id",
  );
  const first = createUser.get("favorite-reader-first");
  const second = createUser.get("favorite-reader-second");
  const star = db.prepare(
    "INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, ?)",
  );
  star.run(first.id, "song", existing.identity_key, 1000);
  star.run(first.id, "album", "favorite:guest-album", 2000);
  star.run(second.id, "song", "favorite:no-media", 3000);
  const starsBefore = db.prepare("SELECT * FROM subsonic_stars ORDER BY user_id, entity_kind, entity_key").all();
  const jobsBefore = db.prepare("SELECT COUNT(*) AS count FROM playlist_download_jobs").get();

  try {
    const result = subsonic.getStarredWithLibrary(first);
    assert.deepEqual(result.starred.song.map((song) => song.id), [idFor("song", existing.identity_key)]);
    assert.deepEqual(result.starred.album.map((album) => album.id), [idFor("album", "favorite:guest-album")]);
    assert.equal(result.starred.song[0].starred, new Date(1000).toISOString());
    assert.equal(result.library.tracks.length, 1);
    assert.equal(result.library.tracks[0].albums.length, 2);
    assert.equal(result.library.tracks[0].files.length, 2);
    assert.deepEqual(subsonic.getStarred(second), { artist: [], album: [], song: [] });
    assert.deepEqual(subsonic.getStarredWithLibrary(second).library.tracks, []);

    const favoriteKeys = [
      { kind: "song", key: existing.identity_key },
      { kind: "song", key: existing.identity_key },
      { kind: "album", key: "favorite:guest-album" },
      { kind: "song", key: "removed-target" },
    ];
    const filtered = getCanonicalLibrary({ source: "aurral", favoriteKeys });
    assert.deepEqual(filtered.albums.map((album) => album.title), ["Guest Album"]);
    assert.deepEqual(filtered.tracks.map((track) => track.id), [existing.id]);
    assert.deepEqual(filtered.tracks[0].files.map((file) => file.path), ["/test/favorite/guest.flac"]);
    assert.deepEqual(getCanonicalLibrary({
      source: "aurral", availableOnly: true, favoriteKeys,
    }), { artists: [], albums: [], tracks: [] });
    assert.deepEqual(getCanonicalLibrary({ favoriteKeys: [] }), { artists: [], albums: [], tracks: [] });
    assert.deepEqual(db.prepare("SELECT * FROM subsonic_stars ORDER BY user_id, entity_kind, entity_key").all(), starsBefore);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM playlist_download_jobs").get(), jobsBefore);
  } finally {
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(first.id, second.id);
    db.prepare("DELETE FROM library_media_files WHERE id = ?").run(scoped.id);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(guestAlbum.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(guestAlbum.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(guest.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(missing.id);
  }
});
