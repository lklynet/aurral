import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, store, query, { initializeLibraryGenreIndex }] = await setupIsolatedBackend(
  "library-genre-index",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryQueryService.js",
  "backend/config/library-genre-index.js",
);
test.after(() => cleanupIsolatedState(state));

test("genre reads retain inheritance, metadata shapes, availability, and updates", () => {
  const artist = store.upsertLibraryArtist({
    identityKey: "genre:artist", name: "Genre Artist", metadata: { common: { genre: "Rock" } },
  });
  store.upsertLibraryArtist({ identityKey: "genre:artist", name: "Genre Artist", metadata: { genres: ["Rock"] } });
  const album = store.upsertLibraryAlbum({
    identityKey: "genre:album", artistId: artist.id, title: "Genre Album",
    metadata: { genre: ["Jazz", "Jazz"] },
  });
  const track = store.upsertLibraryTrack({
    identityKey: "genre:track", title: "Genre Track",
    metadata: { genres: ["Soul", " Soul "], tags: { genre: { first: " Ambient " } } },
  });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const file = { trackId: track.id, albumId: album.id, source: "aurral", path: "/genre/track.flac" };
  store.upsertLibraryMediaFile(file);
  const read = (genre) => query.getLibraryPage({ kind: "tracks", genre, pageSize: 100 });
  for (const genre of ["rock", "jazz", "soul", "ambient"]) {
    assert.deepEqual(read(genre).items.map((item) => item.id), [track.id]);
  }
  const genres = () => query.getLibraryPage({ kind: "genres", pageSize: 100 }).items;
  assert.deepEqual(genres(), [
    { name: "Ambient", artists: 0, albums: 0, tracks: 1 },
    { name: "Jazz", artists: 0, albums: 1, tracks: 0 },
    { name: "Rock", artists: 1, albums: 0, tracks: 0 },
    { name: "Soul", artists: 0, albums: 0, tracks: 1 },
  ]);
  assert.deepEqual(query.getLibraryGenres(), ["Ambient", "Jazz", "Rock", "Soul"].map((value) => ({
    value, albumCount: 1, songCount: 1,
  })));
  store.upsertLibraryTrack({ identityKey: track.identity_key, title: track.title, metadata: { genre: "Folk" } });
  assert.equal(read("soul").total, 0);
  assert.equal(read("ambient").total, 0);
  assert.equal(read("folk").total, 1);
  assert.deepEqual(genres().map((entry) => entry.name), ["Folk", "Jazz", "Rock"]);
  store.upsertLibraryMediaFile({ ...file, available: false });
  assert.deepEqual(query.getLibraryGenres({ availableOnly: true }), []);
  assert.deepEqual(query.getLibraryGenres({ source: "lidarr" }), []);
  assert.deepEqual(query.getLibraryGenres().map((genre) => genre.value), ["Folk", "Jazz", "Rock"]);
  assert.equal(query.getLibraryPage({ kind: "tracks", genre: "folk", availableOnly: true }).total, 0);
  assert.equal(read("folk").total, 1);
  assert.equal(query.getLibraryPage({ kind: "tracks", genre: "folk", source: "lidarr" }).total, 0);
  db.prepare("UPDATE library_tracks SET metadata_json = '{' WHERE id = ?").run(track.id);
  assert.equal(read("folk").total, 0);
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  query.invalidateLibraryQueryCache();
  assert.deepEqual(genres(), []);
});

