import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { initializeSchemaOnStartup } from "./schema-migration-v2.js";
import { syncDownloadFolderPath } from "../services/downloadFolderConfig.js";
import { ensureDataDir } from "./data-dir.js";

const DATA_DIR = ensureDataDir();

const DB_PATH = process.env.AURRAL_DB_PATH
  ? path.resolve(process.env.AURRAL_DB_PATH)
  : path.join(DATA_DIR, "aurral.db");

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -64000");
db.pragma("mmap_size = 268435456");

function tryAddColumn(sql) {
  try {
    db.exec(sql);
  } catch (error) {
    if (
      !String(error?.message || "")
        .toLowerCase()
        .includes("duplicate column name")
    ) {
      throw error;
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discovery_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images_cache (
    mbid TEXT PRIMARY KEY,
    image_url TEXT,
    cache_age INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    permissions TEXT,
    discover_layout TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlist_download_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    reason TEXT,
    artist_mbid TEXT,
    album_mbid TEXT,
    track_mbid TEXT,
    release_year TEXT,
    duration_ms INTEGER,
    track_number INTEGER,
    album_track_count INTEGER,
    album_track_titles TEXT,
    artist_aliases TEXT,
    playlist_id TEXT NOT NULL,
    playlist_type TEXT,
    status TEXT NOT NULL,
    staging_path TEXT,
    final_path TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    download_source TEXT,
    download_client TEXT,
    download_client_id TEXT,
    release_guid TEXT,
    release_title TEXT,
    indexer_id TEXT,
    indexer_name TEXT,
    slskd_search_id TEXT,
    slskd_batch_id TEXT,
    remote_username TEXT,
    remote_filename TEXT,
    denied_remote_sources TEXT,
    quality_tier TEXT,
    quality_format TEXT,
    quality_bitrate_kbps INTEGER,
    quality_sample_rate_hz INTEGER,
    quality_bit_depth INTEGER,
    quality_checked_at INTEGER,
    quality_upgrade_checked_at INTEGER,
    upgrade_for_job_id TEXT
  );

  CREATE TABLE IF NOT EXISTS deezer_mbid_cache (
    cache_key TEXT PRIMARY KEY,
    mbid TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS musicbrainz_artist_mbid_cache (
    artist_name_key TEXT PRIMARY KEY,
    mbid TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artist_overrides (
    mbid TEXT PRIMARY KEY,
    musicbrainz_id TEXT,
    deezer_artist_id TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lidarr_artist_id_map (
    musicbrainz_id TEXT PRIMARY KEY,
    lidarr_foreign_artist_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    name TEXT NOT NULL,
    sort_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    release_group_mbid TEXT,
    artist_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    album_artist TEXT,
    release_date TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (artist_id) REFERENCES library_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    title TEXT NOT NULL,
    artist_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_album_tracks (
    album_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    disc_number INTEGER NOT NULL DEFAULT 1,
    track_number INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, track_id, disc_number, track_number),
    FOREIGN KEY (album_id) REFERENCES library_albums(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    format TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER,
    duration_ms INTEGER,
    quality_json TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    last_seen_scan_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, path),
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    root_path TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    files_seen INTEGER NOT NULL DEFAULT 0,
    files_indexed INTEGER NOT NULL DEFAULT 0,
    files_failed INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_lidarr_artist_id_map_foreign_id
    ON lidarr_artist_id_map (lidarr_foreign_artist_id);
  CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id
    ON library_albums (artist_id);
  CREATE INDEX IF NOT EXISTS idx_library_album_tracks_track_id
    ON library_album_tracks (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id
    ON library_media_files (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available
    ON library_media_files (source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id
    ON library_media_files (last_seen_scan_id);

  CREATE TABLE IF NOT EXISTS aurral_history (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    status TEXT NOT NULL,
    status_label TEXT,
    href TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    href TEXT,
    image_url TEXT,
    metadata TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_saved INTEGER NOT NULL DEFAULT 0,
    is_dismissed INTEGER NOT NULL DEFAULT 0,
    is_added INTEGER NOT NULL DEFAULT 0,
    dismissed_until INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, kind, source_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS slskd_transfer_history (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    username TEXT NOT NULL,
    remote_filename TEXT,
    transfer_id TEXT,
    search_id TEXT,
    batch_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    score REAL,
    artist_name TEXT,
    track_name TEXT,
    album_name TEXT,
    source_path TEXT,
    final_path TEXT,
    actual_duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    cleaned_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS honker_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    queue TEXT NOT NULL,
    name TEXT,
    payload TEXT,
    worker_id TEXT,
    attempt INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    queued_at INTEGER,
    run_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_status ON playlist_download_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_playlist_id ON playlist_download_jobs(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
  CREATE INDEX IF NOT EXISTS idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_aurral_history_created_at ON aurral_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_user_state ON inbox_items(user_id, is_dismissed, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_expiry ON inbox_items(expires_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_started_at ON honker_task_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_queue_started ON honker_task_runs(queue, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_job ON honker_task_runs(job_id, queue);
`);

function hasUniqueIndex(columns) {
  return db.prepare("PRAGMA index_list(library_media_files)").all().some((index) => {
    if (!index.unique) return false;
    const indexName = String(index.name).replaceAll('"', '""');
    const indexColumns = db
      .prepare(`PRAGMA index_info("${indexName}")`)
      .all()
      .map((column) => column.name);
    return JSON.stringify(indexColumns) === JSON.stringify(columns);
  });
}

if (hasUniqueIndex(["path"])) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE library_media_files_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        format TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER,
        duration_ms INTEGER,
        quality_json TEXT,
        available INTEGER NOT NULL DEFAULT 1,
        last_seen_scan_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, path),
        FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
      );

      INSERT INTO library_media_files_v3
        (id, track_id, source, path, format, size, mtime_ms, duration_ms, quality_json,
         available, last_seen_scan_id, created_at, updated_at)
      SELECT id, track_id, source, path, format, size, mtime_ms, duration_ms, quality_json,
        available, last_seen_scan_id, created_at, updated_at
      FROM library_media_files;

      DROP TABLE library_media_files;
      ALTER TABLE library_media_files_v3 RENAME TO library_media_files;
    `);
  })();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id
      ON library_media_files (track_id);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available
      ON library_media_files (source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id
      ON library_media_files (last_seen_scan_id);
  `);
}

const duplicateLidarrArtistIds = db
  .prepare(
    `SELECT lidarr_foreign_artist_id
     FROM lidarr_artist_id_map
     GROUP BY lidarr_foreign_artist_id
     HAVING COUNT(*) > 1`,
  )
  .all();

if (duplicateLidarrArtistIds.length > 0) {
  const deleteDuplicateLidarrArtistId = db.prepare(
    `DELETE FROM lidarr_artist_id_map
     WHERE lidarr_foreign_artist_id = ?
       AND musicbrainz_id NOT IN (
         SELECT musicbrainz_id
         FROM lidarr_artist_id_map
         WHERE lidarr_foreign_artist_id = ?
         ORDER BY updated_at DESC, musicbrainz_id ASC
         LIMIT 1
       )`,
  );
  db.transaction((duplicates) => {
    for (const duplicate of duplicates) {
      deleteDuplicateLidarrArtistId.run(
        duplicate.lidarr_foreign_artist_id,
        duplicate.lidarr_foreign_artist_id,
      );
    }
  })(duplicateLidarrArtistIds);
}

db.exec(`
  DROP INDEX IF EXISTS idx_lidarr_artist_id_map_foreign_id;
  CREATE UNIQUE INDEX idx_lidarr_artist_id_map_foreign_id
    ON lidarr_artist_id_map (lidarr_foreign_artist_id);
`);

const tableColumns = db
  .prepare("PRAGMA table_info(playlist_download_jobs)")
  .all()
  .map((column) => column.name);

if (!tableColumns.includes("album_name")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN album_name TEXT");
}
if (!tableColumns.includes("reason")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN reason TEXT");
}
if (!tableColumns.includes("artist_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN artist_mbid TEXT");
}
if (!tableColumns.includes("album_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN album_mbid TEXT");
}
if (!tableColumns.includes("track_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN track_mbid TEXT");
}
if (!tableColumns.includes("release_year")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN release_year TEXT");
}
if (!tableColumns.includes("duration_ms")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN duration_ms INTEGER");
}
if (!tableColumns.includes("external_path")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN external_path TEXT");
}
if (!tableColumns.includes("denied_remote_sources")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN denied_remote_sources TEXT");
}
for (const [name, type] of [
  ["quality_tier", "TEXT"],
  ["quality_format", "TEXT"],
  ["quality_bitrate_kbps", "INTEGER"],
  ["quality_sample_rate_hz", "INTEGER"],
  ["quality_bit_depth", "INTEGER"],
  ["quality_checked_at", "INTEGER"],
  ["quality_upgrade_checked_at", "INTEGER"],
  ["upgrade_for_job_id", "TEXT"],
]) {
  if (!tableColumns.includes(name)) {
    tryAddColumn(`ALTER TABLE playlist_download_jobs ADD COLUMN ${name} ${type}`);
  }
}

const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map((column) => column.name);

if (!userColumns.includes("lastfm_username")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lastfm_username TEXT");
}
if (!userColumns.includes("listen_history_provider")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_provider TEXT");
}
if (!userColumns.includes("listen_history_username")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_username TEXT");
}
if (!userColumns.includes("lidarr_root_folder_path")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lidarr_root_folder_path TEXT");
}
if (!userColumns.includes("lidarr_quality_profile_id")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lidarr_quality_profile_id INTEGER");
}
if (!userColumns.includes("discover_layout")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN discover_layout TEXT");
}
if (!userColumns.includes("listen_history_url")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_url TEXT");
}

db.exec(`
  UPDATE users
  SET listen_history_username = NULLIF(TRIM(lastfm_username), '')
  WHERE (listen_history_username IS NULL OR TRIM(listen_history_username) = '')
    AND lastfm_username IS NOT NULL
    AND TRIM(lastfm_username) != '';
`);

db.exec(`
  UPDATE users
  SET listen_history_provider = 'lastfm'
  WHERE (listen_history_provider IS NULL OR TRIM(listen_history_provider) = '')
    AND listen_history_username IS NOT NULL
    AND TRIM(listen_history_username) != '';
`);

export const dbHelpers = {
  parseJSON: (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  stringifyJSON: (obj) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

initializeSchemaOnStartup(db, dbHelpers);

const existingDownloadFolder = db
  .prepare("SELECT value FROM settings WHERE key = ?")
  .get("downloadFolderPath");
syncDownloadFolderPath(existingDownloadFolder?.value || null);

export { db };
