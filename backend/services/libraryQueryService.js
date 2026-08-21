import { db, dbHelpers } from "../config/db-sqlite.js";

const SOURCES = new Set(["aurral", "lidarr"]);
const libraryCache = new Map();
const PAGE_KINDS = new Set(["artists", "albums", "tracks", "genres"]);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

const parseJson = (value) => {
  if (!value) return null;
  try {
    return dbHelpers.parseJSON(value);
  } catch {
    return null;
  }
};

function normalizeSource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (!value || value === "all") return null;
  if (!SOURCES.has(value)) throw new Error(`Unsupported library source: ${value}`);
  return value;
}

function createEntity(map, id, value) {
  if (!map.has(id)) map.set(id, value);
  return map.get(id);
}

const CANONICAL_SELECT = `SELECT
  artist.id AS artist_id,
  artist.identity_key AS artist_identity_key,
  artist.mbid AS artist_mbid,
  artist.name AS artist_name,
  artist.sort_name AS artist_sort_name,
  artist.metadata_json AS artist_metadata_json,
  album.id AS album_id,
  album.identity_key AS album_identity_key,
  album.mbid AS album_mbid,
  album.release_group_mbid AS album_release_group_mbid,
  album.title AS album_title,
  album.album_artist AS album_artist,
  album.release_date AS album_release_date,
  album.metadata_json AS album_metadata_json,
  track.id AS track_id,
  track.identity_key AS track_identity_key,
  track.mbid AS track_mbid,
  track.title AS track_title,
  track.artist_name AS track_artist_name,
  track.metadata_json AS track_metadata_json,
  album_track.disc_number,
  album_track.track_number,
  media.id AS media_id,
  media.album_id AS media_album_id,
  media.source AS media_source,
  media.path AS media_path,
  media.format AS media_format,
  media.size AS media_size,
  media.mtime_ms AS media_mtime_ms,
  media.duration_ms AS media_duration_ms,
  media.quality_json AS media_quality_json,
  media.available AS media_available`;

const albumMediaCondition = (mediaAlias, albumTrackAlias) =>
  `(${mediaAlias}.album_id = ${albumTrackAlias}.album_id OR ${mediaAlias}.album_id IS NULL)`;

const CANONICAL_FROM = `FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  JOIN library_album_tracks AS album_track
    ON album_track.track_id = track.id
    AND ${albumMediaCondition("media", "album_track")}
  JOIN library_albums AS album ON album.id = album_track.album_id
  JOIN library_artists AS artist ON artist.id = album.artist_id`;

function buildLibraryFromRows(rows) {
  const artists = new Map();
  const albums = new Map();
  const tracks = new Map();

  for (const row of rows) {
    const artist = createEntity(artists, row.artist_id, {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [],
      sources: [],
      available: false,
    });
    const album = createEntity(albums, row.album_id, {
      id: row.album_id,
      identityKey: row.album_identity_key,
      mbid: row.album_mbid,
      releaseGroupMbid: row.album_release_group_mbid,
      artistId: row.artist_id,
      title: row.album_title,
      albumArtist: row.album_artist,
      releaseDate: row.album_release_date,
      metadata: parseJson(row.album_metadata_json),
      trackIds: [],
      sources: [],
      available: false,
    });
    const track = createEntity(tracks, row.track_id, {
      id: row.track_id,
      identityKey: row.track_identity_key,
      mbid: row.track_mbid,
      title: row.track_title,
      artistName: row.track_artist_name,
      metadata: parseJson(row.track_metadata_json),
      albums: [],
      files: [],
      sources: [],
      available: false,
    });

    if (!artist.albumIds.includes(album.id)) artist.albumIds.push(album.id);
    if (!album.trackIds.includes(track.id)) album.trackIds.push(track.id);
    if (!track.albums.some((entry) => entry.albumId === album.id)) {
      track.albums.push({
        albumId: album.id,
        discNumber: row.disc_number,
        trackNumber: row.track_number,
      });
    }

    if (row.media_id != null) {
      if (row.media_source && !artist.sources.includes(row.media_source)) {
        artist.sources.push(row.media_source);
      }
      if (row.media_source && !album.sources.includes(row.media_source)) {
        album.sources.push(row.media_source);
      }
      if (row.media_source && !track.sources.includes(row.media_source)) {
        track.sources.push(row.media_source);
      }

      const file = {
        id: row.media_id,
        albumId: row.media_album_id,
        source: row.media_source,
        path: row.media_path,
        format: row.media_format,
        size: row.media_size,
        mtimeMs: row.media_mtime_ms,
        durationMs: row.media_duration_ms,
        quality: parseJson(row.media_quality_json),
        available: Boolean(row.media_available),
      };
      if (!track.files.some((entry) => entry.id === file.id)) track.files.push(file);
      if (file.available) {
        artist.available = true;
        album.available = true;
        track.available = true;
      }
    }
  }

  for (const entity of [...artists.values(), ...albums.values(), ...tracks.values()]) {
    entity.sources.sort();
  }
  for (const track of tracks.values()) {
    track.files.sort((left, right) => left.path.localeCompare(right.path));
  }

  return {
    artists: [...artists.values()],
    albums: [...albums.values()],
    tracks: [...tracks.values()],
  };
}

