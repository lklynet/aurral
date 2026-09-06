import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "genre-cache",
  "backend/config/db-sqlite.js",
);
const genreCache = await importFromRepo("backend/services/libraryGenreCache.js");
const { GENRE_STATS_SETTING_PREFIX } = await importFromRepo("backend/config/library-search-index.js");

const NOW = 1_700_000_000_000;

// One artist, album, track, and media file per source; genre stats only count
// entities that have media.
const seedSource = (source, genre) => {
  const artistId = Number(db.prepare(
    `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`artist:${source}`, `${source} Artist`, JSON.stringify({ genres: [genre] }), NOW, NOW).lastInsertRowid);
  const albumId = Number(db.prepare(
    `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`album:${source}`, artistId, `${source} Album`, JSON.stringify({ genres: [genre] }), NOW, NOW).lastInsertRowid);
  const trackId = Number(db.prepare(
    `INSERT INTO library_tracks (identity_key, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`track:${source}`, `${source} Track`, JSON.stringify({ tags: { genre: [genre] } }), NOW, NOW).lastInsertRowid);
  db.prepare(
    `INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, 1, 1, ?)`,
  ).run(albumId, trackId, NOW);
  db.prepare(
    `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(trackId, albumId, source, `/music/${source}.flac`, NOW, NOW);
};

test.before(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM settings WHERE key LIKE 'libraryGenre%'").run();
  genreCache.clearLibraryGenreMemoryCache();
  seedSource("lidarr", "Rock");
  seedSource("aurral", "Jazz");
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const genreNames = (stats) => stats.map((entry) => entry.genre ?? entry.name).sort();

test("source-filtered genre stats are computed once and dropped with the next snapshot", () => {
  genreCache.rebuildLibraryGenreSnapshot();
  const all = genreCache.getLibraryGenreStats();
  assert.deepEqual(genreNames(all), ["Jazz", "Rock"]);

  const filtered = genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" });
  assert.deepEqual(genreNames(filtered), ["Rock"]);
  // Memoized: the same object comes back, and nothing was persisted for it.
  assert.equal(genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" }), filtered);
  const storedKeys = db
    .prepare("SELECT key FROM settings WHERE key LIKE ?")
    .all(`${GENRE_STATS_SETTING_PREFIX}%`)
    .map((row) => row.key);
  assert.equal(storedKeys.some((key) => key.includes("lidarr")), false);

  // The library changed; the next snapshot drops the memo so it is recomputed.
  db.prepare("UPDATE library_artists SET metadata_json = ? WHERE identity_key = 'artist:lidarr'")
    .run(JSON.stringify({ genres: ["Metal"] }));
  assert.equal(genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" }), filtered);
  genreCache.rebuildLibraryGenreSnapshot();
  // Album and track keep "Rock"; only the artist row moved to "Metal".
  assert.deepEqual(genreNames(genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" })), ["Metal", "Rock"]);
  assert.deepEqual(genreNames(genreCache.getLibraryGenreStats()), ["Jazz", "Metal", "Rock"]);
});
