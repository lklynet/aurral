import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "derived-data",
  "backend/config/db-sqlite.js",
);
const { backfillLibraryDerivedData, initializeLibraryDerivedData } = await importFromRepo(
  "backend/config/library-derived-data.js",
);
const { computeLibraryGenreStats, computeLibraryGenreList } = await importFromRepo(
  "backend/config/library-search-index.js",
);
const queryService = await importFromRepo("backend/services/libraryQueryService.js");
const genreCache = await importFromRepo("backend/services/libraryGenreCache.js");

const NOW = 1_700_000_000_000;

const genreRows = (kind) =>
  db
    .prepare("SELECT genre FROM library_genres WHERE entity_kind = ? ORDER BY genre")
    .all(kind)
    .map((row) => row.genre);

const recency = (table, id) =>
  db.prepare(`SELECT latest_media_at, latest_available_media_at FROM ${table} WHERE id = ?`).get(id);

const seedLibrary = () => {
  const artist = db
    .prepare(
      `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("artist:one", "Artist One", JSON.stringify({ genres: ["Rock", " Jazz "] }), NOW, NOW);
  const artistId = Number(artist.lastInsertRowid);
  const insertAlbum = db.prepare(
    `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertTrack = db.prepare(
    `INSERT INTO library_tracks (identity_key, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const link = db.prepare(
    `INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  );
  const insertMedia = db.prepare(
    `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
     VALUES (?, ?, 'aurral', ?, ?, ?, ?)`,
  );
  const albums = [];
  [
    ["Older Album", { genre: "Pop" }, NOW + 1_000],
    ["Newer Album", { genres: ["Blues"] }, NOW + 5_000],
    ["Silent Album", { genres: ["Ambient"] }, null],
  ].forEach(([title, metadata, mediaAt], index) => {
    const albumId = Number(
      insertAlbum.run(`album:${index}`, artistId, title, JSON.stringify(metadata), NOW, NOW).lastInsertRowid,
    );
    const trackId = Number(
      insertTrack.run(
        `track:${index}`,
        `${title} Track`,
        JSON.stringify({ tags: { genre: ["Folk"] } }),
        NOW,
        NOW,
      ).lastInsertRowid,
    );
    link.run(albumId, trackId, index + 1, NOW);
    if (mediaAt !== null) {
      insertMedia.run(trackId, albumId, `/music/${index}.flac`, 1, mediaAt, mediaAt);
    }
    albums.push({ albumId, trackId, title, mediaAt });
  });
  return { artistId, albums };
};

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM library_genres").run();
  genreCache.clearLibraryGenreMemoryCache();
});

test("startup creates the derived columns, indexes, table, and version marker", () => {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.ok(columns("library_albums").includes("latest_media_at"));
  assert.ok(columns("library_albums").includes("latest_available_media_at"));
  assert.ok(columns("library_tracks").includes("latest_media_at"));
  assert.ok(columns("library_tracks").includes("latest_available_media_at"));
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_library_%latest%'")
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(indexes, [
    "idx_library_albums_latest_available_media_at",
    "idx_library_albums_latest_media_at",
    "idx_library_tracks_latest_available_media_at",
    "idx_library_tracks_latest_media_at",
  ]);
  // The harness clears the settings table, so the first call re-runs the backfill
  // and records the version; the second call sees the marker and skips it.
  assert.equal(initializeLibraryDerivedData(db), true, "missing marker triggers a backfill");
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key = 'libraryDerivedDataVersion'").get()?.value,
    "2",
  );
  assert.equal(initializeLibraryDerivedData(db), false, "re-initialization skips the backfill");

  const triggerCount = () =>
    db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND (name LIKE '%_recency_a_' OR name LIKE 'library_%_genres_a_')").get().total;
  assert.equal(triggerCount(), 14);
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'libraryDerivedDataVersion'").run();
  assert.equal(initializeLibraryDerivedData(db), true, "a stale version re-runs the backfill");
  assert.equal(triggerCount(), 14, "triggers are recreated after a version change");
});

test("triggers keep genre membership in sync with metadata_json", () => {
  const { artistId, albums } = seedLibrary();
  assert.deepEqual(genreRows("artist"), ["Jazz", "Rock"]);
  assert.deepEqual(genreRows("album"), ["Ambient", "Blues", "Pop"]);
  assert.deepEqual(genreRows("track"), ["Folk", "Folk", "Folk"]);

  db.prepare("UPDATE library_artists SET metadata_json = ? WHERE id = ?").run(
    JSON.stringify({ genres: ["Metal"] }),
    artistId,
  );
  assert.deepEqual(genreRows("artist"), ["Metal"]);

  db.prepare("UPDATE library_albums SET metadata_json = ? WHERE id = ?").run("not json", albums[0].albumId);
  assert.deepEqual(genreRows("album"), ["Ambient", "Blues"]);

  db.prepare("DELETE FROM library_tracks WHERE id = ?").run(albums[0].trackId);
  assert.deepEqual(genreRows("track"), ["Folk", "Folk"]);
});