test("startup backfills existing genres, repairs missed updates, and leaves library rows untouched", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "genre:legacy-artist", name: "Legacy Artist" });
  const album = store.upsertLibraryAlbum({ identityKey: "genre:legacy-album", artistId: artist.id, title: "Legacy Album" });
  const track = store.upsertLibraryTrack({ identityKey: "genre:legacy", title: "Legacy Track", metadata: { genre: "Pop" } });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  store.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: "/genre/legacy.flac" });
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'library_genres_*'").all()) {
    db.exec(`DROP TRIGGER ${name}`);
  }
  db.exec("DROP TABLE library_entity_genres");
  const before = db.prepare("SELECT * FROM library_tracks WHERE id = ?").get(track.id);
  initializeLibraryGenreIndex(db);
  assert.deepEqual(db.prepare("SELECT * FROM library_tracks WHERE id = ?").get(track.id), before);
  const read = (genre) => query.getLibraryPage({ kind: "tracks", genre, pageSize: 100 }).total;
  assert.equal(read("pop"), 1);
  query.rebuildLibraryGenreStats();
  db.exec("DROP TRIGGER library_genres_tracks_update");
  db.prepare("UPDATE library_tracks SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ genre: "Classical" }), track.id);
  initializeLibraryGenreIndex(db);
  query.invalidateLibraryQueryCache({ persistedGenres: false });
  assert.equal(read("pop"), 0);
  assert.equal(read("classical"), 1);
  assert.deepEqual(query.getLibraryPage({ kind: "genres" }).items.map((genre) => genre.name), ["Classical"]);
  db.exec("DROP TRIGGER library_genres_tracks_update");
  db.exec("CREATE TRIGGER library_genres_tracks_update AFTER UPDATE OF metadata_json ON library_tracks BEGIN SELECT 1; END");
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'libraryGenreIndexVersion'").run();
  initializeLibraryGenreIndex(db);
  db.prepare("UPDATE library_tracks SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ genre: "Blues" }), track.id);
  query.invalidateLibraryQueryCache({ persistedGenres: false });
  assert.equal(read("classical"), 0);
  assert.equal(read("blues"), 1);
  db.prepare("UPDATE library_tracks SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ genre: "Blues; Soul" }), track.id);
  db.prepare("DELETE FROM library_entity_genres WHERE entity_id = ?").run(track.id);
  db.prepare("INSERT INTO library_entity_genres (entity_kind, entity_id, name) VALUES ('tracks', ?, 'Blues; Soul')").run(track.id);
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'libraryGenreIndexVersion'").run();
  initializeLibraryGenreIndex(db);
  query.invalidateLibraryQueryCache({ persistedGenres: false });
  assert.deepEqual(query.getLibraryPage({ kind: "genres" }).items.map((genre) => genre.name), ["Blues", "Soul"]);
  const changes = db.prepare("SELECT total_changes() AS total").get().total;
  initializeLibraryGenreIndex(db);
  assert.equal(db.prepare("SELECT total_changes() AS total").get().total, changes);
});

test("genre filters split semicolon tags and keep other separators intact", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "genre:split-artist", name: "Split Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: "genre:split-album", artistId: artist.id, title: "Split Album",
    metadata: {
      genre: "Metalcore;Melodic Metalcore; Rock",
      common: { genre: ["Alt/Indie", "Folk, World, & Country;"] },
    },
  });
  const track = store.upsertLibraryTrack({ identityKey: "genre:split-track", title: "Split Track" });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  store.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: "/genre/split.flac" });
  const albums = (genre) => query.getLibraryPage({ kind: "albums", genre, pageSize: 100 }).items.map((item) => item.id);
  const expected = ["Alt/Indie", "Folk, World, & Country", "Melodic Metalcore", "Metalcore", "Rock"];
  for (const genre of expected) assert.deepEqual(albums(genre.toLowerCase()), [album.id]);
  assert.deepEqual(albums("metalcore;melodic metalcore; rock"), []);
  assert.deepEqual(albums("alt"), []);
  assert.deepEqual(
    query.getLibraryPage({ kind: "genres", pageSize: 100 }).items
      .filter((genre) => expected.includes(genre.name) || /[;,/]/.test(genre.name))
      .map((genre) => genre.name),
    expected,
  );
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  query.invalidateLibraryQueryCache();
});

test("Subsonic genre counts deduplicate files and preserve inherited genres across albums", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "genre:counts-artist", name: "Counts Artist", metadata: { genre: ["Inherited", "Inherited"] } });
  const first = store.upsertLibraryAlbum({ identityKey: "genre:counts-first", artistId: artist.id, title: "First", metadata: { genres: ["Album One"] } });
  const second = store.upsertLibraryAlbum({ identityKey: "genre:counts-second", artistId: artist.id, title: "Second", metadata: { tags: { genre: ["Album Two"] } } });
  const shared = store.upsertLibraryTrack({ identityKey: "genre:counts-shared", title: "Shared", metadata: { genres: ["Inherited", "Track Only", " Track Only "] } });
  const missing = store.upsertLibraryTrack({ identityKey: "genre:counts-missing", title: "Missing", metadata: { genre: "Track Only" } });
  for (const [albumId, trackId] of [[first.id, shared.id], [second.id, shared.id], [first.id, missing.id]]) {
    store.linkLibraryAlbumTrack({ albumId, trackId });
  }
  for (const file of [
    { trackId: shared.id, albumId: first.id, source: "flow", path: "/genre/counts-one.flac" },
    { trackId: shared.id, albumId: first.id, source: "flow", path: "/genre/counts-duplicate.flac" },
    { trackId: shared.id, albumId: second.id, source: "lidarr", path: "/genre/counts-two.flac" },
    { trackId: missing.id, albumId: first.id, source: "flow", path: "/genre/counts-missing.flac", available: false },
  ]) store.upsertLibraryMediaFile(file);
  const expected = ["Album One", "Inherited", "Track Only"];
  assert.deepEqual(query.getLibraryGenres({ source: "flow", availableOnly: true }), expected.map((value) => ({ value, albumCount: 1, songCount: 1 })));
  assert.deepEqual(query.getLibraryGenres({ source: "flow" }), expected.map((value) => ({ value, albumCount: 1, songCount: 2 })));
  assert.deepEqual(query.getLibraryGenres({ source: "lidarr", availableOnly: true }), ["Album Two", "Inherited", "Track Only"].map((value) => ({ value, albumCount: 1, songCount: 1 })));
  const values = new Set([...expected, "Album Two"]);
  assert.deepEqual(query.getLibraryGenres({ availableOnly: true }).filter((genre) => values.has(genre.value)), [
    { value: "Album One", albumCount: 1, songCount: 1 },
    { value: "Album Two", albumCount: 1, songCount: 1 },
    { value: "Inherited", albumCount: 2, songCount: 2 },
    { value: "Track Only", albumCount: 2, songCount: 2 },
  ]);
});
