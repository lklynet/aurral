import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "aurral.db");

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

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
    permissions TEXT
  );

  CREATE TABLE IF NOT EXISTS weekly_flow_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    playlist_type TEXT NOT NULL,
    status TEXT NOT NULL,
    staging_path TEXT,
    final_path TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deezer_mbid_cache (
    cache_key TEXT PRIMARY KEY,
    mbid TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artist_overrides (
    mbid TEXT PRIMARY KEY,
    musicbrainz_id TEXT,
    deezer_artist_id TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lidarr_artists (
    id TEXT PRIMARY KEY,
    foreign_artist_id TEXT,
    artist_name TEXT,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lidarr_albums (
    id TEXT PRIMARY KEY,
    artist_id TEXT,
    foreign_album_id TEXT,
    album_name TEXT,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lidarr_tracks (
    id TEXT PRIMARY KEY,
    album_id TEXT,
    artist_id TEXT,
    foreign_track_id TEXT,
    track_name TEXT,
    track_number INTEGER,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lidarr_sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_weekly_flow_jobs_status ON weekly_flow_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_weekly_flow_jobs_playlist_type ON weekly_flow_jobs(playlist_type);
  CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
  CREATE INDEX IF NOT EXISTS idx_lidarr_artists_foreign_id ON lidarr_artists(foreign_artist_id);
  CREATE INDEX IF NOT EXISTS idx_lidarr_artists_name ON lidarr_artists(artist_name);
  CREATE INDEX IF NOT EXISTS idx_lidarr_albums_artist_id ON lidarr_albums(artist_id);
  CREATE INDEX IF NOT EXISTS idx_lidarr_albums_foreign_id ON lidarr_albums(foreign_album_id);
  CREATE INDEX IF NOT EXISTS idx_lidarr_albums_name ON lidarr_albums(album_name);
  CREATE INDEX IF NOT EXISTS idx_lidarr_tracks_album_id ON lidarr_tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_lidarr_tracks_foreign_id ON lidarr_tracks(foreign_track_id);
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
    if (!obj) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

export { db };
