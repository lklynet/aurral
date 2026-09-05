// Derived library data kept current by triggers:
//   - library_albums / library_tracks `latest_media_at` and
//     `latest_available_media_at`: arrival time of the newest media file, so
//     "newest" sorts walk an index instead of computing MAX() per row.
//   - library_genres: one row per (entity, genre) extracted from metadata_json,
//     so genre filters and genre statistics never json_each over blobs.
// A version key in settings triggers a one-time backfill after upgrades.

const DERIVED_DATA_VERSION = "1";
const VERSION_SETTING = "libraryDerivedDataVersion";

const GENRE_ENTITIES = [
  ["artist", "library_artists"],
  ["album", "library_albums"],
  ["track", "library_tracks"],
];

const validJson = (column) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;

// SELECT producing (entity_kind, entity_id, genre) rows for one metadata blob,
// or for every row of `sourceTable` (aliased `entity`) when given.
const genreRowsSql = (kind, idExpression, metadataExpression, sourceTable = null) => `
  SELECT '${kind}', ${idExpression}, TRIM(CAST(genre_value.value AS TEXT))
  FROM ${sourceTable ? `${sourceTable} AS entity, ` : ""}json_each(json_array(
    json_extract(${validJson(metadataExpression)}, '$.genres'),
    json_extract(${validJson(metadataExpression)}, '$.genre'),
    json_extract(${validJson(metadataExpression)}, '$.common.genre'),
    json_extract(${validJson(metadataExpression)}, '$.tags.genre')
  )) AS selected_genre
  JOIN json_each(CASE
    WHEN selected_genre.type IN ('array', 'object') THEN selected_genre.value
    ELSE json_array(selected_genre.value)
  END) AS genre_value
  WHERE selected_genre.value IS NOT NULL
    AND TRIM(CAST(genre_value.value AS TEXT)) <> ''`;

const trackRecencySql = (trackIdExpression) => `
  UPDATE library_tracks SET
    latest_media_at = COALESCE((
      SELECT MAX(created_at) FROM library_media_files WHERE track_id = library_tracks.id
    ), 0),
    latest_available_media_at = COALESCE((
      SELECT MAX(created_at) FROM library_media_files
      WHERE track_id = library_tracks.id AND available = 1
    ), 0)
  WHERE id IN (${trackIdExpression});`;

const albumRecencySql = (albumIdExpression) => `
  UPDATE library_albums SET
    latest_media_at = COALESCE((
      SELECT MAX(media.created_at)
      FROM library_album_tracks AS album_track
      JOIN library_media_files AS media
        ON media.track_id = album_track.track_id
        AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
      WHERE album_track.album_id = library_albums.id
    ), 0),
    latest_available_media_at = COALESCE((
      SELECT MAX(media.created_at)
      FROM library_album_tracks AS album_track
      JOIN library_media_files AS media
        ON media.track_id = album_track.track_id
        AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
      WHERE album_track.album_id = library_albums.id AND media.available = 1
    ), 0)
  WHERE id IN (${albumIdExpression});`;

// Albums touched by a media row: its own album plus every album the track is
// linked to (media with a NULL album_id counts for all of them).
const mediaAlbumsSql = (row) => `
  SELECT ${row}.album_id WHERE ${row}.album_id IS NOT NULL
  UNION SELECT album_id FROM library_album_tracks WHERE track_id = ${row}.track_id`;

const tryAddColumn = (db, sql) => {
  try {
    db.exec(sql);
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("duplicate column name")) throw error;
  }
};