test("triggers keep latest media timestamps in sync with media files", () => {
  const { albums } = seedLibrary();
  const [older, newer, silent] = albums;
  assert.deepEqual(recency("library_albums", older.albumId), {
    latest_media_at: older.mediaAt,
    latest_available_media_at: older.mediaAt,
  });
  assert.deepEqual(recency("library_tracks", newer.trackId), {
    latest_media_at: newer.mediaAt,
    latest_available_media_at: newer.mediaAt,
  });
  assert.deepEqual(recency("library_albums", silent.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });

  db.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(newer.trackId);
  assert.deepEqual(recency("library_albums", newer.albumId), {
    latest_media_at: newer.mediaAt,
    latest_available_media_at: 0,
  });

  const laterAt = NOW + 9_000;
  db.prepare(
    `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
     VALUES (?, NULL, 'lidarr', '/lidarr/silent.flac', 1, ?, ?)`,
  ).run(silent.trackId, laterAt, laterAt);
  assert.deepEqual(recency("library_albums", silent.albumId), {
    latest_media_at: laterAt,
    latest_available_media_at: laterAt,
  });

  db.prepare("DELETE FROM library_media_files WHERE track_id = ?").run(silent.trackId);
  assert.deepEqual(recency("library_albums", silent.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });

  db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(older.albumId);
  assert.deepEqual(recency("library_albums", older.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });
});

test("backfill rebuilds derived data from scratch", () => {
  const { albums } = seedLibrary();
  db.prepare("DELETE FROM library_genres").run();
  db.prepare("UPDATE library_albums SET latest_media_at = 0, latest_available_media_at = 0").run();
  db.prepare("UPDATE library_tracks SET latest_media_at = 0, latest_available_media_at = 0").run();

  backfillLibraryDerivedData(db);

  assert.deepEqual(genreRows("artist"), ["Jazz", "Rock"]);
  assert.deepEqual(genreRows("album"), ["Ambient", "Blues", "Pop"]);
  assert.equal(recency("library_albums", albums[1].albumId).latest_media_at, albums[1].mediaAt);
  assert.equal(recency("library_tracks", albums[0].trackId).latest_available_media_at, albums[0].mediaAt);
});

test("newest sort reads the indexed recency columns and matches media order", () => {
  const { albums } = seedLibrary();
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM library_albums AS album
       ORDER BY album.latest_media_at DESC, album.title COLLATE NOCASE ASC LIMIT 10`,
    )
    .all()
    .map((row) => row.detail)
    .join("\n");
  assert.match(plan, /idx_library_albums_latest_media_at/);

  queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });
  // Entities without media sort last (timestamp 0), matching the previous MAX() behaviour.
  const page = queryService.getCanonicalLibraryPage({ kind: "albums", sort: "newest", pageSize: 10 });
  assert.deepEqual(
    page.items.map((album) => album.title),
    [albums[1].title, albums[0].title, albums[2].title],
  );
  const subsonic = queryService.getCanonicalAlbumPage({ type: "newest", limit: 10 });
  assert.deepEqual(
    subsonic.albums.map((album) => album.title),
    [albums[1].title, albums[0].title, albums[2].title],
  );
  const tracks = queryService.getCanonicalLibraryPage({ kind: "tracks", sort: "newest", pageSize: 10 });
  assert.deepEqual(
    tracks.items.map((track) => track.title),
    [`${albums[1].title} Track`, `${albums[0].title} Track`, `${albums[2].title} Track`],
  );
});

test("genre filters and genre stats use the membership table", () => {
  seedLibrary();
  queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });

  const blues = queryService.getCanonicalAlbumPage({ genre: "blues", limit: 10 });
  assert.deepEqual(blues.albums.map((album) => album.title), ["Newer Album"]);
  const rock = queryService.getCanonicalLibraryPage({ kind: "albums", genre: "ROCK", pageSize: 10 });
  assert.deepEqual(
    rock.items.map((album) => album.title).sort(),
    ["Newer Album", "Older Album", "Silent Album"],
  );

  const stats = computeLibraryGenreStats(db, { availableOnly: false });
  const byName = Object.fromEntries(stats.map((entry) => [entry.name, entry]));
  assert.equal(byName.Rock.artists, 1);
  assert.equal(byName.Jazz.artists, 1);
  assert.equal(byName.Pop.albums, 1);
  assert.equal(byName.Ambient, undefined, "albums without media are excluded");
  assert.equal(byName.Folk.tracks, 2);

  const list = computeLibraryGenreList(db, {});
  assert.deepEqual(
    list.map((entry) => entry.value),
    ["Blues", "Folk", "Jazz", "Pop", "Rock"],
  );
  const listByName = Object.fromEntries(list.map((entry) => [entry.value, entry]));
  assert.deepEqual(listByName.Rock, { value: "Rock", albumCount: 2, songCount: 2 });
  assert.deepEqual(listByName.Folk, { value: "Folk", albumCount: 2, songCount: 2 });
});
