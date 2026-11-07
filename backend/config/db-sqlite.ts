import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { SCHEMA_VERSION, missingUpgradeSteps } from "./upgrade-gate.ts";
import { JOB_TABLES_SQL, migrateToJobQueue } from "./job-queue-migration.ts";
import { renamePlaylistPermission } from "./playlist-permission-migration.ts";
import { migrateStaticPlaylistsToLibrary } from "./static-playlist-library-migration.ts";
import { initializeLibrarySearchIndex } from "./library-search-index.ts";
import { initializeLibraryGenreIndex } from "./library-genre-index.ts";
import { ensureUniqueLidarrArtistIdIndex } from "./lidarr-artist-index.ts";
import { syncDownloadFolderPath } from "../services/downloadFolderConfig.ts";
import { databaseOnlyInLegacyDataDir, ensureDataDir, resolveAurralDbPath } from "./data-dir.ts";
import { asAppError } from "../../lib/errors.ts";
import * as v from "valibot";
import { logger } from "../services/logger.ts";
import type { SettingsRow } from "../db/rows.ts";

if (databaseOnlyInLegacyDataDir()) {
  console.error(
    "Aurral's database is in /app/backend/data, but Aurral 3 only reads /config. Mount that folder at /config instead, then start Aurral again.",
  );
  process.exit(1);
}

const DATA_DIR = ensureDataDir();

const DB_PATH = resolveAurralDbPath();

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const missingSteps = missingUpgradeSteps(db);
if (missingSteps.length) {
  console.error(
    [
      "Aurral 3 can't open this database yet. It was last used by an Aurral 2 that didn't finish upgrading it.",
      "Start ghcr.io/lklynet/aurral:2 with this data folder, wait a few minutes for it to finish starting up, then start Aurral 3 again.",
      "Aurral 3 didn't change anything.",
      `Missing: ${missingSteps.join(", ")}`,
    ].join("\n"),
  );
  process.exit(1);
}

