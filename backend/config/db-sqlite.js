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
    slskd_search_id TEXT,
    slskd_batch_id TEXT,
    remote_username TEXT,
    remote_filename TEXT
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

  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_status ON playlist_download_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_playlist_id ON playlist_download_jobs(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
  CREATE INDEX IF NOT EXISTS idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_aurral_history_created_at ON aurral_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
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
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN artist_mbid TEXT",
  );
}
if (!tableColumns.includes("album_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN album_mbid TEXT");
}
if (!tableColumns.includes("track_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN track_mbid TEXT");
}
if (!tableColumns.includes("release_year")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN release_year TEXT",
  );
}
if (!tableColumns.includes("duration_ms")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN duration_ms INTEGER",
  );
}
if (!tableColumns.includes("track_number")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN track_number INTEGER",
  );
}
if (!tableColumns.includes("album_track_count")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN album_track_count INTEGER",
  );
}
if (!tableColumns.includes("album_track_titles")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN album_track_titles TEXT",
  );
}
if (!tableColumns.includes("artist_aliases")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN artist_aliases TEXT",
  );
}
if (!tableColumns.includes("playlist_type")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN playlist_type TEXT",
  );
}
if (!tableColumns.includes("external_path")) {
  tryAddColumn(
    "ALTER TABLE playlist_download_jobs ADD COLUMN external_path TEXT",
  );
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
  tryAddColumn(
    "ALTER TABLE users ADD COLUMN lidarr_quality_profile_id INTEGER",
  );
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