const normalizeLookupValues = (values) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];

const canonicalOrder = `ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
  album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
  track.title COLLATE NOCASE, media.path COLLATE NOCASE`;

function getScopedCanonicalLibrary({
  source = null,
  availableOnly = false,
  conditions = [],
  parameters = [],
}) {
  const sourceFilter = normalizeSource(source);
  const where = [...conditions];
  const values = [...parameters];
  if (sourceFilter) {
    where.push("media.source = ?");
    values.push(sourceFilter);
  }
  if (availableOnly === true) where.push("media.available = 1");
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${where.join(" AND ")}
     ${canonicalOrder}`,
  ).iterate(...values);
  return buildLibraryFromRows(rows);
}

export function getCanonicalArtistMbids({ source = null, availableOnly = false, mbids = [] } = {}) {
  const references = normalizeLookupValues(mbids);
  if (!references.length) return new Set();
  const sourceFilter = normalizeSource(source);
  const parameters = [...references];
  const conditions = [`artist.mbid IN (${references.map(() => "?").join(",")})`];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const rows = db.prepare(
    `SELECT DISTINCT artist.mbid AS mbid
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}`,
  ).all(...parameters);
  return new Set(rows.map((row) => row.mbid).filter(Boolean));
}

export function getCanonicalTrackPath(reference) {
  const value = String(reference ?? "").trim();
  if (!value) return null;
  const selectPath = (condition) => db.prepare(
    `SELECT media.path
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     WHERE media.available = 1
       AND ${condition}
     ORDER BY media.source = 'lidarr' DESC, media.path COLLATE NOCASE
     LIMIT 1`,
  ).get(value)?.path || null;
  if (/^[1-9]\d*$/.test(value)) return selectPath("track.id = ?");
  return selectPath("track.identity_key = ?") || selectPath("track.mbid = ?");
}

export function getCanonicalLibraryForArtists({
  source = null,
  availableOnly = false,
  mbids = [],
} = {}) {
  const references = normalizeLookupValues(mbids);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions: [`artist.mbid IN (${references.map(() => "?").join(",")})`],
    parameters: references,
  });
}

export function getCanonicalLibraryForAlbumReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
} = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };

  const sourceFilter = normalizeSource(source);
  const referenceCondition = `(
    album.mbid IN (${references.map(() => "?").join(",")}) OR
    album.release_group_mbid IN (${references.map(() => "?").join(",")}) OR
    album.identity_key IN (${references.map(() => "?").join(",")})
  )`;
  const albumParameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    albumParameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  albumParameters.push(...references, ...references, ...references);

  const albumIds = db.prepare(
    `SELECT DISTINCT album.id AS id
     FROM library_albums AS album
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE ${referenceCondition}`,
  ).all(...albumParameters).map((row) => row.id);
  if (!albumIds.length) return { artists: [], albums: [], tracks: [] };

  const trackMediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const trackParameters = [];
  if (sourceFilter) {
    trackMediaConditions.push("media.source = ?");
    trackParameters.push(sourceFilter);
  }
  if (availableOnly === true) trackMediaConditions.push("media.available = 1");
  trackParameters.push(...albumIds);

  const rows = db.prepare(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     LEFT JOIN library_media_files AS media ON ${trackMediaConditions.join(" AND ")}
     WHERE album.id IN (${albumIds.map(() => "?").join(",")})
     ${canonicalOrder}`,
  ).iterate(...trackParameters);
  return buildLibraryFromRows(rows);
}

