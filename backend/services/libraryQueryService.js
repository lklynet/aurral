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
  media.source AS media_source,
  media.path AS media_path,
  media.format AS media_format,
  media.size AS media_size,
  media.mtime_ms AS media_mtime_ms,
  media.duration_ms AS media_duration_ms,
  media.quality_json AS media_quality_json,
  media.available AS media_available`;

const CANONICAL_FROM = `FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
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

    if (!artist.sources.includes(row.media_source)) artist.sources.push(row.media_source);
    if (!album.sources.includes(row.media_source)) album.sources.push(row.media_source);
    if (!track.sources.includes(row.media_source)) track.sources.push(row.media_source);

    const file = {
      id: row.media_id,
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

  const rows = db
    .prepare(
      `${CANONICAL_SELECT}
      ${CANONICAL_FROM}
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
        album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
        track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
    )
    .all(...parameters);
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

const genreStatsFor = (library) => {
  const stats = new Map();
  const add = (genre, kind) => {
    const entry = stats.get(genre) || { name: genre, artists: 0, albums: 0, tracks: 0 };
    entry[kind] += 1;
    stats.set(genre, entry);
  };
  library.artists.forEach((artist) =>
    metadataGenres(artist).forEach((genre) => add(genre, "artists")),
  );
  library.albums.forEach((album) =>
    metadataGenres(album).forEach((genre) => add(genre, "albums")),
  );
  library.tracks.forEach((track) =>
    metadataGenres(track).forEach((genre) => add(genre, "tracks")),
  );
  return [...stats.values()].sort((left, right) => left.name.localeCompare(right.name));
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
        JOIN library_media_files AS page_media ON page_media.track_id = page_album_track.track_id
        WHERE page_album.artist_id = artist.id AND ${conditionSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media ON page_media.track_id = page_album_track.track_id
        WHERE page_album_track.album_id = album.id AND ${conditionSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media
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
  if (sort === "newest" && kind === "albums") {
    orderBy = `coalesce(album.release_date, '') ${direction === "desc" ? "ASC" : "DESC"}, album.title COLLATE NOCASE ${orderDirection}`;
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
  const artists = db.prepare(
    `SELECT artist.metadata_json FROM library_artists AS artist WHERE ${artistMedia.sql}`,
  ).all(...artistMedia.parameters);
  const albums = db.prepare(
    `SELECT album.metadata_json
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE ${albumMedia.sql}`,
  ).all(...albumMedia.parameters);
  const tracks = db.prepare(
    `SELECT track.metadata_json FROM library_tracks AS track WHERE ${trackMedia.sql}`,
  ).all(...trackMedia.parameters);
  const stats = genreStatsFor({
    artists: artists.map((row) => ({ metadata: parseJson(row.metadata_json) })),
    albums: albums.map((row) => ({ metadata: parseJson(row.metadata_json) })),
    tracks: tracks.map((row) => ({ metadata: parseJson(row.metadata_json) })),
  });
  genreStatsCache.set(cacheKey, stats);
  return stats;
}

function getPageLibrary(kind, ids, sourceFilter, availableOnly) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  const conditions = [`${alias}.id IN (${ids.map(() => "?").join(",")})`];
  const parameters = [...ids];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}
     ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
       album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
       track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
  ).all(...parameters);
  return buildLibraryFromRows(rows);
}

export function getCanonicalLibraryPage({
  source = null,
  availableOnly = false,
  kind = "albums",
  page = 1,
  pageSize: requestedPageSize = DEFAULT_PAGE_SIZE,
  query = "",
  genre = "",
  sort = "name",
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

  const queryDefinition = buildPageQuery({
    kind: normalizedKind,
    sourceFilter,
    availableOnly,
    query: normalizedQuery,
    genre: normalizedGenre,
    sort: text(sort).toLocaleLowerCase(),
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
  const library = getPageLibrary(normalizedKind, ids, sourceFilter, availableOnly);
  const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
  const tracksById = new Map(library.tracks.map((track) => [String(track.id), track]));
  const collection = ids
    .map((id) => library[normalizedKind].find((entity) => String(entity.id) === String(id)))
    .filter(Boolean);
  const withAlbumStats = (album) => {
    const availableTrackCount = album.trackIds.filter((trackId) =>
      tracksById.get(String(trackId))?.available,
    ).length;
    return {
      ...album,
      trackCount: album.trackIds.length,
      availableTrackCount,
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
