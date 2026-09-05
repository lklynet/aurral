import { AsyncLocalStorage } from "node:async_hooks";
import { db, dbHelpers } from "../config/db-sqlite.js";
import { invalidateCanonicalLibraryCache } from "./libraryQueryService.js";
import {
  findLibrarySearchDocumentGaps,
  removeLibrarySearchDocument,
  syncLibrarySearchAlbum,
  syncLibrarySearchArtist,
  syncLibrarySearchTrack,
} from "./librarySearchIndex.js";

const now = () => Date.now();

// Static SQL is prepared once per process; the scan write path runs these
// statements hundreds of thousands of times.
const statements = new Map();
const statement = (sql) => {
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
};

const stringify = (value) => dbHelpers.stringifyJSON(value) || null;

const normalizeText = (value) => String(value || "").trim();

const normalizeKeyPart = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const LIDARR_METADATA_KEYS = [
  "librarySource",
  "id",
  "monitored",
  "monitor",
  "monitorNewItems",
  "addOptions",
  "path",
  "qualityProfile",
  "rootFolderPath",
  "statistics",
];

let libraryScanDepth = 0;
let libraryCacheInvalidationPending = false;
const libraryScanContext = new AsyncLocalStorage();
const SEARCH_SYNC_BATCH_SIZE = 500;

const invalidateLibraryCache = () => {
  const scan = libraryScanContext.getStore();
  if (scan) {
    scan.changed = true;
    libraryCacheInvalidationPending = true;
    return;
  }
  invalidateCanonicalLibraryCache();
};

const createSearchSyncSet = () => ({ artist: new Set(), album: new Set(), track: new Set() });

// Scans write rows with `syncSearch: false` and record which entities changed;
// the search documents for those entities are synced in batches when the scan
// ends, instead of rebuilding the whole FTS index. Outside a scan the caller
// opted out of search sync entirely, as before.
const deferSearchSync = (kind, id) => {
  const scan = libraryScanContext.getStore();
  if (scan && Number.isSafeInteger(Number(id))) scan.search[kind].add(Number(id));
};

const syncSearchArtist = (artistId, syncSearch) => {
  if (syncSearch) syncLibrarySearchArtist(artistId);
  else deferSearchSync("artist", artistId);
};

const syncSearchAlbumTracks = (albumId) => {
  for (const track of statement(
    "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
  ).all(Number(albumId))) {
    syncLibrarySearchTrack(track.track_id);
  }
};

const syncSearchAlbum = (albumId, syncSearch) => {
  if (!syncSearch) {
    deferSearchSync("album", albumId);
    return;
  }
  if (syncLibrarySearchAlbum(albumId)) syncSearchAlbumTracks(albumId);
};

const syncSearchTrack = (trackId, syncSearch) => {
  if (syncSearch) syncLibrarySearchTrack(trackId);
  else deferSearchSync("track", trackId);
};

const mergeSearchSyncSets = (target, source) => {
  for (const kind of ["artist", "album", "track"]) {
    for (const id of source[kind]) target[kind].add(id);
  }
};