export function getCanonicalLibrary({ source = null, availableOnly = false, favoriteKeys = null } = {}) {
  const sourceFilter = normalizeSource(source);
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const favoriteTargets = Array.isArray(favoriteKeys)
    ? favoriteKeys.filter((target) =>
        target && ["artist", "album", "song"].includes(target.kind) && String(target.key || "").trim(),
      )
    : null;
  if (favoriteTargets && favoriteTargets.length === 0) {
    return { artists: [], albums: [], tracks: [] };
  }
  if (!favoriteTargets) {
    const cached = libraryCache.get(cacheKey);
    if (cached) return cached;
  }
  const conditions = [];
  const parameters = [];

  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (favoriteTargets) {
    const targetQueries = [];
    const add = (query, kind) => {
      const keys = favoriteTargets
        .filter((target) => target.kind === kind)
        .map((target) => String(target.key).trim());
      if (!keys.length) return;
      targetQueries.push(query.replace("?", keys.map(() => "?").join(",")));
      parameters.push(...keys);
    };
    add("SELECT id FROM library_tracks WHERE identity_key IN (?)", "song");
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "WHERE album.identity_key IN (?)",
      "album",
    );
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "JOIN library_artists AS artist ON artist.id = album.artist_id " +
        "WHERE artist.identity_key IN (?)",
      "artist",
    );
    if (!targetQueries.length) return { artists: [], albums: [], tracks: [] };
    conditions.push(`media.track_id IN (${targetQueries.join(" UNION ")})`);
  }

  const rows = db.prepare(
    `${CANONICAL_SELECT}
    ${CANONICAL_FROM}
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
      album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
      track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
  ).iterate(...parameters);
  const library = buildLibraryFromRows(rows);
  if (!favoriteTargets) libraryCache.set(cacheKey, library);
  return library;
}

const text = (value) => String(value || "").trim();

const metadataGenres = (entity) => {
  const metadata = entity?.metadata || {};
  return [metadata.genres, metadata.genre, metadata.common?.genre, metadata.tags?.genre]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(text)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
};

const addGenreStats = (stats, metadata, kind) => {
  metadataGenres({ metadata }).forEach((genre) => {
    const entry = stats.get(genre) || { name: genre, artists: 0, albums: 0, tracks: 0 };
    entry[kind] += 1;
    stats.set(genre, entry);
  });
};

const pageNumber = (value) => Math.max(1, Number.parseInt(value, 10) || 1);

const pageSize = (value) =>
  Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(value, 10) || DEFAULT_PAGE_SIZE));

const genreStatsCache = new Map();
const GENRE_METADATA_PATHS = ["$.genres", "$.genre", "$.common.genre", "$.tags.genre"];

const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");

const mediaSourceClause = (sourceFilter, alias = "page_media") => {
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push(`${alias}.source = ?`);
    parameters.push(sourceFilter);
  }
  return { conditions, parameters };
};

const recentMediaFilter = (sourceFilter, availableOnly, alias = "page_media") => {
  const conditions = [];
  if (sourceFilter) conditions.push(`${alias}.source = '${sourceFilter}'`);
  if (availableOnly === true) conditions.push(`${alias}.available = 1`);
  return conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
};

const recentMediaOrder = (kind, sourceFilter, availableOnly, direction) => {
  const orderDirection = direction === "desc" ? "ASC" : "DESC";
  const mediaFilter = recentMediaFilter(sourceFilter, availableOnly);
  if (kind === "albums") {
    return `COALESCE((
      SELECT MAX(page_media.created_at)
      FROM library_album_tracks AS page_album_track
      JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_source_available
        ON page_media.track_id = page_album_track.track_id
      WHERE page_album_track.album_id = album.id
        AND ${albumMediaCondition("page_media", "page_album_track")}${mediaFilter}
    ), 0) ${orderDirection}, album.title COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
  }
  return `COALESCE((
    SELECT MAX(page_media.created_at)
    FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_source_available
    WHERE page_media.track_id = track.id${mediaFilter}
  ), 0) ${orderDirection}, track.title COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
};

const pageMediaExists = (kind, sourceFilter, availableOnly) => {
  const { conditions, parameters } = mediaSourceClause(sourceFilter);
  if (availableOnly === true) conditions.push("page_media.available = 1");
  const conditionSql = conditions.length ? conditions.join(" AND ") : "1 = 1";
  if (kind === "artists") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_albums AS page_album
        JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_source_available
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album.artist_id = artist.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_source_available
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album_track.album_id = album.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_source_available
      WHERE page_media.track_id = track.id AND ${conditionSql}
    )`,
    parameters,
  };
};