for (let attempt = 0; attempt < 5; attempt++) {
  try {
    if (db.pragma("journal_mode", { simple: true }) !== "wal") {
      db.pragma("journal_mode = WAL");
    }
    break;
  } catch (error) {
    const failure = asAppError(error);
    if (!String(failure?.code || "").startsWith("SQLITE_BUSY") || attempt === 4) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
db.pragma("synchronous = NORMAL");
// Worker processes share this file. A deferred transaction that reads before it writes
// fails with SQLITE_BUSY without waiting when another process writes first.
const createTransaction = db.transaction.bind(db);
db.transaction = ((fn) => createTransaction(fn).immediate) as typeof db.transaction;
db.pragma("cache_size = -2000");
db.pragma("mmap_size = 25165824");
db.pragma("temp_store = FILE");

function tryAddColumn(sql: string) {
  try {
    db.exec(sql);
  } catch (error) {
    const failure = asAppError(error);
    if (
      !String(failure?.message || "")
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
`);
db.prepare(
  "INSERT INTO settings (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(String(SCHEMA_VERSION));

migrateToJobQueue(db, DATA_DIR);

db.exec(`

  CREATE TABLE IF NOT EXISTS discovery_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images_cache (
    mbid TEXT PRIMARY KEY,
    image_url TEXT,
    images_json TEXT,
    cache_age INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subsonic_password TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    permissions TEXT,
    discover_layout TEXT,
    lastfm_username TEXT,
    listen_history_provider TEXT,
    listen_history_username TEXT,
    lidarr_root_folder_path TEXT,
    lidarr_quality_profile_id INTEGER,
    listen_history_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    is_protected INTEGER NOT NULL DEFAULT 0,
    role_source TEXT NOT NULL DEFAULT 'local',
    has_local_password INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    reauthenticated_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider_type TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT,
    linked_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lastfm_link_states (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    browser_nonce_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lastfm_link_states_expiry
    ON lastfm_link_states(expires_at);

  CREATE TABLE IF NOT EXISTS share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    album_ref TEXT,
    payload TEXT NOT NULL,
    title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    allow_download INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    manifest TEXT,
    share_files INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_share_links_user
    ON share_links(user_id, created_at);

  CREATE TABLE IF NOT EXISTS share_downloads (
    job_id TEXT PRIMARY KEY,
    share_url TEXT NOT NULL,
    track_path TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES download_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subsonic_play_queues (
    user_id INTEGER PRIMARY KEY,
    song_ids TEXT NOT NULL,
    current_song TEXT,
    position INTEGER,
    changed_at INTEGER NOT NULL,
    changed_by TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subsonic_stars (
    user_id INTEGER NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity_kind, entity_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subsonic_ratings (
    user_id INTEGER NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity_kind, entity_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Unstarring deletes rows, so MAX(subsonic_stars.created_at) can move backwards. This stamp
  -- only ever advances, which is what getIndexes needs to answer ifModifiedSince honestly.
  CREATE TABLE IF NOT EXISTS subsonic_star_changes (
    user_id INTEGER PRIMARY KEY,
    changed_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS play_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    album_key TEXT,
    artist_mbid TEXT,
    album_mbid TEXT,
    track_mbid TEXT,
    duration_ms INTEGER,
    played_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_play_events_user_played_at
    ON play_events(user_id, played_at DESC);

  CREATE INDEX IF NOT EXISTS idx_play_events_user_title
    ON play_events(user_id, title COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS discovery_playlists (
    user_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    built_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audio_loudness (
    path TEXT PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    lufs REAL NOT NULL,
    measured_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY NOT NULL,
    manifest TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 30,
    last_error TEXT,
    disabled TEXT NOT NULL DEFAULT '[]',
    source_url TEXT,
    scheduled_at INTEGER,
    broken_in_a_row INTEGER NOT NULL DEFAULT 0,
    update_manifest TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugin_dev_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS history_servers (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,
    account_id TEXT,
    synced_until INTEGER,
    last_synced_at INTEGER,
    last_error TEXT,
    connected_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS play_album_stats (
    user_id INTEGER NOT NULL,
    album_key TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_play_album_stats_user_ranking
    ON play_album_stats(user_id, play_count DESC, last_played_at DESC);

  CREATE TABLE IF NOT EXISTS spotify_import_artists (
    user_id INTEGER NOT NULL,
    artist TEXT NOT NULL COLLATE NOCASE,
    plays INTEGER NOT NULL,
    score REAL NOT NULL,
    liked_tracks INTEGER NOT NULL,
    followed INTEGER NOT NULL,
    first_played_at INTEGER,
    last_played_at INTEGER,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, artist),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spotify_import_artists_user_score
    ON spotify_import_artists(user_id, score DESC);

  CREATE TABLE IF NOT EXISTS wrapped_reports (
    user_id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL,
    cutoff INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    summary TEXT,
    error TEXT,
    banner_hidden INTEGER NOT NULL DEFAULT 0,
    built_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS download_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    reason TEXT,
    artist_mbid TEXT,
    album_mbid TEXT,
    release_mbid TEXT,
    track_mbid TEXT,
    release_year TEXT,
    duration_ms INTEGER,
    track_number INTEGER,
    disc_number INTEGER,
    album_track_count INTEGER,
    album_track_titles TEXT,
    artist_aliases TEXT,
    owner_id TEXT NOT NULL,
    playlist_generation INTEGER NOT NULL DEFAULT 0,
    owner_type TEXT,
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
    external_path TEXT,
    quality_tier TEXT,
    quality_format TEXT,
    quality_bitrate_kbps INTEGER,
    quality_sample_rate_hz INTEGER,
    quality_bit_depth INTEGER,
    quality_checked_at INTEGER,
    quality_upgrade_checked_at INTEGER,
    upgrade_for_job_id TEXT,
    manual_replacement_search INTEGER NOT NULL DEFAULT 0,
    album_grab_attempted INTEGER NOT NULL DEFAULT 0,
    request_kind TEXT NOT NULL DEFAULT 'track',
    quick_searched_sources TEXT NOT NULL DEFAULT '[]',
    held_for_review TEXT,
    album_grab_failures INTEGER NOT NULL DEFAULT 0,
    managed_by TEXT,
    request_group_id TEXT,
    reused_library_file INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_download_jobs_request_group ON download_jobs(request_group_id);

  CREATE TABLE IF NOT EXISTS download_cancellations (
    owner_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active',
    changed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_job_cancellations (
    job_id TEXT PRIMARY KEY,
    cancelled_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_download_job_cancellations_time
    ON download_job_cancellations(cancelled_at);

  CREATE TABLE IF NOT EXISTS download_provider_work (
    job_id TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, provider, work_id, username)
  );

  CREATE INDEX IF NOT EXISTS idx_download_provider_work_job
    ON download_provider_work(job_id, provider);

  CREATE INDEX IF NOT EXISTS idx_download_provider_work_playlist
    ON download_provider_work(owner_id, provider);

  CREATE TABLE IF NOT EXISTS deezer_mbid_cache (
    cache_key TEXT PRIMARY KEY,
    mbid TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS musicbrainz_artist_mbid_cache (
    artist_name_key TEXT PRIMARY KEY,
    mbid TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metadata_response_cache (
    cache_key TEXT PRIMARY KEY,
    response BLOB NOT NULL,
    fresh_until INTEGER NOT NULL,
    stale_until INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metadata_request_state (
    cache_key TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS library_release_calendar (
    release_group_mbid TEXT NOT NULL,
    artist_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    release_date TEXT NOT NULL,
    release_type TEXT,
    secondary_types_json TEXT,
    release_statuses_json TEXT,
    present INTEGER NOT NULL DEFAULT 1,
    refreshed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (release_group_mbid, artist_id),
    FOREIGN KEY (artist_id) REFERENCES library_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_release_calendar_artists (
    artist_id INTEGER PRIMARY KEY,
    refreshed_at INTEGER,
    failed_at INTEGER,
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
    updated_at INTEGER NOT NULL,
    monitored INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS custom_artwork (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    source_url TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity_kind, entity_id)
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

  CREATE TABLE IF NOT EXISTS library_album_credits (
    album_id INTEGER NOT NULL,
    artist_mbid TEXT NOT NULL,
    PRIMARY KEY (album_id, artist_mbid),
    FOREIGN KEY (album_id) REFERENCES library_albums(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    album_id INTEGER,
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
    artist_tag TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_library_album_credits_artist_mbid
    ON library_album_credits (artist_mbid);
  CREATE INDEX IF NOT EXISTS idx_library_albums_mbid
    ON library_albums (mbid);
  CREATE INDEX IF NOT EXISTS idx_library_albums_release_group_mbid
    ON library_albums (release_group_mbid);
  CREATE INDEX IF NOT EXISTS idx_library_albums_title
    ON library_albums (title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_albums_release_date
    ON library_albums (release_date DESC);
  CREATE INDEX IF NOT EXISTS idx_library_albums_provider_id
    ON library_albums (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_release_calendar_artist
    ON library_release_calendar (artist_id);
  CREATE INDEX IF NOT EXISTS idx_library_release_calendar_date
    ON library_release_calendar (present, release_date DESC);
  CREATE INDEX IF NOT EXISTS idx_library_artists_sort_name_name
    ON library_artists (sort_name COLLATE NOCASE, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_artists_mbid
    ON library_artists (mbid);
  CREATE INDEX IF NOT EXISTS idx_library_artists_provider_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_foreign_artist_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_name
    ON library_artists (name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_album_tracks_track_id
    ON library_album_tracks (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_tracks_title
    ON library_tracks (title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_tracks_mbid
    ON library_tracks (mbid);
  CREATE INDEX IF NOT EXISTS idx_library_tracks_provider_id
    ON library_tracks (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id
    ON library_media_files (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_source_available
    ON library_media_files (track_id, source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available
    ON library_media_files (source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id
    ON library_media_files (last_seen_scan_id);
  CREATE INDEX IF NOT EXISTS idx_library_scan_runs_completed_at
    ON library_scan_runs (completed_at);

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

  CREATE TABLE IF NOT EXISTS news_articles (
    id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    categories TEXT NOT NULL DEFAULT '[]',
    image_url TEXT,
    image_checked INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trending_charts (
    chart TEXT PRIMARY KEY NOT NULL,
    region TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trending_chart_days (
    chart TEXT NOT NULL,
    day TEXT NOT NULL,
    item_keys TEXT NOT NULL,
    PRIMARY KEY (chart, day)
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

  CREATE TABLE IF NOT EXISTS library_file_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    options_json TEXT NOT NULL,
    summary_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS library_file_operation_items (
    operation_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    source_path TEXT NOT NULL,
    target_path TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    details_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (operation_id, position),
    FOREIGN KEY (operation_id) REFERENCES library_file_operations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_library_file_operation_items_status
    ON library_file_operation_items(operation_id, status, position);

  CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_download_jobs_owner_id ON download_jobs(owner_id);
  CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
  CREATE INDEX IF NOT EXISTS idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_metadata_response_cache_stale_until ON metadata_response_cache(stale_until);
  CREATE INDEX IF NOT EXISTS idx_metadata_request_state_retry_after ON metadata_request_state(retry_after);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject ON user_identities(provider_type, provider_key, subject);
  CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_subsonic_stars_user_created
    ON subsonic_stars (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_aurral_history_created_at ON aurral_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_user_state ON inbox_items(user_id, is_dismissed, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_expiry ON inbox_items(expires_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_news_articles_published_at ON news_articles(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
`);
db.exec(JOB_TABLES_SQL);

tryAddColumn("ALTER TABLE play_events ADD COLUMN external_id TEXT");
tryAddColumn("ALTER TABLE plugins ADD COLUMN disabled TEXT NOT NULL DEFAULT '[]'");
tryAddColumn("ALTER TABLE plugins ADD COLUMN source_url TEXT");
tryAddColumn("ALTER TABLE plugins ADD COLUMN scheduled_at INTEGER");
tryAddColumn("ALTER TABLE plugins ADD COLUMN broken_in_a_row INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE plugins ADD COLUMN update_manifest TEXT");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_play_events_external
    ON play_events(user_id, source, external_id) WHERE external_id IS NOT NULL;
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS play_album_stats (
      user_id INTEGER NOT NULL,
      album_key TEXT NOT NULL,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, album_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_play_album_stats_user_ranking
      ON play_album_stats(user_id, play_count DESC, last_played_at DESC);
    CREATE TRIGGER IF NOT EXISTS play_events_album_stats_insert
      AFTER INSERT ON play_events
      WHEN NEW.album_key IS NOT NULL AND TRIM(NEW.album_key) != ''
    BEGIN
      INSERT INTO play_album_stats
        (user_id, album_key, play_count, last_played_at)
      VALUES (NEW.user_id, NEW.album_key, 1, NEW.played_at)
      ON CONFLICT(user_id, album_key) DO UPDATE SET
        play_count = play_album_stats.play_count + 1,
        last_played_at = MAX(play_album_stats.last_played_at, excluded.last_played_at);
    END;
  `);

db.transaction(() => {
  const claimed = db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run("migration:settings-login-v1", "1");
  if (claimed.changes === 0) return;
  db.exec(`
    UPDATE settings
    SET value = json_remove(value, '$.general.authUser', '$.general.authPassword')
    WHERE key = 'integrations' AND json_valid(value)
  `);
})();

const webhookEventsMigrationKey = "migration:webhook-events-per-webhook-v1";
db.transaction(() => {
  const claimed = db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(webhookEventsMigrationKey, "1");
  if (claimed.changes === 0) return;
  const stored = db
    .prepare<[], Pick<SettingsRow, "value">>(
      "SELECT value FROM settings WHERE key = 'integrations' AND json_valid(value)",
    )
    .get();
  const integrations = v.safeParse(
    v.looseObject({
      webhooks: v.optional(v.array(v.looseObject({})), []),
      webhookEvents: v.optional(v.record(v.string(), v.unknown()), {}),
    }),
    stored ? JSON.parse(stored.value) : null,
  );
  if (!integrations.success) return;
  const { webhookEvents, webhooks, ...rest } = integrations.output;
  const events = Object.keys(webhookEvents).filter((event) => webhookEvents[event] === true);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'integrations'").run(
    JSON.stringify({ ...rest, webhooks: webhooks.map((webhook) => ({ ...webhook, events })) }),
  );
}).immediate();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_library_artists_provider_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_foreign_artist_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_name
    ON library_artists (name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_album_source_available
    ON library_media_files (album_id, source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_album_source_available
    ON library_media_files (track_id, album_id, source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_album_source_available_created
    ON library_media_files (track_id, album_id, source, available, created_at DESC);
`);

ensureUniqueLidarrArtistIdIndex(db);

tryAddColumn("ALTER TABLE download_jobs ADD COLUMN started_by_playlist TEXT");

db.transaction(() => {
  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(users)")
    .all()
    .map((column) => column.name);
  for (const column of ["needs_identity_migration", "allow_identity_adoption"]) {
    if (columns.includes(column)) db.exec(`ALTER TABLE users DROP COLUMN ${column}`);
  }
})();
tryAddColumn("ALTER TABLE users ADD COLUMN api_key TEXT");
tryAddColumn("ALTER TABLE users ADD COLUMN api_key_hash TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash)");

db.exec(`
  CREATE TABLE IF NOT EXISTS listen_history_sources (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    PRIMARY KEY (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
export const dbHelpers = {
  parseJSON: (text: string | null | undefined): unknown => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  readJSON<Schema extends v.GenericSchema>(
    schema: Schema,
    text: string | null | undefined,
    source: string,
  ): v.InferOutput<Schema> | null {
    const value: unknown = dbHelpers.parseJSON(text);
    if (value == null) return null;
    const result = v.safeParse(schema, value);
    if (result.success) return result.output;
    logger.warn("database", "Ignored stored data Aurral can't read", {
      source,
      issue: v.summarize(result.issues),
    });
    return null;
  },

  stringifyJSON: (obj: unknown) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS library_management (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_kind TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    managed_by TEXT NOT NULL,
    monitor_mode TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_missing_search_at INTEGER,
    monitor_rules TEXT,
    UNIQUE (entity_kind, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_library_management_entity
    ON library_management (entity_kind, entity_id);
  CREATE INDEX IF NOT EXISTS idx_library_management_managed_by
    ON library_management (managed_by);
`);
db.transaction(() => {
  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(library_tracks)")
    .all()
    .map((column) => column.name);
  if (columns.includes("keep_file")) {
    db.exec(`
      UPDATE library_tracks SET monitored = 0 WHERE keep_file = 1;
      ALTER TABLE library_tracks DROP COLUMN keep_file;
    `);
  }
})();
db.exec(`
  CREATE TABLE IF NOT EXISTS library_monitoring_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    exclusion_key TEXT NOT NULL,
    mbid TEXT,
    artist_mbid TEXT,
    artist_name TEXT,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, exclusion_key)
  );
  CREATE INDEX IF NOT EXISTS idx_library_monitoring_exclusions_artist
    ON library_monitoring_exclusions (artist_mbid);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS download_jobs_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO download_jobs_revision (id, revision) VALUES (1, 0);
  CREATE TRIGGER IF NOT EXISTS download_jobs_revision_insert
    AFTER INSERT ON download_jobs BEGIN
      UPDATE download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
  CREATE TRIGGER IF NOT EXISTS download_jobs_revision_update
    AFTER UPDATE ON download_jobs BEGIN
      UPDATE download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
  CREATE TRIGGER IF NOT EXISTS download_jobs_revision_delete
    AFTER DELETE ON download_jobs BEGIN
      UPDATE download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
`);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS download_attempt_delete
    AFTER DELETE ON download_jobs BEGIN
      DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || OLD.id;
    END;
  CREATE TRIGGER IF NOT EXISTS download_attempt_complete
    AFTER UPDATE OF status ON download_jobs WHEN NEW.status = 'done' BEGIN
      DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || NEW.id;
    END;
  DELETE FROM settings WHERE key LIKE 'activeDownloadAttempt:%'
    AND NOT EXISTS (
      SELECT 1 FROM download_jobs
      WHERE id = substr(settings.key, length('activeDownloadAttempt:') + 1) AND status != 'done'
    );
`);
initializeLibraryGenreIndex(db);
initializeLibrarySearchIndex(db);

// A MusicBrainz "[silence]" place is not a track an album is missing, so
// the ones listed without a file go. Silence files stay.
const silenceTracksMigrationKey = "migration:silence-tracks-v1";
db.transaction(() => {
  const claimed = db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(silenceTracksMigrationKey, "1");
  if (claimed.changes === 0) return;
  const silentTracks = `
    SELECT track.id FROM library_tracks AS track
    WHERE lower(trim(track.title)) = '[silence]'
      AND NOT EXISTS (SELECT 1 FROM library_media_files AS media WHERE media.track_id = track.id)
  `;
  db.prepare(`
    UPDATE library_albums SET updated_at = ?
    WHERE id IN (SELECT album_id FROM library_album_tracks WHERE track_id IN (${silentTracks}))
  `).run(Date.now());
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'library_search_documents'").get()) {
    db.exec(`
      DELETE FROM library_search_documents
      WHERE entity_kind = 'track' AND entity_id IN (${silentTracks})
    `);
  }
  db.exec(`DELETE FROM library_tracks WHERE id IN (${silentTracks})`);
}).immediate();

migrateStaticPlaylistsToLibrary(db);
renamePlaylistPermission(db);

const existingDownloadFolder = db
  .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
  .get("downloadFolderPath");
syncDownloadFolderPath(existingDownloadFolder?.value || null);

const databaseRevisionStmt = db.prepare<[], { data_version: number; changes: number }>(
  "SELECT data_version, total_changes() AS changes FROM pragma_data_version",
);

const dataVersionStmt = db.prepare<[], { data_version: number }>(
  "SELECT data_version FROM pragma_data_version",
);

export function getDatabaseDataVersion() {
  return dataVersionStmt.get()!.data_version;
}

export function getDatabaseRevision() {
  const { data_version, changes } = databaseRevisionStmt.get()!;
  return `${data_version}:${changes}`;
}

export { db };