// Batched search-document sync for the given entity ids; yields to the event
// loop between batches so request handling keeps running.
export async function syncLibrarySearchEntities(search) {
  const batches = [];
  const chunk = (kind, ids, run) => {
    const list = [...ids];
    for (let index = 0; index < list.length; index += SEARCH_SYNC_BATCH_SIZE) {
      batches.push([kind, list.slice(index, index + SEARCH_SYNC_BATCH_SIZE), run]);
    }
  };
  // Artist sync cascades to albums and tracks only when the artist name
  // changed, and album sync cascades to tracks only when the album document
  // changed, so the order artist, album, track avoids re-syncing rows twice.
  chunk("artist", search.artist, (id) => syncLibrarySearchArtist(id));
  chunk("album", search.album, (id) => {
    if (syncLibrarySearchAlbum(id)) syncSearchAlbumTracks(id);
  });
  chunk("track", search.track, (id) => syncLibrarySearchTrack(id));
  let synced = 0;
  for (const [, ids, run] of batches) {
    db.transaction(() => {
      for (const id of ids) run(id);
    })();
    synced += ids.length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return synced;
}

export function buildIdentityKey(prefix, value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return `${prefix}:${normalized}`;
}

export function buildFallbackIdentityKey(...parts) {
  const normalized = parts.map(normalizeKeyPart).filter(Boolean);
  return normalized.length ? `name:${normalized.join(":")}` : null;
}

export function beginLibraryScan({ source, rootPath = null } = {}) {
  const startedAt = now();
  const result = db
    .prepare(
      `INSERT INTO library_scan_runs (source, root_path, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    )
    .run(normalizeText(source), rootPath ? normalizeText(rootPath) : null, startedAt);
  return Number(result.lastInsertRowid);
}

export function finishLibraryScan(scanId, {
  status = "complete",
  error = null,
  filesSeen = 0,
  filesIndexed = 0,
  filesFailed = 0,
} = {}) {
  statement(
    `UPDATE library_scan_runs
     SET status = ?, completed_at = ?, error = ?, files_seen = ?, files_indexed = ?, files_failed = ?
     WHERE id = ?`,
  ).run(
    status,
    now(),
    error ? String(error) : null,
    Number(filesSeen) || 0,
    Number(filesIndexed) || 0,
    Number(filesFailed) || 0,
    scanId,
  );
}

export function upsertLibraryArtist({
  identityKey,
  mbid = null,
  name,
  sortName = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const artistName = normalizeText(name);
  const artistMbid = mbid || null;
  const artistSortName = sortName || null;
  const metadataText = stringify(metadata);
  if (!key || !artistName) throw new Error("Library artist identityKey and name are required");
  let libraryChanged = false;
  const artist = db.transaction(() => {
    const fallbackKey = buildFallbackIdentityKey("artist", artistName);
    const findFallbackArtist = () => {
      return db
        .prepare("SELECT id, identity_key FROM library_artists WHERE identity_key = ? AND mbid IS NULL")
        .get(fallbackKey);
    };
    const findResolvedArtist = () => {
      const exact = db
        .prepare(
          `SELECT * FROM library_artists
           WHERE mbid IS NOT NULL AND name = ? COLLATE NOCASE
           ORDER BY id
           LIMIT 2`,
        )
        .all(artistName);
      if (exact.length === 1) return exact[0];
      // ponytail: normalized duplicate repair scans artist rows; add a persisted normalized name if this becomes hot.
      const matches = db
        .prepare("SELECT * FROM library_artists WHERE mbid IS NOT NULL")
        .all()
        .filter((row) => buildFallbackIdentityKey("artist", row.name) === fallbackKey);
      return matches.length === 1 ? matches[0] : null;
    };
    const mergeFallbackArtist = (fallback, resolved) => {
      if (!fallback || !resolved || fallback.id === resolved.id) return;
      libraryChanged = statement(
        `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
         SELECT user_id, entity_kind, ?, created_at
         FROM subsonic_stars
         WHERE entity_kind = 'artist' AND entity_key = ?`,
      ).run(resolved.identity_key, fallback.identity_key).changes > 0 || libraryChanged;
      libraryChanged = statement(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'artist' AND entity_key = ?",
      ).run(fallback.identity_key).changes > 0 || libraryChanged;
      const movedAlbumIds = statement("SELECT id FROM library_albums WHERE artist_id = ?")
        .all(fallback.id).map((row) => row.id);
      libraryChanged = statement("UPDATE library_albums SET artist_id = ? WHERE artist_id = ?")
        .run(resolved.id, fallback.id).changes > 0 || libraryChanged;
      libraryChanged = statement("DELETE FROM library_artists WHERE id = ?")
        .run(fallback.id).changes > 0 || libraryChanged;
      removeLibrarySearchDocument("artist", fallback.id);
      for (const albumId of movedAlbumIds) syncSearchAlbum(albumId, syncSearch);
    };
    if (mbid) {
      const resolved = statement("SELECT id, identity_key FROM library_artists WHERE identity_key = ?").get(key);
      const fallback = fallbackKey === key
        ? null
        : findFallbackArtist();
      if (fallback && !resolved) {
        libraryChanged = statement(
          `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
           SELECT user_id, entity_kind, ?, created_at
           FROM subsonic_stars
           WHERE entity_kind = 'artist' AND entity_key = ?`,
        ).run(key, fallback.identity_key).changes > 0 || libraryChanged;
        libraryChanged = statement(
          "DELETE FROM subsonic_stars WHERE entity_kind = 'artist' AND entity_key = ?",
        ).run(fallback.identity_key).changes > 0 || libraryChanged;
      }
      if (fallback && !resolved) {
        libraryChanged = statement("UPDATE library_artists SET identity_key = ? WHERE id = ?")
          .run(key, fallback.id).changes > 0 || libraryChanged;
      } else if (fallback && resolved && fallback.id !== resolved.id) {
        mergeFallbackArtist(fallback, resolved);
      }
    } else if (key === fallbackKey) {
      const resolved = findResolvedArtist();
      if (resolved) {
        mergeFallbackArtist(findFallbackArtist(), resolved);
        syncSearchArtist(resolved.id, syncSearch);
        return resolved;
      }
    }
    const existing = statement("SELECT * FROM library_artists WHERE identity_key = ?").get(key);
    if (
      existing &&
      (artistMbid == null || artistMbid === existing.mbid) &&
      artistName === existing.name &&
      (artistSortName == null || artistSortName === existing.sort_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchArtist(existing.id);
      return existing;
    }
    statement(
      `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_artists.mbid),
         name = excluded.name,
         sort_name = COALESCE(excluded.sort_name, library_artists.sort_name),
         metadata_json = COALESCE(excluded.metadata_json, library_artists.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(key, artistMbid, artistName, artistSortName, metadataText, timestamp, timestamp);
    libraryChanged = true;
    const row = statement("SELECT * FROM library_artists WHERE identity_key = ?").get(key);
    syncSearchArtist(row?.id, syncSearch);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return artist;
}

function clearLidarrMetadata(table, where, parameters) {
  const row = db.prepare(`SELECT id, metadata_json FROM ${table} WHERE ${where} LIMIT 1`)
    .get(...parameters);
  if (!row) return false;
  let metadata = {};
  try {
    const parsed = JSON.parse(row.metadata_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  for (const key of LIDARR_METADATA_KEYS) delete metadata[key];
  db.prepare(`UPDATE ${table} SET metadata_json = ?, updated_at = ? WHERE id = ?`)
    .run(stringify(metadata), now(), row.id);
  invalidateLibraryCache();
  return true;
}

export function clearCanonicalLidarrArtist(reference) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_artists",
    `mbid = ? OR identity_key = ? OR (
      json_valid(metadata_json)
      AND CAST(json_extract(metadata_json, '$.foreignArtistId') AS TEXT) = ?
    )`,
    [value, value, value],
  );
}

export function clearCanonicalLidarrAlbum(reference) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_albums",
    `mbid = ? OR release_group_mbid = ? OR identity_key = ? OR (
      json_valid(metadata_json)
      AND CAST(json_extract(metadata_json, '$.id') AS TEXT) = ?
    )`,
    [value, value, value, value],
  );
}

