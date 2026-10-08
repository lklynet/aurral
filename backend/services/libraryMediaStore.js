import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { db, dbHelpers } from "../config/db-sqlite.js";
import {
  invalidateLibraryManagementCache,
  notifyLibraryManagementChanged,
} from "./libraryManagementStore.js";
import { invalidateLibraryQueryCache } from "./libraryQueryService.js";
import { isVariousArtistsCredit } from "./trackMatching/titleText.js";
import { clearLibraryManagement } from "./libraryManagementStore.js";
import {
  removeLibrarySearchDocument,
  syncLibrarySearchAlbum,
  syncLibrarySearchArtist,
  syncLibrarySearchTrack,
} from "./librarySearchIndex.js";

const now = () => Date.now();

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

const getLibraryMediaFileStmt = db.prepare(
  "SELECT * FROM library_media_files WHERE source = ? AND path = ?",
);
const upsertLibraryMediaFileStmt = db.prepare(
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
);

let libraryScanDepth = 0;
let libraryCacheInvalidationPending = false;
const libraryScanContext = new AsyncLocalStorage();

const invalidateLibraryCache = () => {
  const scan = libraryScanContext.getStore();
  if (scan) {
    scan.changed = true;
    libraryCacheInvalidationPending = true;
    return;
  }
  invalidateLibraryQueryCache();
};

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
  db.prepare(
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

function moveLibraryArtistStars(fromKey, toKey) {
  const copied = db.prepare(
    `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
     SELECT user_id, entity_kind, ?, created_at
     FROM subsonic_stars
     WHERE entity_kind = 'artist' AND entity_key = ?`,
  ).run(toKey, fromKey).changes > 0;
  const deleted = db.prepare(
    "DELETE FROM subsonic_stars WHERE entity_kind = 'artist' AND entity_key = ?",
  ).run(fromKey).changes > 0;
  return copied || deleted;
}

function mergeLibraryArtistInto(fallback, resolved, { syncSearch = true } = {}) {
  if (!fallback || !resolved || fallback.id === resolved.id) return false;
  const movedAlbums = syncSearch
    ? db.prepare("SELECT id FROM library_albums WHERE artist_id = ?").all(fallback.id)
    : [];
  let changed = moveLibraryArtistStars(fallback.identity_key, resolved.identity_key);
  changed = db.prepare("UPDATE OR IGNORE library_release_calendar SET artist_id = ? WHERE artist_id = ?")
    .run(resolved.id, fallback.id).changes > 0 || changed;
  changed = db.prepare("UPDATE library_albums SET artist_id = ? WHERE artist_id = ?")
    .run(resolved.id, fallback.id).changes > 0 || changed;
  const copiedManagement = db.prepare(`
    INSERT OR IGNORE INTO library_management
      (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at)
    SELECT entity_kind, ?, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at
    FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?
  `).run(resolved.id, fallback.id).changes > 0;
  const removedManagement = db.prepare(
    "DELETE FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
  ).run(fallback.id).changes > 0;
  if (copiedManagement || removedManagement) invalidateLibraryManagementCache();
  changed = copiedManagement || removedManagement || changed;
  changed = db.prepare("DELETE FROM library_artists WHERE id = ?")
    .run(fallback.id).changes > 0 || changed;
  if (syncSearch) {
    removeLibrarySearchDocument("artist", fallback.id);
    for (const album of movedAlbums) {
      syncLibrarySearchAlbum(album.id);
      for (const track of db.prepare(
        "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
      ).all(album.id)) syncLibrarySearchTrack(track.track_id);
    }
  }
  return changed;
}

export function getUnresolvedLibraryArtists() {
  return db.prepare(
    `SELECT DISTINCT artist.id, artist.name
     FROM library_artists AS artist
     JOIN library_albums AS album ON album.artist_id = artist.id
     JOIN library_media_files AS media ON media.album_id = album.id AND media.available = 1
     WHERE artist.mbid IS NULL
       AND (NOT json_valid(artist.metadata_json)
         OR json_extract(artist.metadata_json, '$.mbidSource') IS NOT 'manual')
     ORDER BY artist.id`,
  ).all();
}

export function assignLibraryArtistMbid(artistId, mbid) {
  const key = buildIdentityKey("mbid", mbid);
  if (!key) return null;
  const artist = db.transaction(() => {
    const fallback = db
      .prepare("SELECT id, identity_key FROM library_artists WHERE id = ? AND mbid IS NULL")
      .get(artistId);
    if (!fallback) return null;
    const resolved = db
      .prepare(
        `SELECT id, identity_key FROM library_artists
         WHERE identity_key = ? OR mbid = ?
         ORDER BY identity_key = ? DESC, id
         LIMIT 1`,
      )
      .get(key, mbid, key);
    if (resolved) {
      mergeLibraryArtistInto(fallback, resolved, { syncSearch: false });
      return resolved;
    }
    moveLibraryArtistStars(fallback.identity_key, key);
    db.prepare("UPDATE library_artists SET identity_key = ?, mbid = ?, updated_at = ? WHERE id = ?")
      .run(key, mbid, now(), fallback.id);
    return fallback;
  })();
  if (artist) invalidateLibraryCache();
  return artist;
}

export function setLibraryArtistMbid(artistId, mbid) {
  const result = db.transaction(() => {
    const artist = db.prepare("SELECT * FROM library_artists WHERE id = ?").get(artistId);
    if (!artist) return { error: "not_found" };
    const metadata = dbHelpers.parseJSON(artist.metadata_json) || {};
    if (metadata.id != null) return { error: "lidarr_managed" };
    const fallbackKey = buildFallbackIdentityKey("artist", artist.name);
    const fallbackTaken = !mbid && db
      .prepare("SELECT 1 FROM library_artists WHERE id != ? AND identity_key = ?")
      .get(artist.id, fallbackKey);
    const key = mbid
      ? buildIdentityKey("mbid", mbid)
      : fallbackTaken ? `${fallbackKey}:${artist.id}` : fallbackKey;
    const target = mbid
      ? db
          .prepare(
            "SELECT * FROM library_artists WHERE id != ? AND (identity_key = ? OR mbid = ?) ORDER BY identity_key = ? DESC, id LIMIT 1",
          )
          .get(artist.id, key, mbid, key)
      : null;
    if (target) {
      const targetMetadata = dbHelpers.parseJSON(target.metadata_json) || {};
      mergeLibraryArtistInto(artist, target);
      db.prepare("UPDATE library_artists SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(stringify({ ...targetMetadata, mbidSource: "manual" }), now(), target.id);
      return {
        artist: db.prepare("SELECT * FROM library_artists WHERE id = ?").get(target.id),
        mergedArtistId: artist.id,
      };
    }
    moveLibraryArtistStars(artist.identity_key, key);
    db.prepare(
      `UPDATE library_artists
       SET identity_key = ?, mbid = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(key, mbid || null, stringify({ ...metadata, mbidSource: "manual" }), now(), artist.id);
    return { artist: db.prepare("SELECT * FROM library_artists WHERE id = ?").get(artist.id) };
  })();
  if (result.artist) {
    syncLibrarySearchArtist(result.artist.id);
    invalidateLibraryCache();
  }
  return result;
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
      libraryChanged = mergeLibraryArtistInto(fallback, resolved, { syncSearch }) || libraryChanged;
    };
    if (mbid) {
      const resolved = db.prepare("SELECT id, identity_key FROM library_artists WHERE identity_key = ?").get(key);
      const fallback = fallbackKey === key
        ? null
        : findFallbackArtist();
      if (fallback && !resolved) {
        libraryChanged = moveLibraryArtistStars(fallback.identity_key, key) || libraryChanged;
        libraryChanged = db.prepare("UPDATE library_artists SET identity_key = ?, updated_at = ? WHERE id = ?")
          .run(key, timestamp, fallback.id).changes > 0 || libraryChanged;
      } else if (fallback && resolved && fallback.id !== resolved.id) {
        mergeFallbackArtist(fallback, resolved);
      }
    } else if (key === fallbackKey) {
      const resolved = findResolvedArtist();
      if (resolved) {
        mergeFallbackArtist(findFallbackArtist(), resolved);
        if (syncSearch) syncLibrarySearchArtist(resolved.id);
        return resolved;
      }
    }
    const existing = db.prepare("SELECT * FROM library_artists WHERE identity_key = ?").get(key);
    const mergedMetadataText = existing && metadata
      ? stringify({ ...dbHelpers.parseJSON(existing.metadata_json), ...metadata })
      : metadataText;
    if (
      existing &&
      (artistMbid == null || artistMbid === existing.mbid) &&
      artistName === existing.name &&
      (artistSortName == null || artistSortName === existing.sort_name) &&
      (mergedMetadataText == null || mergedMetadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchArtist(existing.id);
      return existing;
    }
    db.prepare(
      `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_artists.mbid),
         name = excluded.name,
         sort_name = COALESCE(excluded.sort_name, library_artists.sort_name),
         metadata_json = COALESCE(excluded.metadata_json, library_artists.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(key, artistMbid, artistName, artistSortName, mergedMetadataText, timestamp, timestamp);
    libraryChanged = true;
    const row = db.prepare("SELECT * FROM library_artists WHERE identity_key = ?").get(key);
    if (syncSearch) syncLibrarySearchArtist(row?.id);
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

export function clearLibraryLidarrArtist(reference) {
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

export function clearLibraryLidarrAlbum(reference) {
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
    const existing = db.prepare("SELECT * FROM library_albums WHERE identity_key = ?").get(key);
    const mergedMetadataText = existing && metadata
      ? stringify({ ...dbHelpers.parseJSON(existing.metadata_json), ...metadata })
      : metadataText;
    if (
      existing &&
      (albumMbid == null || albumMbid === existing.mbid) &&
      (albumReleaseGroupMbid == null || albumReleaseGroupMbid === existing.release_group_mbid) &&
      Number(artistId) === existing.artist_id &&
      albumTitle === existing.title &&
      (albumArtistName == null || albumArtistName === existing.album_artist) &&
      (albumReleaseDate == null || albumReleaseDate === existing.release_date) &&
      (mergedMetadataText == null || mergedMetadataText === existing.metadata_json)
    ) {
      const searchChanged = syncSearch && syncLibrarySearchAlbum(existing.id);
      if (searchChanged) {
        for (const track of db.prepare(
          "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
        ).all(existing.id)) {
          syncLibrarySearchTrack(track.track_id);
        }
      }
      return existing;
    }
    db.prepare(
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
      mergedMetadataText,
      timestamp,
      timestamp,
    );
    libraryChanged = true;
    const row = db.prepare("SELECT * FROM library_albums WHERE identity_key = ?").get(key);
    const searchChanged = syncSearch && syncLibrarySearchAlbum(row?.id);
    if (row?.id && searchChanged) {
      for (const track of db.prepare(
        "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
      ).all(row.id)) {
        syncLibrarySearchTrack(track.track_id);
      }
    }
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
  monitored = true,
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
    const existing = db.prepare("SELECT * FROM library_tracks WHERE identity_key = ?").get(key);
    // "Various Artists" credits a compilation, not a performer, so it never
    // replaces a track's own artist.
    const nextArtistName = existing?.artist_name && isVariousArtistsCredit(trackArtistName)
      ? existing.artist_name
      : trackArtistName;
    if (
      existing &&
      (trackMbid == null || trackMbid === existing.mbid) &&
      trackTitle === existing.title &&
      (nextArtistName == null || nextArtistName === existing.artist_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchTrack(existing.id);
      return existing;
    }
    db.prepare(
      `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, monitored, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_tracks.mbid),
         title = excluded.title,
         artist_name = COALESCE(excluded.artist_name, library_tracks.artist_name),
         metadata_json = COALESCE(excluded.metadata_json, library_tracks.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(key, trackMbid, trackTitle, nextArtistName, metadataText, monitored ? 1 : 0, timestamp, timestamp);
    libraryChanged = true;
    const row = db.prepare("SELECT * FROM library_tracks WHERE identity_key = ?").get(key);
    if (syncSearch) syncLibrarySearchTrack(row?.id);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return track;
}

// library_album_tracks has no updated_at and rows are deleted outright, so relation changes ride
// on the album's timestamp to stay visible in getLibraryIndexLastModified.
const touchLibraryAlbum = (albumId) => {
  db.prepare("UPDATE library_albums SET updated_at = ? WHERE id = ?").run(now(), Number(albumId));
};

// A scan passes keepPosition: a file whose tags number it differently from
// the release the album was requested with stays at the track's position.
export function linkLibraryAlbumTrack({
  albumId,
  trackId,
  discNumber = 1,
  trackNumber = 0,
  keepPosition = false,
  syncSearch = true,
}) {
  const changed = db.transaction(() => {
    if (keepPosition && db.prepare(
      "SELECT 1 FROM library_album_tracks WHERE album_id = ? AND track_id = ? LIMIT 1",
    ).get(Number(albumId), Number(trackId))) {
      if (syncSearch) syncLibrarySearchTrack(trackId);
      return false;
    }
    const result = db.prepare(
      `INSERT OR IGNORE INTO library_album_tracks
        (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(Number(albumId), Number(trackId), Number(discNumber) || 1, Number(trackNumber) || 0, now());
    if (result.changes > 0) touchLibraryAlbum(albumId);
    if (syncSearch) syncLibrarySearchTrack(trackId);
    return result.changes > 0;
  })();
  if (changed) invalidateLibraryCache();
}

// A scan stores a file's release ID in its album's mbid. A release ID used
// as a release group names that album, not a new one.
export function findLibraryAlbumByReleaseMbid(mbid) {
  const releaseMbid = normalizeText(mbid);
  if (!releaseMbid) return null;
  return db.prepare(
    `SELECT * FROM library_albums
     WHERE mbid = ? AND release_group_mbid IS NOT NULL AND release_group_mbid != mbid
     ORDER BY id LIMIT 1`,
  ).get(releaseMbid) || null;
}

// Downloads once took an album's release ID for its release group, and the
// scan filed them under a second album keyed by that release ID. Each such
// album folds into the album the release belongs to.
export function mergeReleaseKeyedLibraryAlbums() {
  const pairs = db.prepare(
    `SELECT duplicate.id AS duplicateId, duplicate.identity_key AS duplicateKey,
       album.id AS albumId, album.identity_key AS albumKey
     FROM library_albums AS album
     JOIN library_albums AS duplicate ON duplicate.identity_key = 'release-group:' || album.mbid
     WHERE album.mbid IS NOT NULL AND album.release_group_mbid IS NOT NULL
       AND album.mbid != album.release_group_mbid AND duplicate.id != album.id`,
  ).all();
  if (pairs.length === 0) return 0;
  db.transaction(() => {
    for (const pair of pairs) {
      db.prepare(
        `INSERT OR IGNORE INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
         SELECT ?, link.track_id, link.disc_number, link.track_number, link.created_at
         FROM library_album_tracks AS link
         WHERE link.album_id = ? AND NOT EXISTS (
           SELECT 1 FROM library_album_tracks AS kept WHERE kept.album_id = ? AND kept.track_id = link.track_id
         )`,
      ).run(pair.albumId, pair.duplicateId, pair.albumId);
      db.prepare("UPDATE library_media_files SET album_id = ? WHERE album_id = ?").run(pair.albumId, pair.duplicateId);
      db.prepare(
        `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
         SELECT user_id, entity_kind, ?, created_at FROM subsonic_stars
         WHERE entity_kind = 'album' AND entity_key = ?`,
      ).run(pair.albumKey, pair.duplicateKey);
      db.prepare("DELETE FROM subsonic_stars WHERE entity_kind = 'album' AND entity_key = ?").run(pair.duplicateKey);
      db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(pair.duplicateId);
      clearLibraryManagement("album", pair.duplicateId);
      db.prepare("DELETE FROM library_albums WHERE id = ?").run(pair.duplicateId);
      removeLibrarySearchDocument("album", pair.duplicateId);
      touchLibraryAlbum(pair.albumId);
    }
  })();
  for (const pair of pairs) syncLibrarySearchAlbum(pair.albumId);
  invalidateLibraryCache();
  return pairs.length;
}

export function removeLibraryTrackIfNoAvailableMedia(trackId) {
  const normalizedTrackId = Number(trackId);
  if (!Number.isSafeInteger(normalizedTrackId)) return false;
  const removed = db.transaction(() => {
    const mediaFiles = db.prepare(
      "SELECT album_id, available FROM library_media_files WHERE track_id = ?",
    ).all(normalizedTrackId);
    if (!mediaFiles.length || mediaFiles.some((file) => file.available === 1)) return false;

    const albumIds = new Set([
      ...db.prepare(
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
    db.prepare("DELETE FROM library_media_files WHERE track_id = ?").run(normalizedTrackId);
    db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(normalizedTrackId);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(normalizedTrackId);

    for (const albumId of albumIds) {
      const result = db.prepare(
        `DELETE FROM library_albums
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
      ).run(albumId, albumId);
      if (result.changes > 0) removeLibrarySearchDocument("album", albumId);
      else touchLibraryAlbum(albumId);
    }
    for (const artistId of artistIds) {
      const result = db.prepare(
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

export function removeLibraryArtistIfEmpty(artistId) {
  const normalizedArtistId = Number(artistId);
  if (!Number.isSafeInteger(normalizedArtistId)) return false;
  const removed = db.prepare(
    `DELETE FROM library_artists
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)`,
  ).run(normalizedArtistId, normalizedArtistId).changes > 0;
  if (removed) {
    removeLibrarySearchDocument("artist", normalizedArtistId);
    invalidateLibraryCache();
  }
  return removed;
}

export function removeLibraryAlbumTracksWithoutAvailableMedia(albumId) {
  const normalizedAlbumId = Number(albumId);
  if (!Number.isSafeInteger(normalizedAlbumId)) return { albumRemoved: false };
  const result = db.transaction(() => {
    const trackIds = db.prepare(
      `SELECT link.track_id AS id
       FROM library_album_tracks link
       WHERE link.album_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM library_media_files file
           WHERE file.track_id = link.track_id AND file.available = 1
         )`,
    ).all(normalizedAlbumId).map((row) => row.id);

    for (const trackId of trackIds) {
      db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?")
        .run(normalizedAlbumId, trackId);
      const linkedElsewhere = db.prepare(
        "SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1",
      ).get(trackId);
      if (linkedElsewhere) {
        db.prepare("DELETE FROM library_media_files WHERE track_id = ? AND album_id = ?")
          .run(trackId, normalizedAlbumId);
        continue;
      }
      removeLibrarySearchDocument("track", trackId);
      db.prepare("DELETE FROM library_media_files WHERE track_id = ?").run(trackId);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(trackId);
    }

    const albumRemoved = db.prepare(
      `DELETE FROM library_albums
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
    ).run(normalizedAlbumId, normalizedAlbumId).changes > 0;
    if (albumRemoved) {
      db.prepare("DELETE FROM library_media_files WHERE album_id = ? AND available = 0")
        .run(normalizedAlbumId);
      removeLibrarySearchDocument("album", normalizedAlbumId);
    } else {
      touchLibraryAlbum(normalizedAlbumId);
    }
    return { albumRemoved, changed: albumRemoved || trackIds.length > 0 };
  }).immediate();
  if (result.changed) invalidateLibraryCache();
  return { albumRemoved: result.albumRemoved };
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
  const existing = getLibraryMediaFileStmt.get(fileSource, filePath);
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
  upsertLibraryMediaFileStmt.run(
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
  return getLibraryMediaFileStmt.get(fileSource, filePath);
}

export function getAvailableLibraryMediaPaths(source, scopes = null) {
  const mediaSource = normalizeText(source);
  const paths = new Set();
  if (!Array.isArray(scopes)) {
    for (const row of db.prepare(
      "SELECT path FROM library_media_files WHERE source = ? AND available = 1",
    ).iterate(mediaSource)) paths.add(row.path);
    return paths;
  }
  const readScope = db.prepare(
    `SELECT path FROM library_media_files WHERE source = ? AND available = 1 AND path = ?
     UNION ALL
     SELECT path FROM library_media_files
     WHERE source = ? AND available = 1 AND path >= ? AND path < ?`,
  );
  for (const scope of new Set(scopes.map((scope) => path.resolve(scope)))) {
    const prefix = scope.endsWith(path.sep) ? scope : `${scope}${path.sep}`;
    const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(path.sep.charCodeAt(0) + 1)}`;
    for (const row of readScope.iterate(mediaSource, scope, mediaSource, prefix, upperBound)) {
      paths.add(row.path);
    }
  }
  return paths;
}

export function getLibraryMediaPaths(source) {
  return new Set(
    db.prepare("SELECT path FROM library_media_files WHERE source = ?")
      .all(normalizeText(source))
      .map((row) => row.path),
  );
}

export function markLibraryMediaFilesUnavailable(source, paths) {
  const mediaSource = normalizeText(source);
  const missingPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  if (!mediaSource || missingPaths.length === 0) return 0;
  const update = db.prepare(
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

export function removeLibraryMediaFiles(source, paths) {
  const mediaSource = normalizeText(source);
  const removedPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  let removed = 0;
  for (const filePath of removedPaths) {
    const file = getLibraryMediaFileStmt.get(mediaSource, filePath);
    if (!file) continue;
    const otherFiles = db.prepare(
      "SELECT COUNT(*) AS count FROM library_media_files WHERE track_id = ? AND id != ?",
    ).get(file.track_id, file.id).count;
    if (otherFiles === 0) {
      db.prepare("UPDATE library_media_files SET available = 0 WHERE id = ?").run(file.id);
      removeLibraryTrackIfNoAvailableMedia(file.track_id);
    } else {
      db.prepare("DELETE FROM library_media_files WHERE id = ?").run(file.id);
    }
    removed += 1;
  }
  if (removed > 0) invalidateLibraryCache();
  return removed;
}

export async function withLibraryScan(source, rootPath, run) {
  const parentScan = libraryScanContext.getStore();
  const scan = { changed: false };
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
      libraryScanDepth -= 1;
      if (libraryScanDepth === 0 && libraryCacheInvalidationPending) {
        libraryCacheInvalidationPending = false;
        invalidateLibraryQueryCache();
      }
    }
  });
}

export function getLibraryMediaFile({ source, path }) {
  return getLibraryMediaFileStmt.get(normalizeText(source), normalizeText(path));
}

const AURRAL_REQUESTED_ALBUM = `
  json_valid(album.metadata_json) AND (
    json_extract(album.metadata_json, '$.trackListComplete') = 1
    OR json_extract(album.metadata_json, '$.monitored') = 1
  )
`;

// Lidarr owns an album with files in its root folders unless Aurral was
// asked for that album. This also returns albums that older scans claimed
// for Aurral because one of their tracks was an Aurral download.
export function assignLidarrAlbumOwners() {
  const timestamp = now();
  const changed = db.prepare(
    `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
     SELECT 'album', album.id, 'lidarr', NULL, ?, ?
     FROM library_albums AS album
     WHERE EXISTS (
       SELECT 1 FROM library_media_files AS media
       WHERE media.album_id = album.id AND media.source = 'lidarr' AND media.available = 1
     )
     ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
       managed_by = 'lidarr',
       monitor_mode = NULL,
       updated_at = excluded.updated_at
     WHERE library_management.managed_by = 'aurral'
       AND library_management.monitor_mode IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM library_albums AS album
         WHERE album.id = library_management.entity_id AND ${AURRAL_REQUESTED_ALBUM}
       )`,
  ).run(timestamp, timestamp).changes;
  if (changed > 0) {
    notifyLibraryManagementChanged();
    invalidateLibraryCache();
  }
  return changed;
}

const LIDARR_METADATA_PATHS = [...LIDARR_METADATA_KEYS, "monitorOption"]
  .map((key) => `'$.${key}'`)
  .join(", ");

// Turning Lidarr off removes everything its root folders added. Aurral's own
// files, and the tracks Aurral asked for, stay. What Lidarr managed and still
// has Aurral files becomes Aurral's, unmonitored.
export function hasLidarrLibraryData() {
  return db.prepare(
    `SELECT EXISTS (SELECT 1 FROM library_media_files WHERE source = 'lidarr')
       OR EXISTS (SELECT 1 FROM library_management WHERE managed_by = 'lidarr')
       OR EXISTS (
         SELECT 1 FROM library_artists
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'
       )
       OR EXISTS (
         SELECT 1 FROM library_albums
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'
       ) AS present`,
  ).get().present === 1;
}

export function removeLidarrLibrary() {
  if (!hasLidarrLibraryData()) return false;
  const timestamp = now();
  db.transaction(() => {
    const trackIds = db.prepare(
      "SELECT DISTINCT track_id FROM library_media_files WHERE source = 'lidarr'",
    ).pluck().all();
    db.prepare("DELETE FROM library_media_files WHERE source = 'lidarr'").run();
    const hasMedia = db.prepare("SELECT 1 FROM library_media_files WHERE track_id = ? LIMIT 1");
    const unlinkOutsideAurral = db.prepare(
      `DELETE FROM library_album_tracks
       WHERE track_id = ? AND album_id NOT IN (
         SELECT entity_id FROM library_management
         WHERE entity_kind = 'album' AND managed_by = 'aurral'
       ) AND NOT EXISTS (
         SELECT 1 FROM library_media_files AS media
         WHERE media.track_id = library_album_tracks.track_id
           AND (media.album_id = library_album_tracks.album_id OR media.album_id IS NULL)
       )`,
    );
    const isLinked = db.prepare("SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1");
    const deleteTrack = db.prepare("DELETE FROM library_tracks WHERE id = ?");
    for (const trackId of trackIds) {
      unlinkOutsideAurral.run(trackId);
      if (!hasMedia.get(trackId) && !isLinked.get(trackId)) deleteTrack.run(trackId);
    }
    db.prepare(
      `DELETE FROM library_albums
       WHERE NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = library_albums.id)
         AND id NOT IN (
           SELECT entity_id FROM library_management
           WHERE entity_kind = 'album' AND managed_by = 'aurral'
         )`,
    ).run();
    db.prepare(
      `DELETE FROM library_artists
       WHERE NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = library_artists.id)
         AND id NOT IN (
           SELECT entity_id FROM library_management
           WHERE entity_kind = 'artist' AND managed_by = 'aurral'
         )`,
    ).run();
    db.prepare(
      `DELETE FROM library_management
       WHERE (entity_kind = 'album' AND entity_id NOT IN (SELECT id FROM library_albums))
          OR (entity_kind = 'artist' AND entity_id NOT IN (SELECT id FROM library_artists))`,
    ).run();
    db.prepare(
      `UPDATE library_management
       SET managed_by = 'aurral',
         monitor_mode = CASE entity_kind WHEN 'artist' THEN 'none' ELSE NULL END,
         updated_at = ?
       WHERE managed_by = 'lidarr'`,
    ).run(timestamp);
    for (const table of ["library_artists", "library_albums"]) {
      db.prepare(
        `UPDATE ${table}
         SET metadata_json = json_remove(metadata_json, ${LIDARR_METADATA_PATHS}), updated_at = ?
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'`,
      ).run(timestamp);
    }
    finishLibraryScan(beginLibraryScan({ source: "lidarr-removal" }));
  }).immediate();
  notifyLibraryManagementChanged();
  invalidateLibraryCache();
  return true;
}
