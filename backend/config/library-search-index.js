const SEARCH_INDEX_VERSION = "2";
export const GENRE_STATS_SETTING_PREFIX = "libraryGenreStats:";
export const GENRE_LIST_SETTING_PREFIX = "libraryGenreList:";
export const genreCacheKey = (sourceFilter, availableOnly) =>
  `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;

const genreMediaExists = (kind, sourceFilter, availableOnly) => {
  const filters = [];
  const parameters = [];
  if (sourceFilter) {
    filters.push("page_media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly) filters.push("page_media.available = 1");
  const filterSql = filters.length ? filters.join(" AND ") : "1 = 1";
  if (kind === "artists") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_albums AS page_album
        JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
          AND (page_media.album_id = page_album_track.album_id OR page_media.album_id IS NULL)
        WHERE page_album.artist_id = artist.id AND ${filterSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
          AND (page_media.album_id = page_album_track.album_id OR page_media.album_id IS NULL)
        WHERE page_album_track.album_id = album.id AND ${filterSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media
      WHERE page_media.track_id = track.id AND ${filterSql}
    )`,
    parameters,
  };
};

// Genre membership is read from the trigger-maintained library_genres table
// (config/library-derived-data.js); only media existence is evaluated here.
export function computeLibraryGenreStats(db, { sourceFilter = null, availableOnly = false } = {}) {
  const entities = [
    ["artists", "artist", "library_artists AS artist"],
    ["albums", "album", "library_albums AS album"],
    ["tracks", "track", "library_tracks AS track"],
  ];
  const parameters = [];
  const rows = entities.map(([kind, entityKind, from]) => {
    const media = genreMediaExists(kind, sourceFilter, availableOnly);
    parameters.push(...media.parameters);
    return `SELECT '${kind}' AS entity_kind, genre.entity_id, genre.genre AS name
      FROM library_genres AS genre
      JOIN ${from} ON ${entityKind}.id = genre.entity_id
      WHERE genre.entity_kind = '${entityKind}'
        AND ${media.sql}`;
  });
  return db.prepare(
    `WITH genre_entities AS (
       SELECT entity_kind, entity_id, name
       FROM (${rows.join(" UNION ALL ")})
     )
     SELECT name,
       SUM(entity_kind = 'artists') AS artists,
       SUM(entity_kind = 'albums') AS albums,
       SUM(entity_kind = 'tracks') AS tracks
     FROM genre_entities
     GROUP BY name
     ORDER BY name COLLATE NOCASE`,
  ).all(...parameters).map((row) => ({
    name: row.name,
    artists: Number(row.artists || 0),
    albums: Number(row.albums || 0),
    tracks: Number(row.tracks || 0),
  }));
}

export function computeLibraryGenreList(db, { sourceFilter = null, availableOnly = false } = {}) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    "(media.album_id = album_track.album_id OR media.album_id IS NULL)",
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const genreRows = (entityKind, idColumn) => `
    SELECT eligible.album_id, eligible.track_id, genre.genre
    FROM eligible_tracks AS eligible
    JOIN library_genres AS genre
      ON genre.entity_kind = '${entityKind}' AND genre.entity_id = eligible.${idColumn}`;
  return db.prepare(
    `WITH eligible_tracks AS MATERIALIZED (
       SELECT DISTINCT
         album.id AS album_id,
         album.artist_id AS artist_id,
         track.id AS track_id
       FROM library_albums AS album
       JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
       JOIN library_tracks AS track ON track.id = album_track.track_id
       WHERE EXISTS (
         SELECT 1
         FROM library_media_files AS media
         WHERE ${mediaConditions.join(" AND ")}
       )
     ),
     direct_genres AS (
       SELECT DISTINCT album_id, genre FROM (
         ${genreRows("artist", "artist_id")}
         UNION
         ${genreRows("album", "album_id")}
       )
     ),
     track_genres AS (
       SELECT DISTINCT album_id, track_id, genre FROM (
         ${genreRows("track", "track_id")}
       )
     ),
     track_counts AS (
       SELECT album_id, COUNT(*) AS song_count
       FROM eligible_tracks
       GROUP BY album_id
     ),
     album_genres AS (
       SELECT direct.album_id, direct.genre, tracks.song_count
       FROM direct_genres AS direct
       JOIN track_counts AS tracks ON tracks.album_id = direct.album_id
       UNION ALL
       SELECT track.album_id, track.genre, COUNT(*) AS song_count
       FROM track_genres AS track
       WHERE NOT EXISTS (
         SELECT 1 FROM direct_genres AS direct
         WHERE direct.album_id = track.album_id AND direct.genre = track.genre
       )
       GROUP BY track.album_id, track.genre
     )
     SELECT genre AS value, COUNT(*) AS albumCount, SUM(song_count) AS songCount
     FROM album_genres
     GROUP BY genre
     ORDER BY genre COLLATE NOCASE`,
  ).all(...parameters).map((row) => ({
    albumCount: Number(row.albumCount || 0),
    songCount: Number(row.songCount || 0),
    value: row.value,
  }));
}

