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

export function getCanonicalLibrary({ source = null, availableOnly = false } = {}) {
  const sourceFilter = normalizeSource(source);
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const cached = libraryCache.get(cacheKey);
  if (cached) return cached;
  const conditions = [];
  const parameters = [];

  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");

  const rows = db
    .prepare(
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
        media.available AS media_available
      FROM library_media_files AS media
      JOIN library_tracks AS track ON track.id = media.track_id
      JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
      JOIN library_albums AS album ON album.id = album_track.album_id
      JOIN library_artists AS artist ON artist.id = album.artist_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY artist.sort_name COLLATE NOCASE, artist.name COLLATE NOCASE,
        album.title COLLATE NOCASE, album_track.disc_number, album_track.track_number,
        track.title COLLATE NOCASE, media.path COLLATE NOCASE`,
    )
    .all(...parameters);

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
    if (!track.files.some((entry) => entry.id === file.id)) {
      track.files.push(file);
    }
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

  const library = {
    artists: [...artists.values()],
    albums: [...albums.values()],
    tracks: [...tracks.values()],
  };
  libraryCache.set(cacheKey, library);
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

const hasGenre = (genre, ...entities) => {
  if (!genre) return true;
  const wanted = genre.toLocaleLowerCase();
  return entities.flatMap(metadataGenres).some((value) => value.toLocaleLowerCase() === wanted);
};

const matchesQuery = (entity, query, artist, album) => {
  if (!query) return true;
  return [
    entity?.name,
    entity?.title,
    entity?.artistName,
    entity?.albumArtist,
    artist?.name,
    album?.title,
  ].some((value) => text(value).toLocaleLowerCase().includes(query));
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

  const library = getCanonicalLibrary({ source, availableOnly });
  const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
  const normalizedQuery = text(query).toLocaleLowerCase();
  const normalizedGenre = text(genre);

  let collection = normalizedKind === "genres" ? genreStatsFor(library) : library[normalizedKind];
  if (normalizedKind !== "genres") {
    collection = collection.filter((entity) => {
      const album = normalizedKind === "tracks"
        ? albumsById.get(String(entity.albums?.[0]?.albumId))
        : entity;
      const artist = normalizedKind === "artists"
        ? entity
        : artistsById.get(String(album?.artistId));
      const belongsToArtist = !artistId || (
        normalizedKind === "artists"
          ? String(entity.id) === String(artistId)
          : String(artist?.id) === String(artistId)
      );
      const belongsToAlbum = !albumId || (
        normalizedKind === "albums"
          ? String(entity.id) === String(albumId)
          : entity.albums?.some((entry) => String(entry.albumId) === String(albumId))
      );
      return (
        belongsToArtist &&
        belongsToAlbum &&
        hasGenre(normalizedGenre, artist, album, entity) &&
        matchesQuery(entity, normalizedQuery, artist, album)
      );
    });
  } else if (normalizedQuery) {
    collection = collection.filter((genreEntry) =>
      genreEntry.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }

  collection = [...collection].sort((left, right) => {
    if (normalizedKind === "genres") return left.name.localeCompare(right.name);
    if (sort === "newest" && normalizedKind === "albums") {
      return text(right.releaseDate).localeCompare(text(left.releaseDate));
    }
    if (sort === "artist" && normalizedKind !== "artists") {
      const leftArtist = artistsById.get(String(
        normalizedKind === "tracks"
          ? albumsById.get(String(left.albums?.[0]?.albumId))?.artistId
          : left.artistId,
      ));
      const rightArtist = artistsById.get(String(
        normalizedKind === "tracks"
          ? albumsById.get(String(right.albums?.[0]?.albumId))?.artistId
          : right.artistId,
      ));
      return text(leftArtist?.name).localeCompare(text(rightArtist?.name));
    }
    return text(left.name || left.title).localeCompare(text(right.name || right.title));
  });
  if (direction === "desc") collection.reverse();

  const currentPage = pageNumber(page);
  const currentPageSize = pageSize(requestedPageSize);
  const total = collection.length;
  const withAlbumStats = (album) => {
    const availableTrackCount = album.trackIds.filter((trackId) =>
      library.tracks.find((track) => track.id === trackId)?.available,
    ).length;
    return {
      ...album,
      trackCount: album.trackIds.length,
      availableTrackCount,
    };
  };
  const items = collection.slice(
    (currentPage - 1) * currentPageSize,
    currentPage * currentPageSize,
  ).map((entity) => normalizedKind === "albums" ? withAlbumStats(entity) : entity);

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
    genres: genreStatsFor(library),
  };
}

export function invalidateCanonicalLibraryCache() {
  libraryCache.clear();
}

export { normalizeSource };