const genrePredicate = (aliases, genre) => {
  const clauses = [];
  const parameters = [];
  aliases.forEach((alias) => {
    GENRE_METADATA_PATHS.forEach((path) => {
      clauses.push(
        `EXISTS (
          SELECT 1 FROM json_each(COALESCE(${alias}.metadata_json, '{}'), '${path}') AS genre_value
          WHERE lower(CAST(genre_value.value AS TEXT)) = lower(?)
        )`,
      );
      parameters.push(genre);
    });
  });
  return { sql: `(${clauses.join(" OR ")})`, parameters };
};

function buildPageQuery({
  kind,
  sourceFilter,
  availableOnly,
  query,
  genre,
  sort,
  direction,
  artistId,
  albumId,
}) {
  const where = [];
  const parameters = [];
  const media = pageMediaExists(kind, sourceFilter, availableOnly);
  where.push(media.sql);
  parameters.push(...media.parameters);

  let from;
  let idExpression;
  let searchableFields;
  let genreAliases;
  if (kind === "artists") {
    from = "FROM library_artists AS artist";
    idExpression = "artist.id";
    searchableFields = ["artist.name"];
    genreAliases = ["artist"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("EXISTS (SELECT 1 FROM library_albums AS filter_album WHERE filter_album.id = ? AND filter_album.artist_id = artist.id)");
      parameters.push(Number(albumId));
    }
  } else if (kind === "albums") {
    from = "FROM library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id";
    idExpression = "album.id";
    searchableFields = ["album.title", "album.album_artist", "artist.name"];
    genreAliases = ["artist", "album"];
    if (artistId) {
      where.push("album.artist_id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  } else {
    from = `FROM library_tracks AS track
      JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
      JOIN library_albums AS album ON album.id = album_track.album_id
      JOIN library_artists AS artist ON artist.id = album.artist_id`;
    idExpression = "track.id";
    searchableFields = [
      "track.title",
      "track.artist_name",
      "album.title",
      "album.album_artist",
      "artist.name",
    ];
    genreAliases = ["artist", "album", "track"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  }

  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    where.push(`(${searchableFields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    parameters.push(...searchableFields.map(() => pattern));
  }
  if (genre) {
    const predicate = genrePredicate(genreAliases, genre);
    where.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }

  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  let orderBy;
  if (sort === "newest" && (kind === "albums" || kind === "tracks")) {
    orderBy = recentMediaOrder(kind, sourceFilter, availableOnly, direction);
  } else if (sort === "artist" && kind !== "artists") {
    orderBy = `artist.name COLLATE NOCASE ${orderDirection}, ${kind === "albums" ? "album.title" : "track.title"} COLLATE NOCASE ${orderDirection}`;
  } else if (kind === "artists") {
    orderBy = `coalesce(artist.sort_name, artist.name) COLLATE NOCASE ${orderDirection}, artist.name COLLATE NOCASE ${orderDirection}`;
  } else {
    orderBy = `${kind === "albums" ? "album.title" : "track.title"} COLLATE NOCASE ${orderDirection}`;
  }

  return {
    from,
    idExpression,
    where: where.join(" AND "),
    parameters,
    orderBy,
  };
}

function getCanonicalGenreStats({ sourceFilter, availableOnly }) {
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const cached = genreStatsCache.get(cacheKey);
  if (cached) return cached;
  const artistMedia = pageMediaExists("artists", sourceFilter, availableOnly);
  const albumMedia = pageMediaExists("albums", sourceFilter, availableOnly);
  const trackMedia = pageMediaExists("tracks", sourceFilter, availableOnly);
  const stats = new Map();
  for (const row of db.prepare(
    `SELECT artist.metadata_json FROM library_artists AS artist WHERE ${artistMedia.sql}`,
  ).iterate(...artistMedia.parameters)) {
    addGenreStats(stats, parseJson(row.metadata_json), "artists");
  }
  for (const row of db.prepare(
    `SELECT album.metadata_json
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE ${albumMedia.sql}`,
  ).iterate(...albumMedia.parameters)) {
    addGenreStats(stats, parseJson(row.metadata_json), "albums");
  }
  for (const row of db.prepare(
    `SELECT track.metadata_json FROM library_tracks AS track WHERE ${trackMedia.sql}`,
  ).iterate(...trackMedia.parameters)) {
    addGenreStats(stats, parseJson(row.metadata_json), "tracks");
  }
  const sortedStats = [...stats.values()].sort((left, right) => left.name.localeCompare(right.name));
  genreStatsCache.set(cacheKey, sortedStats);
  return sortedStats;
}

function getPageLibrary(kind, ids, sourceFilter, availableOnly, albumId = null) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  const conditions = [`${alias}.id IN (${ids.map(() => "?").join(",")})`];
  const parameters = [...ids];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (kind === "tracks" && albumId) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}
     ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
       album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
       track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
  ).iterate(...parameters);
  return buildLibraryFromRows(rows);
}

function getAlbumTrackLibrary(
  albumId,
  sourceFilter,
  { query = "", genre = "", sort = "album", direction = "asc", artistId = null } = {},
) {
  const conditions = ["album.id = ?"];
  const parameters = [];
  const mediaConditions = [
    "media.track_id = track.id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  if (artistId) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    conditions.push(`(${[
      "track.title",
      "track.artist_name",
      "album.title",
      "album.album_artist",
      "artist.name",
    ].map((field) => `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    parameters.push(...["track.title", "track.artist_name", "album.title", "album.album_artist", "artist.name"]
      .map(() => pattern));
  }
  if (genre) {
    const predicate = genrePredicate(["artist", "album", "track"], genre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  const orderBy = sort === "album"
    ? "album_track.disc_number ASC, album_track.track_number ASC"
    : sort === "newest"
      ? recentMediaOrder("tracks", sourceFilter, false, direction)
    : sort === "artist"
      ? `artist.name COLLATE NOCASE ${orderDirection}, track.title COLLATE NOCASE ${orderDirection}`
      : `track.title COLLATE NOCASE ${orderDirection}`;
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${orderBy}, album_track.disc_number, album_track.track_number,
       media.path COLLATE NOCASE`,
  ).iterate(...parameters);
  return buildLibraryFromRows(rows);
}

function getAlbumTrackPage(albumId, sourceFilter, page, currentPageSize, options = {}) {
  const completeLibrary = getAlbumTrackLibrary(albumId, sourceFilter);
  const library = getAlbumTrackLibrary(albumId, sourceFilter, options);
  const album = completeLibrary.albums[0] || null;
  const artist = album
    ? completeLibrary.artists.find((candidate) => candidate.id === album.artistId) || null
    : null;
  const tracks = library.tracks;
  const availableTrackCount = completeLibrary.tracks.filter((track) => track.available).length;
  const pageItems = tracks.slice((page - 1) * currentPageSize, page * currentPageSize);
  const albums = album
    ? [{
        ...album,
        trackCount: tracks.length,
        availableTrackCount,
      }]
    : [];
  return {
    kind: "tracks",
    page,
    pageSize: currentPageSize,
    total: tracks.length,
    hasMore: page * currentPageSize < tracks.length,
    items: pageItems,
    artists: artist ? [artist] : [],
    albums,
    tracks: pageItems,
    genres: getCanonicalGenreStats({ sourceFilter, availableOnly: false }),
  };
}

function getAlbumStats(albumIds, sourceFilter) {
  if (!albumIds.length) return new Map();
  const conditions = [`album_track.album_id IN (${albumIds.map(() => "?").join(",")})`];
  const parameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(...albumIds);
  const rows = db.prepare(
    `SELECT
       album_track.album_id AS album_id,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COUNT(DISTINCT CASE WHEN media.available = 1 THEN album_track.track_id END) AS available_track_count
     FROM library_album_tracks AS album_track
     LEFT JOIN library_media_files AS media
       ON ${mediaConditions.join(" AND ")}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album_track.album_id`,
  ).all(...parameters);
  return new Map(rows.map((row) => [String(row.album_id), {
    trackCount: Number(row.track_count),
    availableTrackCount: Number(row.available_track_count),
  }]));
}

export function getCanonicalLibraryPage({
  source = null,
  availableOnly = false,
  kind = "albums",
  page = 1,
  pageSize: requestedPageSize = DEFAULT_PAGE_SIZE,
  query = "",
  genre = "",
  sort = null,
  direction = "asc",
  artistId = null,
  albumId = null,
} = {}) {
  const normalizedKind = text(kind).toLocaleLowerCase();
  if (!PAGE_KINDS.has(normalizedKind)) {
    throw new Error(`Unsupported library page kind: ${normalizedKind}`);
  }
  const sourceFilter = normalizeSource(source);
  const normalizedQuery = text(query).toLocaleLowerCase();
  const normalizedGenre = text(genre);
  const normalizedDirection = text(direction).toLocaleLowerCase();
  const normalizedSort =
    text(sort).toLocaleLowerCase() ||
    (normalizedKind === "tracks" && albumId ? "album" : "name");
  const currentPage = pageNumber(page);
  const currentPageSize = pageSize(requestedPageSize);

  if (normalizedKind === "genres") {
    let collection = getCanonicalGenreStats({ sourceFilter, availableOnly });
    if (normalizedQuery) {
      collection = collection.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(normalizedQuery),
      );
    }
    if (normalizedDirection === "desc") collection = [...collection].reverse();
    const total = collection.length;
    const items = collection.slice(
      (currentPage - 1) * currentPageSize,
      currentPage * currentPageSize,
    );
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: [],
      albums: [],
      tracks: [],
      genres: getCanonicalGenreStats({ sourceFilter, availableOnly }),
    };
  }

  if (normalizedKind === "tracks" && albumId && availableOnly !== true) {
    return getAlbumTrackPage(albumId, sourceFilter, currentPage, currentPageSize, {
      query: normalizedQuery,
      genre: normalizedGenre,
      sort: normalizedSort,
      direction: normalizedDirection,
      artistId,
    });
  }

  const queryDefinition = buildPageQuery({
    kind: normalizedKind,
    sourceFilter,
    availableOnly,
    query: normalizedQuery,
    genre: normalizedGenre,
    sort: normalizedSort,
    direction: normalizedDirection,
    artistId,
    albumId,
  });
  const total = db.prepare(
    `SELECT COUNT(DISTINCT ${queryDefinition.idExpression}) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
  ).get(...queryDefinition.parameters).total;
  const ids = db.prepare(
    `SELECT ${queryDefinition.idExpression} AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}
     GROUP BY ${queryDefinition.idExpression}
     ORDER BY ${queryDefinition.orderBy}
     LIMIT ? OFFSET ?`,
  ).all(
    ...queryDefinition.parameters,
    currentPageSize,
    (currentPage - 1) * currentPageSize,
  ).map((row) => row.page_id);
  const library = getPageLibrary(normalizedKind, ids, sourceFilter, availableOnly, albumId);
  const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
  const albumStats = getAlbumStats(
    library.albums.map((album) => album.id),
    sourceFilter,
  );
  const collection = ids
    .map((id) => library[normalizedKind].find((entity) => String(entity.id) === String(id)))
    .filter(Boolean);
  const withAlbumStats = (album) => {
    const stats = albumStats.get(String(album.id));
    return {
      ...album,
      trackCount: stats?.trackCount ?? album.trackIds.length,
      availableTrackCount: stats?.availableTrackCount ?? 0,
    };
  };
  const items = collection.map((entity) => normalizedKind === "albums" ? withAlbumStats(entity) : entity);

  const relatedAlbums = normalizedKind === "tracks"
    ? [...new Set(items.flatMap((track) =>
        track.albums.map((entry) => String(entry.albumId))))]
        .map((id) => albumsById.get(id))
        .filter(Boolean)
        .map(withAlbumStats)
    : normalizedKind === "albums" ? items : [];
  const relatedArtists = normalizedKind === "artists"
    ? items
    : relatedAlbums
      .map((album) => artistsById.get(String(album.artistId)))
      .filter(Boolean)
      .filter((artist, index, values) =>
        values.findIndex((candidate) => candidate.id === artist.id) === index,
      );

  return {
    kind: normalizedKind,
    page: currentPage,
    pageSize: currentPageSize,
    total,
    hasMore: currentPage * currentPageSize < total,
    items,
    artists: relatedArtists,
    albums: relatedAlbums,
    tracks: normalizedKind === "tracks" ? items : [],
    genres: getCanonicalGenreStats({ sourceFilter, availableOnly }),
  };
}

export function invalidateCanonicalLibraryCache() {
  libraryCache.clear();
  genreStatsCache.clear();
}

export { normalizeSource };
