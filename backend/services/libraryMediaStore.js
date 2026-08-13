import { db, dbHelpers } from "../config/db-sqlite.js";

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

export function upsertLibraryArtist({ identityKey, mbid = null, name, sortName = null, metadata = null }) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const artistName = normalizeText(name);
  if (!key || !artistName) throw new Error("Library artist identityKey and name are required");
  db.prepare(
    `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(identity_key) DO UPDATE SET
       mbid = COALESCE(excluded.mbid, library_artists.mbid),
       name = excluded.name,
       sort_name = COALESCE(excluded.sort_name, library_artists.sort_name),
       metadata_json = COALESCE(excluded.metadata_json, library_artists.metadata_json),
       updated_at = excluded.updated_at`,
  ).run(key, mbid || null, artistName, sortName || null, stringify(metadata), timestamp, timestamp);
  return db.prepare("SELECT * FROM library_artists WHERE identity_key = ?").get(key);
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
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const albumTitle = normalizeText(title);
  if (!key || !Number.isSafeInteger(Number(artistId)) || !albumTitle) {
    throw new Error("Library album identityKey, artistId, and title are required");
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
    mbid || null,
    releaseGroupMbid || null,
    Number(artistId),
    albumTitle,
    albumArtist || null,
    releaseDate || null,
    stringify(metadata),
    timestamp,
    timestamp,
  );
  return db.prepare("SELECT * FROM library_albums WHERE identity_key = ?").get(key);
}

export function upsertLibraryTrack({
  identityKey,
  mbid = null,
  title,
  artistName = null,
  metadata = null,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const trackTitle = normalizeText(title);
  if (!key || !trackTitle) throw new Error("Library track identityKey and title are required");
  db.prepare(
    `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(identity_key) DO UPDATE SET
       mbid = COALESCE(excluded.mbid, library_tracks.mbid),
       title = excluded.title,
       artist_name = COALESCE(excluded.artist_name, library_tracks.artist_name),
       metadata_json = COALESCE(excluded.metadata_json, library_tracks.metadata_json),
       updated_at = excluded.updated_at`,
  ).run(key, mbid || null, trackTitle, artistName || null, stringify(metadata), timestamp, timestamp);
  return db.prepare("SELECT * FROM library_tracks WHERE identity_key = ?").get(key);
}

export function linkLibraryAlbumTrack({ albumId, trackId, discNumber = 1, trackNumber = 0 }) {
  db.prepare(
    `INSERT OR IGNORE INTO library_album_tracks
      (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Number(albumId), Number(trackId), Number(discNumber) || 1, Number(trackNumber) || 0, now());
}

export function upsertLibraryMediaFile({
  trackId,
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
  const timestamp = now();
  db.prepare(
    `INSERT INTO library_media_files
      (track_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, last_seen_scan_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       track_id = excluded.track_id,
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
    fileSource,
    filePath,
    format || null,
    Number(size) || 0,
    Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : null,
    Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    stringify(quality),
    available === true ? 1 : 0,
    Number(scanId),
    timestamp,
    timestamp,
  );
}

export function markUnseenFilesUnavailable(scanId, source) {
  db.prepare(
    `UPDATE library_media_files
     SET available = 0, updated_at = ?
     WHERE source = ? AND (last_seen_scan_id IS NULL OR last_seen_scan_id != ?)`,
  ).run(now(), normalizeText(source), Number(scanId));
}

export async function withLibraryScan(source, rootPath, run) {
  const scanId = beginLibraryScan({ source, rootPath });
  try {
    const result = await run(scanId);
    finishLibraryScan(scanId, { ...result, status: "complete" });
    return { scanId, ...result, status: "complete" };
  } catch (error) {
    finishLibraryScan(scanId, { status: "failed", error: error.message });
    throw error;
  }
}

export function getLibrarySnapshot() {
  return {
    artists: db.prepare("SELECT * FROM library_artists ORDER BY name").all(),
    albums: db.prepare("SELECT * FROM library_albums ORDER BY title").all(),
    tracks: db.prepare("SELECT * FROM library_tracks ORDER BY title").all(),
    albumTracks: db.prepare("SELECT * FROM library_album_tracks").all(),
    files: db.prepare("SELECT * FROM library_media_files ORDER BY path").all(),
  };
}