// The persisted genre snapshot: stats for both availability variants of the
// unfiltered library, plus the Subsonic genre list. Other variants are computed
// on demand and kept in memory only.
export function computeLibraryGenreSnapshot(db) {
  const entries = [];
  for (const availableOnly of [false, true]) {
    entries.push([
      `${GENRE_STATS_SETTING_PREFIX}${genreCacheKey(null, availableOnly)}`,
      computeLibraryGenreStats(db, { availableOnly }),
    ]);
  }
  entries.push([
    `${GENRE_LIST_SETTING_PREFIX}${genreCacheKey(null, false)}`,
    computeLibraryGenreList(db),
  ]);
  return entries;
}

export function writeLibraryGenreSnapshot(db, entries) {
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  db.transaction(() => {
    for (const [key, value] of entries) upsert.run(key, JSON.stringify(value));
  })();
}

export function rebuildStoredLibraryGenreStats(db) {
  writeLibraryGenreSnapshot(db, computeLibraryGenreSnapshot(db));
}

const createSearchSchema = (db) => {
  const fts5Enabled = db
    .prepare("SELECT sqlite_compileoption_used(?) AS enabled")
    .get("ENABLE_FTS5")?.enabled;
  if (!fts5Enabled) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_search_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      artist_name TEXT NOT NULL DEFAULT '',
      album_name TEXT NOT NULL DEFAULT '',
      UNIQUE (entity_kind, entity_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS library_search_fts USING fts5(
      entity_kind UNINDEXED,
      entity_id UNINDEXED,
      title,
      artist_name,
      album_name,
      content='library_search_documents',
      content_rowid='id',
      tokenize='trigram',
      detail='none'
    );

    CREATE TRIGGER IF NOT EXISTS library_search_documents_ai
    AFTER INSERT ON library_search_documents
    BEGIN
      INSERT INTO library_search_fts(rowid, entity_kind, entity_id, title, artist_name, album_name)
      VALUES (new.id, new.entity_kind, new.entity_id, new.title, new.artist_name, new.album_name);
    END;

    CREATE TRIGGER IF NOT EXISTS library_search_documents_au
    AFTER UPDATE ON library_search_documents
    BEGIN
      INSERT INTO library_search_fts(library_search_fts, rowid, entity_kind, entity_id, title, artist_name, album_name)
      VALUES ('delete', old.id, old.entity_kind, old.entity_id, old.title, old.artist_name, old.album_name);
      INSERT INTO library_search_fts(rowid, entity_kind, entity_id, title, artist_name, album_name)
      VALUES (new.id, new.entity_kind, new.entity_id, new.title, new.artist_name, new.album_name);
    END;

    CREATE TRIGGER IF NOT EXISTS library_search_documents_ad
    AFTER DELETE ON library_search_documents
    BEGIN
      INSERT INTO library_search_fts(library_search_fts, rowid, entity_kind, entity_id, title, artist_name, album_name)
      VALUES ('delete', old.id, old.entity_kind, old.entity_id, old.title, old.artist_name, old.album_name);
    END;
  `);
  return true;
};

export const populateLibrarySearchDocuments = (db) => {
  db.exec(`
    INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
    SELECT 'artist', artist.id, artist.name, '', ''
    FROM library_artists AS artist;

    INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
    SELECT
      'album',
      album.id,
      album.title,
      trim(coalesce(artist.name, '') || ' ' || coalesce(album.album_artist, '')),
      ''
    FROM library_albums AS album
    JOIN library_artists AS artist ON artist.id = album.artist_id;

    INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
    SELECT
      'track',
      track.id,
      track.title,
      trim(coalesce(track.artist_name, '') || ' ' || coalesce(group_concat(DISTINCT artist.name), '')),
      trim(coalesce(group_concat(DISTINCT album.title), '') || ' ' || coalesce(group_concat(DISTINCT album.album_artist), ''))
    FROM library_tracks AS track
    LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
    LEFT JOIN library_albums AS album ON album.id = album_track.album_id
    LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
    GROUP BY track.id;
  `);
};

export function initializeLibrarySearchIndex(db) {
  const hadSearchIndex = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("library_search_fts"),
  );
  const version = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("librarySearchIndexVersion")?.value;
  if (version && version !== SEARCH_INDEX_VERSION) {
    db.exec(`
      DROP TRIGGER IF EXISTS library_search_documents_ai;
      DROP TRIGGER IF EXISTS library_search_documents_au;
      DROP TRIGGER IF EXISTS library_search_documents_ad;
      DROP TABLE IF EXISTS library_search_fts;
    `);
  }
  if (!createSearchSchema(db)) return false;
  if (version === SEARCH_INDEX_VERSION && hadSearchIndex) return true;

  db.transaction(() => {
    db.prepare("DELETE FROM library_search_documents").run();
    populateLibrarySearchDocuments(db);
    db.prepare("INSERT INTO library_search_fts(library_search_fts) VALUES ('rebuild')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("librarySearchIndexVersion", SEARCH_INDEX_VERSION);
    rebuildStoredLibraryGenreStats(db);
  })();
  return true;
}
