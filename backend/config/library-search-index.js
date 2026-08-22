const SEARCH_INDEX_VERSION = "2";
const GENRE_STATS_SETTING_PREFIX = "libraryGenreStats:";

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

export function computeLibraryGenreStats(db, { sourceFilter = null, availableOnly = false } = {}) {
  const entities = [
    ["artists", "library_artists AS artist", "artist.id", "artist.metadata_json"],
    [
      "albums",
      "library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id",
      "album.id",
      "album.metadata_json",
    ],
    ["tracks", "library_tracks AS track", "track.id", "track.metadata_json"],
  ];
  const parameters = [];
  const rows = entities.map(([kind, from, id, metadata]) => {
    const media = genreMediaExists(kind, sourceFilter, availableOnly);
    parameters.push(...media.parameters);
    const validMetadata = `CASE WHEN json_valid(${metadata}) THEN ${metadata} ELSE '{}' END`;
    return `SELECT '${kind}' AS entity_kind, ${id} AS entity_id,
      TRIM(CAST(genre_value.value AS TEXT)) AS name
      FROM ${from}
      JOIN json_each(json_array(
        json_extract(${validMetadata}, '$.genres'),
        json_extract(${validMetadata}, '$.genre'),
        json_extract(${validMetadata}, '$.common.genre'),
        json_extract(${validMetadata}, '$.tags.genre')
      )) AS selected_genre
      JOIN json_each(CASE
        WHEN selected_genre.type IN ('array', 'object') THEN selected_genre.value
        ELSE json_array(selected_genre.value)
      END) AS genre_value
      WHERE selected_genre.value IS NOT NULL
        AND TRIM(CAST(genre_value.value AS TEXT)) <> ''
        AND ${media.sql}`;
  });
  return db.prepare(
    `WITH genre_entities AS (
       SELECT DISTINCT entity_kind, entity_id, name
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

export function rebuildStoredLibraryGenreStats(db) {
  for (const availableOnly of [false, true]) {
    const cacheKey = `all:${availableOnly ? "available" : "all"}`;
    const stats = computeLibraryGenreStats(db, { availableOnly });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(`${GENRE_STATS_SETTING_PREFIX}${cacheKey}`, JSON.stringify(stats));
  }
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
