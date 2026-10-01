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
  const album = store.upsertLibraryAlbum({
    identityKey: "genre:album", artistId: artist.id, title: "Genre Album",
    metadata: { genre: ["Jazz", "Jazz"] },
  });
  const track = store.upsertLibraryTrack({
    identityKey: "genre:track", title: "Genre Track",
    metadata: { genres: ["Soul", " Soul "], tags: { genre: { first: "Ambient" } } },
  });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const file = { trackId: track.id, albumId: album.id, source: "aurral", path: "/genre/track.flac" };
  store.upsertLibraryMediaFile(file);
  const read = (genre) => query.getCanonicalLibraryPage({ kind: "tracks", genre, pageSize: 100 });
  for (const genre of ["rock", "jazz", "soul", "ambient"]) {
    assert.deepEqual(read(genre).items.map((item) => item.id), [track.id]);
  }
  const genres = () => query.getCanonicalLibraryPage({ kind: "genres", pageSize: 100 }).items;
  assert.deepEqual(genres(), [
    { name: "Ambient", artists: 0, albums: 0, tracks: 1 },
    { name: "Jazz", artists: 0, albums: 1, tracks: 0 },
    { name: "Rock", artists: 1, albums: 0, tracks: 0 },
    { name: "Soul", artists: 0, albums: 0, tracks: 1 },
  ]);
  store.upsertLibraryTrack({ identityKey: track.identity_key, title: track.title, metadata: { genre: "Folk" } });
  assert.equal(read("soul").total, 0);
  assert.equal(read("ambient").total, 0);
  assert.equal(read("folk").total, 1);
  assert.deepEqual(genres().map((entry) => entry.name), ["Folk", "Jazz", "Rock"]);
  store.upsertLibraryMediaFile({ ...file, available: false });
  assert.equal(query.getCanonicalLibraryPage({ kind: "tracks", genre: "folk", availableOnly: true }).total, 0);
  assert.equal(read("folk").total, 1);
  assert.equal(query.getCanonicalLibraryPage({ kind: "tracks", genre: "folk", source: "lidarr" }).total, 0);
  db.prepare("UPDATE library_tracks SET metadata_json = '{' WHERE id = ?").run(track.id);
  assert.equal(read("folk").total, 0);
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  query.invalidateCanonicalLibraryCache();
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
  const read = (genre) => query.getCanonicalLibraryPage({ kind: "tracks", genre, pageSize: 100 }).total;
  assert.equal(read("pop"), 1);
  query.rebuildCanonicalGenreStats();
  db.exec("DROP TRIGGER library_genres_tracks_update");
  db.prepare("UPDATE library_tracks SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ genre: "Classical" }), track.id);
  initializeLibraryGenreIndex(db);
  query.invalidateCanonicalLibraryCache({ persistedGenres: false });
  assert.equal(read("pop"), 0);
  assert.equal(read("classical"), 1);
  assert.deepEqual(query.getCanonicalLibraryPage({ kind: "genres" }).items.map((genre) => genre.name), ["Classical"]);
  const changes = db.prepare("SELECT total_changes() AS total").get().total;
  initializeLibraryGenreIndex(db);
  assert.equal(db.prepare("SELECT total_changes() AS total").get().total, changes);
});