export function upsertLibraryAlbum({
  identityKey,
  mbid = null,
  releaseGroupMbid = null,
  artistId,
  title,
  albumArtist = null,
  releaseDate = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const albumTitle = normalizeText(title);
  const albumMbid = mbid || null;
  const albumReleaseGroupMbid = releaseGroupMbid || null;
  const albumArtistName = albumArtist || null;
  const albumReleaseDate = releaseDate || null;
  const metadataText = stringify(metadata);
  if (!key || !Number.isSafeInteger(Number(artistId)) || !albumTitle) {
    throw new Error("Library album identityKey, artistId, and title are required");
  }
  let libraryChanged = false;
  const album = db.transaction(() => {
    const existing = statement("SELECT * FROM library_albums WHERE identity_key = ?").get(key);
    if (
      existing &&
      (albumMbid == null || albumMbid === existing.mbid) &&
      (albumReleaseGroupMbid == null || albumReleaseGroupMbid === existing.release_group_mbid) &&
      Number(artistId) === existing.artist_id &&
      albumTitle === existing.title &&
      (albumArtistName == null || albumArtistName === existing.album_artist) &&
      (albumReleaseDate == null || albumReleaseDate === existing.release_date) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncSearchAlbum(existing.id, true);
      return existing;
    }
    statement(
      `INSERT INTO library_albums
        (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_albums.mbid),
         release_group_mbid = COALESCE(excluded.release_group_mbid, library_albums.release_group_mbid),
         artist_id = excluded.artist_id,
         title = excluded.title,
         album_artist = COALESCE(excluded.album_artist, library_albums.album_artist),
         release_date = COALESCE(excluded.release_date, library_albums.release_date),
         metadata_json = COALESCE(excluded.metadata_json, library_albums.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(
      key,
      albumMbid,
      albumReleaseGroupMbid,
      Number(artistId),
      albumTitle,
      albumArtistName,
      albumReleaseDate,
      metadataText,
      timestamp,
      timestamp,
    );
    libraryChanged = true;
    const row = statement("SELECT * FROM library_albums WHERE identity_key = ?").get(key);
    if (row?.id) syncSearchAlbum(row.id, syncSearch);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return album;
}

export function upsertLibraryTrack({
  identityKey,
  mbid = null,
  title,
  artistName = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const trackTitle = normalizeText(title);
  const trackMbid = mbid || null;
  const trackArtistName = artistName || null;
  const metadataText = stringify(metadata);
  if (!key || !trackTitle) throw new Error("Library track identityKey and title are required");
  let libraryChanged = false;
  const track = db.transaction(() => {
    const existing = statement("SELECT * FROM library_tracks WHERE identity_key = ?").get(key);
    if (
      existing &&
      (trackMbid == null || trackMbid === existing.mbid) &&
      trackTitle === existing.title &&
      (trackArtistName == null || trackArtistName === existing.artist_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchTrack(existing.id);
      return existing;
    }
    statement(
      `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_tracks.mbid),
         title = excluded.title,
         artist_name = COALESCE(excluded.artist_name, library_tracks.artist_name),
         metadata_json = COALESCE(excluded.metadata_json, library_tracks.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(key, trackMbid, trackTitle, trackArtistName, metadataText, timestamp, timestamp);
    libraryChanged = true;
    const row = statement("SELECT * FROM library_tracks WHERE identity_key = ?").get(key);
    syncSearchTrack(row?.id, syncSearch);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return track;
}

export function linkLibraryAlbumTrack({
  albumId,
  trackId,
  discNumber = 1,
  trackNumber = 0,
  syncSearch = true,
}) {
  const changed = db.transaction(() => {
    const result = statement(
      `INSERT OR IGNORE INTO library_album_tracks
        (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(Number(albumId), Number(trackId), Number(discNumber) || 1, Number(trackNumber) || 0, now());
    if (syncSearch) syncLibrarySearchTrack(trackId);
    else if (result.changes > 0) deferSearchSync("track", trackId);
    return result.changes > 0;
  })();
  if (changed) invalidateLibraryCache();
}

export function removeLibraryTrackIfNoAvailableMedia(trackId) {
  const normalizedTrackId = Number(trackId);
  if (!Number.isSafeInteger(normalizedTrackId)) return false;
  const removed = db.transaction(() => {
    const mediaFiles = statement(
      "SELECT album_id, available FROM library_media_files WHERE track_id = ?",
    ).all(normalizedTrackId);
    if (!mediaFiles.length || mediaFiles.some((file) => file.available === 1)) return false;

    const albumIds = new Set([
      ...statement(
        "SELECT album_id FROM library_album_tracks WHERE track_id = ?",
      ).all(normalizedTrackId).map((row) => row.album_id),
      ...mediaFiles.map((file) => file.album_id).filter((albumId) => albumId != null),
    ]);
    const artistIds = new Set(
      db.prepare(
        `SELECT artist_id
         FROM library_albums
         WHERE id IN (${[...albumIds].map(() => "?").join(",") || "NULL"})`,
      ).all(...albumIds).map((row) => row.artist_id),
    );

    removeLibrarySearchDocument("track", normalizedTrackId);
    statement("DELETE FROM library_media_files WHERE track_id = ?").run(normalizedTrackId);
    statement("DELETE FROM library_album_tracks WHERE track_id = ?").run(normalizedTrackId);
    statement("DELETE FROM library_tracks WHERE id = ?").run(normalizedTrackId);

    for (const albumId of albumIds) {
      const result = statement(
        `DELETE FROM library_albums
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
      ).run(albumId, albumId);
      if (result.changes > 0) removeLibrarySearchDocument("album", albumId);
    }
    for (const artistId of artistIds) {
      const result = statement(
        `DELETE FROM library_artists
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)`,
      ).run(artistId, artistId);
      if (result.changes > 0) removeLibrarySearchDocument("artist", artistId);
    }
    return true;
  })();
  if (removed) invalidateLibraryCache();
  return removed;
}

export function removeLibraryAlbumTracksWithoutMedia(albumId, source, { syncSearch = true } = {}) {
  const mediaSource = normalizeText(source);
  const changed = db.transaction(() => {
    const trackIds = statement(
      "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
    ).all(Number(albumId)).map((row) => row.track_id);
    const result = statement(
      `DELETE FROM library_album_tracks
       WHERE album_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM library_media_files AS media
           WHERE media.track_id = library_album_tracks.track_id
             AND media.album_id = library_album_tracks.album_id
             AND media.source = ?
             AND media.available = 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM library_media_files AS media
           WHERE media.track_id = library_album_tracks.track_id
             AND media.album_id = library_album_tracks.album_id
             AND media.source != ?
             AND media.available = 1
         )`,
    ).run(Number(albumId), mediaSource, mediaSource);
    if (syncSearch || result.changes > 0) {
      for (const trackId of trackIds) syncSearchTrack(trackId, syncSearch);
    }
    return result.changes > 0;
  })();
  if (changed) invalidateLibraryCache();
}

export function upsertLibraryMediaFile({
  trackId,
  albumId = null,
  source,
  path,
  format = null,
  size = 0,
  mtimeMs = null,
  durationMs = null,
  quality = null,
  available = true,
  scanId,
}) {
  const filePath = normalizeText(path);
  const fileSource = normalizeText(source);
  if (!Number.isSafeInteger(Number(trackId)) || !fileSource || !filePath) {
    throw new Error("Library media file trackId, source, and path are required");
  }
  const normalizedAlbumId = Number.isSafeInteger(Number(albumId)) && Number(albumId) > 0
    ? Number(albumId)
    : null;
  const normalizedFormat = format || null;
  const normalizedSize = Number(size) || 0;
  const normalizedMtimeMs = Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : null;
  const normalizedDurationMs = Number.isFinite(Number(durationMs)) ? Number(durationMs) : null;
  const qualityText = stringify(quality);
  const normalizedAvailable = available === true ? 1 : 0;
  const existing = statement(
    "SELECT * FROM library_media_files WHERE source = ? AND path = ?",
  ).get(fileSource, filePath);
  if (
    existing &&
    Number(trackId) === existing.track_id &&
    (normalizedAlbumId == null || normalizedAlbumId === existing.album_id) &&
    normalizedFormat === existing.format &&
    normalizedSize === existing.size &&
    normalizedMtimeMs === existing.mtime_ms &&
    normalizedDurationMs === existing.duration_ms &&
    (qualityText == null || qualityText === existing.quality_json) &&
    normalizedAvailable === existing.available
  ) {
    return existing;
  }
  const timestamp = now();
  statement(
    `INSERT INTO library_media_files
      (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, last_seen_scan_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, path) DO UPDATE SET
       track_id = excluded.track_id,
       album_id = COALESCE(excluded.album_id, library_media_files.album_id),
       source = excluded.source,
       format = excluded.format,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       duration_ms = excluded.duration_ms,
       quality_json = COALESCE(excluded.quality_json, library_media_files.quality_json),
       available = excluded.available,
       last_seen_scan_id = excluded.last_seen_scan_id,
       updated_at = excluded.updated_at`,
  ).run(
    Number(trackId),
    normalizedAlbumId,
    fileSource,
    filePath,
    normalizedFormat,
    normalizedSize,
    normalizedMtimeMs,
    normalizedDurationMs,
    qualityText,
    normalizedAvailable,
    Number(scanId),
    timestamp,
    timestamp,
  );
  invalidateLibraryCache();
  return statement("SELECT * FROM library_media_files WHERE source = ? AND path = ?")
    .get(fileSource, filePath);
}

export function getAvailableLibraryMediaPaths(source) {
  return new Set(
    statement(
      "SELECT path FROM library_media_files WHERE source = ? AND available = 1",
    ).all(normalizeText(source)).map((row) => row.path),
  );
}

// Available media paths for the given canonical artists only, used by scoped
// Lidarr re-indexes so they never mark other artists' files unavailable.
export function getAvailableLibraryMediaPathsForArtists(source, artistIds) {
  const ids = [...new Set((Array.isArray(artistIds) ? artistIds : []).map(Number))]
    .filter((id) => Number.isSafeInteger(id));
  if (!ids.length) return new Set();
  return new Set(
    db.prepare(
      `SELECT DISTINCT media.path
       FROM library_media_files AS media
       JOIN library_albums AS album ON album.id = media.album_id
       WHERE media.source = ? AND media.available = 1
         AND album.artist_id IN (${ids.map(() => "?").join(",")})`,
    ).all(normalizeText(source), ...ids).map((row) => row.path),
  );
}

export function markLibraryMediaFilesUnavailable(source, paths) {
  const mediaSource = normalizeText(source);
  const missingPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  if (!mediaSource || missingPaths.length === 0) return 0;
  const update = statement(
    `UPDATE library_media_files
     SET available = 0, updated_at = ?
     WHERE source = ? AND path = ? AND available = 1`,
  );
  const changed = db.transaction(() => missingPaths.reduce(
    (count, filePath) => count + update.run(now(), mediaSource, filePath).changes,
    0,
  ))();
  if (changed > 0) invalidateLibraryCache();
  return changed;
}

export async function withLibraryScan(source, rootPath, run) {
  const parentScan = libraryScanContext.getStore();
  const scan = { changed: false, search: createSearchSyncSet() };
  return libraryScanContext.run(scan, async () => {
    libraryScanDepth += 1;
    let scanId;
    try {
      scanId = beginLibraryScan({ source, rootPath });
      const result = await run(scanId);
      finishLibraryScan(scanId, { ...result, status: "complete" });
      return { scanId, ...result, changed: scan.changed, status: "complete" };
    } catch (error) {
      if (scanId) finishLibraryScan(scanId, { status: "failed", error: error.message });
      throw error;
    } finally {
      if (scan.changed && parentScan) parentScan.changed = true;
      // Rows written before a failure are committed, so their search documents
      // must be synced on both paths. Nested scans hand off to the parent.
      if (parentScan) mergeSearchSyncSets(parentScan.search, scan.search);
      else await syncLibrarySearchEntities(scan.search);
      libraryScanDepth -= 1;
      if (libraryScanDepth === 0 && libraryCacheInvalidationPending) {
        libraryCacheInvalidationPending = false;
        invalidateCanonicalLibraryCache();
      }
    }
  });
}

// After a scan that failed part-way, reconcile documents with the entity
// tables without rebuilding the whole index.
export async function repairLibrarySearchDocuments() {
  return syncLibrarySearchEntities(findLibrarySearchDocumentGaps());
}

export function getLibrarySnapshot() {
  return {
    artists: statement("SELECT * FROM library_artists ORDER BY name").all(),
    albums: statement("SELECT * FROM library_albums ORDER BY title").all(),
    tracks: statement("SELECT * FROM library_tracks ORDER BY title").all(),
    albumTracks: statement("SELECT * FROM library_album_tracks").all(),
    files: statement("SELECT * FROM library_media_files ORDER BY path").all(),
  };
}

export function getLibraryMediaFile({ source, path }) {
  return db
    .prepare(
      `SELECT *
       FROM library_media_files
       WHERE source = ? AND path = ?
       LIMIT 1`,
    )
    .get(normalizeText(source), normalizeText(path));
}
