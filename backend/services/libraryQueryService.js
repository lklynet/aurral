import { db, dbHelpers } from "../config/db-sqlite.js";
import {
  computeLibraryGenreStats,
  rebuildStoredLibraryGenreStats,
} from "../config/library-search-index.js";
import { getLibrarySearchMatch } from "./librarySearchIndex.js";

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

const parseSources = (value) => String(value || "")
  .split(",")
  .map((source) => source.trim())
  .filter(Boolean)
  .sort();

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

export function getCanonicalTrackPath(albumReference, trackReference) {
  const albumValue = String(albumReference ?? "").trim();
  const trackValue = String(trackReference ?? "").trim();
  if (!albumValue || !trackValue) return null;

  const album = /^[1-9]\d*$/.test(albumValue)
    ? db.prepare("SELECT id FROM library_albums WHERE id = ?").get(albumValue)
    : db.prepare(
      `SELECT id FROM library_albums
       WHERE identity_key = ? OR mbid = ? OR release_group_mbid = ?
       LIMIT 1`,
    ).get(albumValue, albumValue, albumValue);
  const track = /^[1-9]\d*$/.test(trackValue)
    ? db.prepare("SELECT id FROM library_tracks WHERE id = ?").get(trackValue)
    : db.prepare(
      `SELECT id FROM library_tracks
       WHERE identity_key = ? OR mbid = ?
       LIMIT 1`,
    ).get(trackValue, trackValue);
  if (!album || !track) return null;

  return db.prepare(
    `SELECT media.path
     FROM library_media_files AS media
     JOIN library_album_tracks AS album_track
       ON album_track.album_id = ? AND album_track.track_id = media.track_id
     WHERE media.track_id = ?
       AND media.available = 1
       AND (media.album_id = ? OR media.album_id IS NULL)
     ORDER BY media.album_id = ? DESC,
              media.source = 'lidarr' DESC,
              media.path COLLATE NOCASE
     LIMIT 1`,
  ).get(album.id, track.id, album.id, album.id)?.path || null;
}

export function getCanonicalTrack({
  trackId,
  source = null,
  availableOnly = false,
  albumId = null,
} = {}) {
  const reference = String(trackId ?? "").trim();
  if (!reference) return { artists: [], albums: [], tracks: [] };

  const numericId = /^\d+$/.test(reference) ? Number(reference) : null;
  const conditions = [];
  const parameters = [];
  if (Number.isSafeInteger(numericId) && numericId > 0) {
    conditions.push("track.id = ?");
    parameters.push(numericId);
  } else {
    conditions.push("(track.identity_key = ? OR track.mbid = ?)");
    parameters.push(reference, reference);
  }
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }

  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions,
    parameters,
  });
}

export function getCanonicalTrackOwnership({
  trackMbid = null,
  artistName = null,
  trackName = null,
  source = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = ["media.available = 1"];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }

  const mbid = String(trackMbid || "").trim();
  if (mbid) {
    conditions.push("track.mbid = ?");
    parameters.push(mbid);
  } else {
    const artist = String(artistName || "").trim();
    const title = String(trackName || "").trim();
    if (!artist || !title) return false;
    conditions.push("lower(coalesce(track.artist_name, '')) = lower(?)");
    conditions.push("lower(track.title) = lower(?)");
    parameters.push(artist, title);
  }

  return Boolean(db.prepare(
    `SELECT EXISTS (
       SELECT 1
       ${CANONICAL_FROM}
       WHERE ${conditions.join(" AND ")}
     ) AS owned`,
  ).get(...parameters)?.owned);
}

export function getCanonicalTrackCount({ source = null, availableOnly = false } = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return Number(db.prepare(
    `SELECT COUNT(DISTINCT track.id) AS total
     ${CANONICAL_FROM}
     ${where}`,
  ).get(...parameters)?.total || 0);
}