function createSchema(db) {
  for (const table of ["library_albums", "library_tracks"]) {
    tryAddColumn(db, `ALTER TABLE ${table} ADD COLUMN latest_media_at INTEGER NOT NULL DEFAULT 0`);
    tryAddColumn(db, `ALTER TABLE ${table} ADD COLUMN latest_available_media_at INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_library_albums_latest_media_at
      ON library_albums (latest_media_at DESC, title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_albums_latest_available_media_at
      ON library_albums (latest_available_media_at DESC, title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_tracks_latest_media_at
      ON library_tracks (latest_media_at DESC, title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_tracks_latest_available_media_at
      ON library_tracks (latest_available_media_at DESC, title COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS library_genres (
      entity_kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      genre TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, genre)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_library_genres_genre
      ON library_genres (genre COLLATE NOCASE, entity_kind, entity_id);

    CREATE TRIGGER IF NOT EXISTS library_media_files_recency_ai
    AFTER INSERT ON library_media_files
    BEGIN
      ${trackRecencySql("NEW.track_id")}
      ${albumRecencySql(mediaAlbumsSql("NEW"))}
    END;

    CREATE TRIGGER IF NOT EXISTS library_media_files_recency_au
    AFTER UPDATE OF track_id, album_id, available, created_at ON library_media_files
    BEGIN
      ${trackRecencySql("OLD.track_id, NEW.track_id")}
      ${albumRecencySql(`${mediaAlbumsSql("OLD")} UNION ${mediaAlbumsSql("NEW")}`)}
    END;

    CREATE TRIGGER IF NOT EXISTS library_media_files_recency_ad
    AFTER DELETE ON library_media_files
    BEGIN
      ${trackRecencySql("OLD.track_id")}
      ${albumRecencySql(mediaAlbumsSql("OLD"))}
    END;

    CREATE TRIGGER IF NOT EXISTS library_album_tracks_recency_ai
    AFTER INSERT ON library_album_tracks
    BEGIN
      ${albumRecencySql("NEW.album_id")}
    END;

    CREATE TRIGGER IF NOT EXISTS library_album_tracks_recency_ad
    AFTER DELETE ON library_album_tracks
    BEGIN
      ${albumRecencySql("OLD.album_id")}
    END;
  `);
  for (const [kind, table] of GENRE_ENTITIES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_genres_ai
      AFTER INSERT ON ${table}
      BEGIN
        INSERT OR IGNORE INTO library_genres (entity_kind, entity_id, genre)
        ${genreRowsSql(kind, "NEW.id", "NEW.metadata_json")};
      END;

      CREATE TRIGGER IF NOT EXISTS ${table}_genres_au
      AFTER UPDATE OF metadata_json ON ${table}
      BEGIN
        DELETE FROM library_genres WHERE entity_kind = '${kind}' AND entity_id = OLD.id;
        INSERT OR IGNORE INTO library_genres (entity_kind, entity_id, genre)
        ${genreRowsSql(kind, "NEW.id", "NEW.metadata_json")};
      END;

      CREATE TRIGGER IF NOT EXISTS ${table}_genres_ad
      AFTER DELETE ON ${table}
      BEGIN
        DELETE FROM library_genres WHERE entity_kind = '${kind}' AND entity_id = OLD.id;
      END;
    `);
  }
}

export function backfillLibraryDerivedData(db) {
  db.transaction(() => {
    db.exec(trackRecencySql("SELECT id FROM library_tracks"));
    db.exec(albumRecencySql("SELECT id FROM library_albums"));
    db.exec("DELETE FROM library_genres");
    for (const [kind, table] of GENRE_ENTITIES) {
      db.exec(`
        INSERT OR IGNORE INTO library_genres (entity_kind, entity_id, genre)
        ${genreRowsSql(kind, "entity.id", "entity.metadata_json", table)};
      `);
    }
  })();
}

// Triggers are recreated (not just created if missing) whenever the version
// changes, so a trigger body edit ships with a version bump and a backfill.
function dropTriggers(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE '%_recency_a_' OR name LIKE 'library_%_genres_a_')")
    .all()
    .map((row) => row.name);
  for (const name of names) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
}

export function initializeLibraryDerivedData(db) {
  const version = db.prepare("SELECT value FROM settings WHERE key = ?").get(VERSION_SETTING)?.value;
  if (version !== DERIVED_DATA_VERSION) dropTriggers(db);
  createSchema(db);
  if (version === DERIVED_DATA_VERSION) return false;
  backfillLibraryDerivedData(db);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(VERSION_SETTING, DERIVED_DATA_VERSION);
  return true;
}