export function getCanonicalTrackSample({
  source = null,
  availableOnly = false,
  limit = 100,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     ${where}
     ${canonicalOrder}
     LIMIT ?`,
  ).iterate(...parameters, boundedLimit);
  return buildLibraryFromRows(rows);
}

const CANONICAL_FAVORITE_TABLES = {
  artist: "library_artists",
  album: "library_albums",
  song: "library_tracks",
};

function parseCanonicalFavoriteId(value) {
  const input = String(value || "").trim();
  const separator = input.indexOf(":");
  if (separator <= 0) return null;
  const kind = input.slice(0, separator);
  if (!CANONICAL_FAVORITE_TABLES[kind]) return null;
  const rawKey = input.slice(separator + 1);
  if (!rawKey) return null;
  try {
    const key = decodeURIComponent(rawKey).trim();
    return key ? { kind, key, rawKey } : null;
  } catch {
    return null;
  }
}

export function getCanonicalFavoriteTargetKeys(values = []) {
  const targets = (Array.isArray(values) ? values : [])
    .map(parseCanonicalFavoriteId)
    .filter(Boolean);
  const found = new Set();
  for (const [kind, table] of Object.entries(CANONICAL_FAVORITE_TABLES)) {
    const keys = [...new Set(
      targets.filter((target) => target.kind === kind).map((target) => target.key),
    )];
    if (!keys.length) continue;
    const rows = db.prepare(
      `SELECT identity_key FROM ${table}
       WHERE identity_key IN (${keys.map(() => "?").join(",")})`,
    ).all(...keys);
    for (const row of rows) {
      for (const target of targets) {
        if (target.kind !== kind || target.key !== row.identity_key) continue;
        found.add(`${kind}:${target.rawKey}`);
        found.add(`${kind}:${encodeURIComponent(target.key)}`);
      }
    }
  }
  return found;
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

function getCanonicalLibraryForIds(kind, ids, source, availableOnly) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions: [`${alias}.id IN (${values.map(() => "?").join(",")})`],
    parameters: values,
  });
}

function resolveCanonicalReferenceIds(table, references, columns) {
  const numericIds = references
    .filter((reference) => /^\d+$/.test(reference))
    .map(Number);
  const queries = [];
  const parameters = [];
  if (numericIds.length) {
    queries.push(`SELECT id FROM ${table} WHERE id IN (${numericIds.map(() => "?").join(",")})`);
    parameters.push(...numericIds);
  }
  for (const column of columns) {
    queries.push(
      `SELECT id FROM ${table} WHERE ${column} IN (${references.map(() => "?").join(",")})`,
    );
    parameters.push(...references);
  }
  return db.prepare(queries.join(" UNION ")).all(...parameters).map((row) => row.id);
}

export function getCanonicalLibraryForArtistReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
} = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const ids = resolveCanonicalReferenceIds(
    "library_artists",
    references,
    ["identity_key", "mbid"],
  );
  return getCanonicalLibraryForIds("artists", ids, source, availableOnly);
}

export function getCanonicalLibraryForAlbumIds({
  source = null,
  availableOnly = false,
  ids = [],
} = {}) {
  return getCanonicalLibraryForIds("albums", ids, source, availableOnly);
}

export function getCanonicalLibraryForTrackIds({
  source = null,
  availableOnly = false,
  ids = [],
  albumId = null,
} = {}) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const conditions = [`track.id IN (${values.map(() => "?").join(",")})`];
  const parameters = [...values];
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  return getScopedCanonicalLibrary({ source, availableOnly, conditions, parameters });
}

export function getCanonicalLibraryForAlbumReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
} = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const ids = resolveCanonicalReferenceIds(
    "library_albums",
    references,
    ["identity_key", "mbid", "release_group_mbid"],
  );
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const sourceFilter = normalizeSource(source);
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  parameters.push(...ids);
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id IN (${ids.map(() => "?").join(",")})
     ${canonicalOrder}`,
  ).iterate(...parameters);
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

const pageNumber = (value) => Math.max(1, Number.parseInt(value, 10) || 1);

const pageSize = (value) =>
  Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(value, 10) || DEFAULT_PAGE_SIZE));

const genreStatsCache = new Map();
const GENRE_STATS_SETTING_PREFIX = "libraryGenreStats:";
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
      JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
        ON page_media.track_id = page_album_track.track_id
      WHERE page_album_track.album_id = album.id
        AND ${albumMediaCondition("page_media", "page_album_track")}${mediaFilter}
    ), 0) ${orderDirection}, album.title COLLATE NOCASE ${direction === "desc" ? "DESC" : "ASC"}`;
  }
  return `COALESCE((
    SELECT MAX(page_media.created_at)
    FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
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
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
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
        JOIN library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
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
      SELECT 1 FROM library_media_files AS page_media INDEXED BY idx_library_media_files_track_album_source_available
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
        `(json_valid(${alias}.metadata_json) AND EXISTS (
          SELECT 1 FROM json_each(${alias}.metadata_json, '${path}') AS genre_value
          WHERE lower(CAST(genre_value.value AS TEXT)) = lower(?)
        ))`,
      );
      parameters.push(genre);
    });
  });
  return { sql: `(${clauses.join(" OR ")})`, parameters };
};

const pageLimit = (value, fallback = 10000) => {
  if (value === null || value === undefined || value === "") return fallback;
  return Math.min(10000, Math.max(0, Number.parseInt(value, 10) || 0));
};

const pageOffset = (value) => Math.max(0, Number.parseInt(value, 10) || 0);

export function getCanonicalArtistPage({
  source = null,
  availableOnly = false,
  query = "",
  offset = 0,
  limit = null,
  includeStats = false,
  searchMatch = null,
  artistIds = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("artists", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    conditions.push("lower(artist.name) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeLike(normalizedQuery)}%`);
  }
  const boundedLimit = limit === null || limit === undefined || limit === ""
    ? null
    : pageLimit(limit);
  const pageSql = boundedLimit === null ? "" : "LIMIT ? OFFSET ?";
  const searchJoin = searchMatch
    ? `JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'artist' AND search_document.entity_id = artist.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?`
    : "";
  if (searchMatch) {
    parameters.unshift(searchMatch);
    conditions.push("lower(search_document.title) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeLike(normalizedQuery)}%`);
  }
  const ids = Array.isArray(artistIds)
    ? [...new Set(artistIds
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0))]
    : db.prepare(
      `SELECT artist.id
       FROM library_artists AS artist
       ${searchJoin}
       WHERE ${conditions.join(" AND ")}
       ${searchMatch ? "" : "ORDER BY coalesce(artist.sort_name, artist.name) COLLATE NOCASE, artist.name COLLATE NOCASE"}
       ${pageSql}`,
    ).all(...parameters, ...(boundedLimit === null ? [] : [boundedLimit, pageOffset(offset)])).map((row) => row.id);
  if (!ids.length) return { artists: [], albums: [], tracks: [] };

  if (!includeStats) {
    const filterAlbums = Boolean(sourceFilter) || availableOnly === true;
    const albumJoin = filterAlbums ? "JOIN" : "LEFT JOIN";
    const albumFilter = filterAlbums
      ? `AND EXISTS (
          SELECT 1
          FROM library_album_tracks AS album_track
          JOIN library_media_files AS media
            ON media.track_id = album_track.track_id
            AND ${albumMediaCondition("media", "album_track")}
          WHERE album_track.album_id = album.id
            ${sourceFilter ? "AND media.source = ?" : ""}
            ${availableOnly === true ? "AND media.available = 1" : ""}
        )`
      : "";
    const rows = db.prepare(
      `SELECT
         artist.id AS artist_id,
         artist.identity_key AS artist_identity_key,
         artist.mbid AS artist_mbid,
         artist.name AS artist_name,
         artist.sort_name AS artist_sort_name,
         artist.metadata_json AS artist_metadata_json,
         COUNT(DISTINCT album.id) AS album_count
       FROM library_artists AS artist
       ${albumJoin} library_albums AS album ON album.artist_id = artist.id
       WHERE artist.id IN (${ids.map(() => "?").join(",")})
         ${albumFilter}
       GROUP BY artist.id`,
    ).all(...ids, ...(sourceFilter ? [sourceFilter] : []));
    const byId = new Map(rows.map((row) => [row.artist_id, {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [],
      albumCount: Number(row.album_count || 0),
      sources: [],
      available: availableOnly === true,
    }]));
    return { artists: ids.map((id) => byId.get(id)).filter(Boolean), albums: [], tracks: [] };
  }

  const aggregateParameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    aggregateParameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  aggregateParameters.push(...ids);
  const rows = db.prepare(
    `SELECT
       artist.id AS artist_id,
       artist.identity_key AS artist_identity_key,
       artist.mbid AS artist_mbid,
       artist.name AS artist_name,
       artist.sort_name AS artist_sort_name,
       artist.metadata_json AS artist_metadata_json,
       COUNT(DISTINCT album.id) AS album_count,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COALESCE(SUM(media.size), 0) AS size_on_disk,
       GROUP_CONCAT(DISTINCT media.source) AS sources,
       MAX(media.available) AS available
     FROM library_artists AS artist
     JOIN library_albums AS album ON album.artist_id = artist.id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE artist.id IN (${ids.map(() => "?").join(",")})
     GROUP BY artist.id
     ORDER BY coalesce(artist.sort_name, artist.name) COLLATE NOCASE,
       artist.name COLLATE NOCASE`,
  ).all(...aggregateParameters);
  const byId = new Map(rows.map((row) => [row.artist_id, {
    id: row.artist_id,
    identityKey: row.artist_identity_key,
    mbid: row.artist_mbid,
    name: row.artist_name,
    sortName: row.artist_sort_name,
    metadata: parseJson(row.artist_metadata_json),
    albumIds: [],
    albumCount: Number(row.album_count || 0),
    trackCount: Number(row.track_count || 0),
    sizeOnDisk: Number(row.size_on_disk || 0),
    sources: parseSources(row.sources),
    available: Boolean(row.available),
  }]));
  return { artists: ids.map((id) => byId.get(id)).filter(Boolean), albums: [], tracks: [] };
}

function albumGenrePredicate(genre) {
  const direct = genrePredicate(["artist", "album"], genre);
  const tracks = genrePredicate(["track"], genre);
  return {
    sql: `(${direct.sql} OR EXISTS (
      SELECT 1
      FROM library_album_tracks AS genre_album_track
      JOIN library_tracks AS track ON track.id = genre_album_track.track_id
      WHERE genre_album_track.album_id = album.id
        AND ${tracks.sql}
    ))`,
    parameters: [...direct.parameters, ...tracks.parameters],
  };
}

export function getCanonicalAlbumPage({
  source = null,
  availableOnly = false,
  type = "alphabeticalByName",
  genre = "",
  fromYear = null,
  toYear = null,
  query = "",
  artistId = null,
  offset = 0,
  limit = 20,
  searchMatch = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("albums", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const fields = ["album.title", "album.album_artist", "artist.name"];
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    conditions.push(`(${fields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    parameters.push(...fields.map(() => pattern));
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("album.artist_id = ?");
    parameters.push(Number(artistId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = albumGenrePredicate(normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const parsedFromYear = Number.parseInt(fromYear, 10);
  const parsedToYear = Number.parseInt(toYear, 10);
  const lowerYear = Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
    ? Math.min(parsedFromYear, parsedToYear)
    : parsedFromYear;
  const upperYear = Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
    ? Math.max(parsedFromYear, parsedToYear)
    : parsedToYear;
  if (Number.isFinite(lowerYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) >= ?");
    parameters.push(lowerYear);
  }
  if (Number.isFinite(upperYear)) {
    conditions.push("CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) <= ?");
    parameters.push(upperYear);
  }

  let orderBy;
  if (type === "random") {
    orderBy = "random()";
  } else if (type === "newest" || type === "recent") {
    orderBy = recentMediaOrder("albums", sourceFilter, availableOnly, "asc");
  } else if (type === "alphabeticalByArtist") {
    orderBy = "coalesce(album.album_artist, artist.name) COLLATE NOCASE, album.title COLLATE NOCASE";
  } else if (type === "byYear") {
    orderBy = `CAST(substr(COALESCE(album.release_date, ''), 1, 4) AS INTEGER) ${Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear) && parsedFromYear > parsedToYear ? "DESC" : "ASC"}, album.title COLLATE NOCASE`;
  } else if (type === "byGenre") {
    orderBy = "coalesce(artist.name, album.album_artist) COLLATE NOCASE, album.title COLLATE NOCASE";
  } else {
    orderBy = "album.title COLLATE NOCASE, coalesce(album.album_artist, artist.name) COLLATE NOCASE";
  }

  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const searchJoin = searchMatch
    ? `JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'album' AND search_document.entity_id = album.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?`
    : "";
  if (searchMatch) {
    parameters.unshift(searchMatch);
    conditions.push("(lower(search_document.title) LIKE ? ESCAPE '\\' OR lower(search_document.artist_name) LIKE ? ESCAPE '\\')");
    parameters.push(`%${escapeLike(normalizedQuery)}%`, `%${escapeLike(normalizedQuery)}%`);
  }
  const ids = db.prepare(
    `SELECT album.id
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${searchJoin}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album.id
     ${searchMatch ? "" : `ORDER BY ${orderBy}`}
     LIMIT ? OFFSET ?`,
  ).all(...parameters, boundedLimit, pageOffset(offset)).map((row) => row.id);
  const library = getCanonicalLibraryForAlbumIds({ source: sourceFilter, availableOnly, ids });
  const albumsById = new Map(library.albums.map((album) => [album.id, album]));
  library.albums = ids.map((id) => albumsById.get(id)).filter(Boolean);
  return library;
}

function getRandomTrackIds({ conditions, parameters, limit, offset }) {
  const maximum = Number(db.prepare("SELECT max(id) AS maximum FROM library_tracks").get()?.maximum || 0);
  if (!maximum) return [];
  const needed = limit + offset;
  const pivot = Math.floor(Math.random() * maximum) + 1;
  const read = (operator, boundary, count) => db.prepare(
    `SELECT track.id
     FROM library_tracks AS track
     WHERE ${conditions.join(" AND ")} AND track.id ${operator} ?
     ORDER BY track.id
     LIMIT ?`,
  ).all(...parameters, boundary, count).map((row) => row.id);
  const ids = read(">=", pivot, needed);
  if (ids.length < needed) ids.push(...read("<", pivot, needed - ids.length));
  return ids.slice(offset, offset + limit);
}

export function getCanonicalTrackPage({
  source = null,
  availableOnly = false,
  query = "",
  genre = "",
  artist = "",
  artistId = null,
  albumId = null,
  offset = 0,
  limit = 20,
  random = false,
  searchMatch = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("tracks", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const fields = [
    "track.title",
    "track.artist_name",
    "album.title",
    "album.album_artist",
    "artist.name",
  ];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    conditions.push(`(${fields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    parameters.push(...fields.map(() => pattern));
  }
  const artistReference = text(artist);
  const normalizedArtist = artistReference.toLocaleLowerCase();
  if (normalizedArtist) {
    conditions.push("(lower(artist.name) = ? OR lower(coalesce(track.artist_name, '')) = ? OR artist.identity_key = ?)");
    parameters.push(normalizedArtist, normalizedArtist, artistReference);
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = genrePredicate(["artist", "album", "track"], normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const useSearchIndex = Boolean(searchMatch)
    && !artistReference
    && !(artistId !== null && artistId !== undefined && String(artistId).trim())
    && !(albumId !== null && albumId !== undefined && String(albumId).trim())
    && !normalizedGenre;
  if (useSearchIndex) {
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    const searchConditions = [
      ...conditions,
      "(lower(search_document.title) LIKE ? ESCAPE '\\' OR lower(search_document.artist_name) LIKE ? ESCAPE '\\' OR lower(search_document.album_name) LIKE ? ESCAPE '\\')",
    ];
    const ids = db.prepare(
      `SELECT track.id
       FROM library_tracks AS track
       JOIN library_search_documents AS search_document
         ON search_document.entity_kind = 'track' AND search_document.entity_id = track.id
       JOIN library_search_fts AS search_fts
         ON search_fts.rowid = search_document.id AND library_search_fts MATCH ?
       WHERE ${searchConditions.join(" AND ")}
       LIMIT ? OFFSET ?`,
    ).all(searchMatch, ...parameters, pattern, pattern, pattern, boundedLimit, pageOffset(offset))
      .map((row) => row.id);
    const library = getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
    return library;
  }
  if (random && !normalizedQuery && !artistReference && !normalizedGenre
    && !(artistId !== null && artistId !== undefined && String(artistId).trim())
    && !(albumId !== null && albumId !== undefined && String(albumId).trim())) {
    const ids = getRandomTrackIds({
      conditions,
      parameters,
      limit: boundedLimit,
      offset: pageOffset(offset),
    });
    const library = getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
    return library;
  }
  const orderBy = random
    ? "random()"
    : "artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE, album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number, track.title COLLATE NOCASE";
  const ids = db.prepare(
    `SELECT track.id
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY track.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
  ).all(...parameters, boundedLimit, pageOffset(offset)).map((row) => row.id);
  const library = getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
  return library;
}

export function getCanonicalSearchPage({
  source = null,
  availableOnly = false,
  query = "",
  artistLimit = 20,
  artistOffset = 0,
  albumLimit = 20,
  albumOffset = 0,
  songLimit = 20,
  songOffset = 0,
} = {}) {
  const searchMatch = getLibrarySearchMatch(query);
  const albumLibrary = getCanonicalAlbumPage({
    source,
    availableOnly,
    query,
    limit: albumLimit,
    offset: albumOffset,
    searchMatch,
  });
  const trackLibrary = getCanonicalTrackPage({
    source,
    availableOnly,
    query,
    limit: songLimit,
    offset: songOffset,
    searchMatch,
  });
  return {
    artists: getCanonicalArtistPage({
      source,
      availableOnly,
      query,
      limit: artistLimit,
      offset: artistOffset,
      searchMatch,
    }).artists,
    albums: albumLibrary,
    tracks: trackLibrary,
  };
}

export function getCanonicalTopTracks({
  source = null,
  availableOnly = false,
  artist,
  limit = 20,
} = {}) {
  return getCanonicalTrackPage({ source, availableOnly, artist, limit });
}

export function getCanonicalGenres({ source = null, availableOnly = false } = {}) {
  const sourceFilter = normalizeSource(source);
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const genreRows = (column) => GENRE_METADATA_PATHS.map((path) => `
    SELECT album_id, track_id, TRIM(CAST(genre_value.value AS TEXT)) AS genre
    FROM eligible_tracks
    JOIN json_each(
      CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END,
      '${path}'
    ) AS genre_value
    WHERE json_valid(${column})
      AND TRIM(CAST(genre_value.value AS TEXT)) <> ''`).join(" UNION ");
  return db.prepare(
    `WITH eligible_tracks AS MATERIALIZED (
       SELECT DISTINCT
         album.id AS album_id,
         track.id AS track_id,
         artist.metadata_json AS artist_metadata_json,
         album.metadata_json AS album_metadata_json,
         track.metadata_json AS track_metadata_json
       FROM library_albums AS album
       JOIN library_artists AS artist ON artist.id = album.artist_id
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
         ${genreRows("artist_metadata_json")}
         UNION
         ${genreRows("album_metadata_json")}
       )
     ),
     track_genres AS (
       SELECT DISTINCT album_id, track_id, genre FROM (
         ${genreRows("track_metadata_json")}
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
  const searchMatch = getLibrarySearchMatch(query);

  let from;
  let idExpression;
  let searchableFields;
  let genreAliases;
  let entityKind;
  let groupBy = null;
  if (kind === "artists") {
    entityKind = "artist";
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
    entityKind = "album";
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
    entityKind = "track";
    const needsRelations = Boolean(artistId || albumId || genre || sort === "artist")
      || Boolean(query && !searchMatch);
    from = needsRelations
      ? `FROM library_tracks AS track
        JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
        JOIN library_albums AS album ON album.id = album_track.album_id
        JOIN library_artists AS artist ON artist.id = album.artist_id`
      : "FROM library_tracks AS track";
    if (needsRelations) groupBy = "track.id";
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

  if (searchMatch) {
    from += `
      JOIN library_search_documents AS search_document
        ON search_document.entity_kind = '${entityKind}'
        AND search_document.entity_id = ${idExpression}
      JOIN library_search_fts AS search_fts
        ON search_fts.rowid = search_document.id
        AND library_search_fts MATCH ?`;
    parameters.unshift(searchMatch);
    const pattern = `%${escapeLike(query)}%`;
    const indexedFields = kind === "artists"
      ? ["search_document.title"]
      : kind === "albums"
        ? ["search_document.title", "search_document.artist_name"]
        : [
            "search_document.title",
            "search_document.artist_name",
            "search_document.album_name",
          ];
    where.push(`(${indexedFields.map((field) =>
      `lower(${field}) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    parameters.push(...indexedFields.map(() => pattern));
  } else if (query) {
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
    groupBy,
  };
}

function getCanonicalGenreStats({ sourceFilter, availableOnly }) {
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const cached = genreStatsCache.get(cacheKey);
  if (cached) return cached;
  const settingKey = `${GENRE_STATS_SETTING_PREFIX}${cacheKey}`;
  const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get(settingKey)?.value;
  if (stored) {
    const parsed = parseJson(stored);
    if (Array.isArray(parsed)) {
      genreStatsCache.set(cacheKey, parsed);
      return parsed;
    }
  }
  const sortedStats = computeLibraryGenreStats(db, { sourceFilter, availableOnly });
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

function buildAlbumTrackPageQuery(
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
  return {
    from: `FROM library_tracks AS track
      JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
      JOIN library_albums AS album ON album.id = album_track.album_id
      JOIN library_artists AS artist ON artist.id = album.artist_id
      LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}`,
    where: conditions.join(" AND "),
    parameters,
    orderBy,
  };
}

function getAlbumTrackSummary(albumId, sourceFilter) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  const row = db.prepare(
    `SELECT
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
       GROUP_CONCAT(DISTINCT media.source) AS sources,
       MAX(media.available) AS available
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ?
     GROUP BY album.id`,
  ).get(...parameters);
  if (!row) return { artist: null, album: null };
  const sources = parseSources(row.sources);
  return {
    artist: {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [row.album_id],
      sources,
      available: Boolean(row.available),
    },
    album: {
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
      sources,
      available: Boolean(row.available),
    },
  };
}

function getAlbumTrackPageLibrary(albumId, sourceFilter, ids) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId), ...ids);
  const rows = db.prepare(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ? AND track.id IN (${ids.map(() => "?").join(",")})
     ORDER BY album_track.disc_number, album_track.track_number,
       track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
  ).iterate(...parameters);
  return buildLibraryFromRows(rows);
}

function getAlbumTrackPage(albumId, sourceFilter, page, currentPageSize, options = {}) {
  const queryDefinition = buildAlbumTrackPageQuery(albumId, sourceFilter, options);
  const total = Number(db.prepare(
    `SELECT COUNT(DISTINCT track.id) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
  ).get(...queryDefinition.parameters)?.total || 0);
  const pageIds = db.prepare(
    `SELECT track.id AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}
     GROUP BY track.id
     ORDER BY ${queryDefinition.orderBy}, album_track.disc_number, album_track.track_number,
       media.path COLLATE NOCASE
     LIMIT ? OFFSET ?`,
  ).all(
    ...queryDefinition.parameters,
    currentPageSize,
    (page - 1) * currentPageSize,
  ).map((row) => row.page_id);
  const library = getAlbumTrackPageLibrary(albumId, sourceFilter, pageIds);
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const pageItems = pageIds.map((id) => tracksById.get(id)).filter(Boolean);
  const summary = getAlbumTrackSummary(albumId, sourceFilter);
  const stats = getAlbumStats([Number(albumId)], sourceFilter).get(String(albumId));
  const album = summary.album;
  const albums = album
    ? [{
        ...album,
        trackIds: pageItems.map((track) => track.id),
        trackCount: total,
        availableTrackCount: stats?.availableTrackCount ?? 0,
      }]
    : [];
  return {
    kind: "tracks",
    page,
    pageSize: currentPageSize,
    total,
    hasMore: page * currentPageSize < total,
    items: pageItems,
    artists: summary.artist ? [summary.artist] : [],
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
     ${queryDefinition.groupBy ? `GROUP BY ${queryDefinition.groupBy}` : ""}
     ORDER BY ${queryDefinition.orderBy}
     LIMIT ? OFFSET ?`,
  ).all(
    ...queryDefinition.parameters,
    currentPageSize,
    (currentPage - 1) * currentPageSize,
  ).map((row) => row.page_id);
  if (normalizedKind === "artists") {
    const library = getCanonicalArtistPage({
      source: sourceFilter,
      availableOnly,
      artistIds: ids,
      includeStats: true,
    });
    const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
    const items = ids.map((id) => artistsById.get(String(id))).filter(Boolean);
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: items,
      albums: [],
      tracks: [],
      genres: getCanonicalGenreStats({ sourceFilter, availableOnly }),
    };
  }
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

export function rebuildCanonicalGenreStats() {
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${GENRE_STATS_SETTING_PREFIX}%`);
  genreStatsCache.clear();
  rebuildStoredLibraryGenreStats(db);
}

export function invalidateCanonicalLibraryCache({ persistedGenres = true } = {}) {
  libraryCache.clear();
  genreStatsCache.clear();
  if (persistedGenres) {
    db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${GENRE_STATS_SETTING_PREFIX}%`);
  }
}

export { normalizeSource };
