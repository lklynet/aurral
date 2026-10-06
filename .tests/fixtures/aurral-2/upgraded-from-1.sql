PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
CREATE TABLE discovery_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );
CREATE TABLE images_cache (
    mbid TEXT PRIMARY KEY,
    image_url TEXT,
    cache_age INTEGER,
    created_at TEXT NOT NULL
  , images_json TEXT);
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    permissions TEXT,
    discover_layout TEXT
  , lastfm_username TEXT, listen_history_provider TEXT, listen_history_username TEXT, lidarr_root_folder_path TEXT, lidarr_quality_profile_id INTEGER, listen_history_url TEXT, status TEXT NOT NULL DEFAULT 'active', is_protected INTEGER NOT NULL DEFAULT 0, role_source TEXT NOT NULL DEFAULT 'local', has_local_password INTEGER NOT NULL DEFAULT 0, needs_identity_migration INTEGER NOT NULL DEFAULT 0, allow_identity_adoption INTEGER NOT NULL DEFAULT 0, subsonic_password TEXT);
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT, reauthenticated_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE deezer_mbid_cache (
    cache_key TEXT PRIMARY KEY,
    mbid TEXT NOT NULL
  );
CREATE TABLE musicbrainz_artist_mbid_cache (
    artist_name_key TEXT PRIMARY KEY,
    mbid TEXT,
    updated_at INTEGER NOT NULL
  );
CREATE TABLE artist_overrides (
    mbid TEXT PRIMARY KEY,
    musicbrainz_id TEXT,
    deezer_artist_id TEXT,
    updated_at INTEGER
  );
CREATE TABLE user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider_type TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT,
    linked_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE lastfm_link_states (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    browser_nonce_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE subsonic_stars (
    user_id INTEGER NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity_kind, entity_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE subsonic_star_changes (
    user_id INTEGER PRIMARY KEY,
    changed_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE play_events (
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
CREATE TABLE play_album_stats (
    user_id INTEGER NOT NULL,
    album_key TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
CREATE TABLE playlist_download_jobs (
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
    playlist_generation INTEGER NOT NULL DEFAULT 0,
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
    upgrade_for_job_id TEXT,
    manual_replacement_search INTEGER NOT NULL DEFAULT 0,
    album_grab_attempted INTEGER NOT NULL DEFAULT 0
  , external_path TEXT, managed_by TEXT, request_group_id TEXT);
CREATE TABLE weekly_flow_download_cancellations (
    playlist_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active',
    changed_at INTEGER NOT NULL
  );
CREATE TABLE weekly_flow_download_job_cancellations (
    job_id TEXT PRIMARY KEY,
    cancelled_at INTEGER NOT NULL
  );
CREATE TABLE weekly_flow_download_provider_work (
    job_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, provider, work_id, username)
  );
CREATE TABLE lidarr_artist_id_map (
    musicbrainz_id TEXT PRIMARY KEY,
    lidarr_foreign_artist_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE TABLE library_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    name TEXT NOT NULL,
    sort_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE TABLE library_albums (
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
CREATE TABLE library_release_calendar (
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
CREATE TABLE library_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    title TEXT NOT NULL,
    artist_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , monitored INTEGER NOT NULL DEFAULT 1);
CREATE TABLE library_album_tracks (
    album_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    disc_number INTEGER NOT NULL DEFAULT 1,
    track_number INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, track_id, disc_number, track_number),
    FOREIGN KEY (album_id) REFERENCES library_albums(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );
CREATE TABLE library_media_files (
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
    UNIQUE (source, path),
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );
CREATE TABLE library_scan_runs (
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
CREATE TABLE aurral_history (
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
CREATE TABLE inbox_items (
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
CREATE TABLE news_articles (
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
CREATE TABLE slskd_transfer_history (
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
CREATE TABLE honker_task_runs (
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
CREATE TABLE library_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      managed_by TEXT NOT NULL,
      monitor_mode TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_missing_search_at INTEGER,
      UNIQUE (entity_kind, entity_id)
    );
CREATE TABLE playlist_download_jobs_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE library_entity_genres (
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (entity_kind, entity_id, name)
      ) WITHOUT ROWID;
CREATE TABLE metadata_provider_budget (
    base_url TEXT PRIMARY KEY,
    next_request_at INTEGER NOT NULL DEFAULT 0,
    forbidden_until INTEGER NOT NULL DEFAULT 0,
    rate_limited_until INTEGER NOT NULL DEFAULT 0
  );
INSERT INTO "settings" ("key", "value") VALUES ('migration:play-album-stats-v2', '1');
INSERT INTO "settings" ("key", "value") VALUES ('migration:retire-discover-playlists-v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('migration:per-user-discovery-v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('schemaVersion', '4');
INSERT INTO "settings" ("key", "value") VALUES ('migration:aurral-album-monitored-v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('migration:aurral-track-monitoring-v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('migration:aurral-missing-monitor-mode-v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('libraryGenreIndexVersion', '1');
INSERT INTO "settings" ("key", "value") VALUES ('librarySearchIndexVersion', '2');
INSERT INTO "settings" ("key", "value") VALUES ('libraryGenreStats:all:all', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('libraryGenreStats:all:available', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('_encryptionKey', 'nDeNyKqMPV7nFK9gYDZuk5sN6ifEGe9C5VSl/0mCaiA=');
INSERT INTO "settings" ("key", "value") VALUES ('storedDataMigration', '{"version":1,"completedAt":1791047603066}');
INSERT INTO "settings" ("key", "value") VALUES ('integrations', '{"general":{"authUser":"admin","authPassword":"AURRAL_ENC:vmIVI8OKNVv7uSScPuC39E1xUviGcizEz40NuEdRRn3+VFp9Ooa2pDGq1+w="},"lidarr":{"url":"","apiKey":""},"musicbrainz":{},"metadata":{"baseUrl":"https://lidarrapi.brainzmash.cc"},"gotify":{"url":"","token":"","notifyWeeklyFlowDone":true},"soulseek":{"username":"fixture-user","password":"fixture-soulseek-password"},"slskd":{"preferredFormat":"mp3","preferredFormatStrict":false}}');
INSERT INTO "settings" ("key", "value") VALUES ('quality', 'standard');
INSERT INTO "settings" ("key", "value") VALUES ('dateTimeFormat', 'browser');
INSERT INTO "settings" ("key", "value") VALUES ('qualityProfile', '{"order":["mp3-320","mp3-256","mp3-192","mp3-128","flac-hires","flac-standard","m4a-320","m4a-256","m4a-192","m4a-128"],"enabled":["flac-hires","flac-standard","mp3-320","m4a-320","mp3-256","m4a-256","mp3-192","m4a-192","mp3-128","m4a-128"],"cutoff":"mp3-320","automaticUpgrades":false,"intervalDays":2}');
INSERT INTO "settings" ("key", "value") VALUES ('queueCleaner', '{}');
INSERT INTO "settings" ("key", "value") VALUES ('security', '{"localNetworkBypass":{"enabled":false}}');
INSERT INTO "settings" ("key", "value") VALUES ('inbox', '{"enabled":true,"releases":true,"shows":true,"news":true,"recommendedNews":false,"discoveries":true}');
INSERT INTO "settings" ("key", "value") VALUES ('pathMappings', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('releaseTypes', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('flows', '[{"id":"751b1191-d95a-4c0e-8959-9f0507e77a60","name":"Discover","ownerUserId":null,"enabled":true,"recordHistory":true,"showInLibrary":false,"scheduleDays":[],"scheduleTime":"00:00","deepDive":false,"yearFrom":null,"yearTo":null,"nextRunAt":null,"lastRunAt":null,"size":30,"mix":{"discover":34,"mix":33,"trending":33,"focus":0},"tags":["rock"],"relatedArtists":["Old Artist"],"discoverPresetId":null,"type":null,"tag":null,"description":null,"lidarrFeedToken":null,"createdAt":1791047603065},{"id":"5acd1dad-eb85-4497-bec6-9c5aeb158cbd","name":"Mix","ownerUserId":null,"enabled":false,"recordHistory":true,"showInLibrary":false,"scheduleDays":[],"scheduleTime":"00:00","deepDive":false,"yearFrom":null,"yearTo":null,"nextRunAt":null,"lastRunAt":null,"size":20,"mix":{"discover":34,"mix":33,"trending":33,"focus":0},"tags":[],"relatedArtists":[],"discoverPresetId":null,"type":null,"tag":null,"description":null,"lidarrFeedToken":null,"createdAt":1791047603065}]');
INSERT INTO "settings" ("key", "value") VALUES ('sharedPlaylists', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('subsonic', '{"favoriteAutoKeep":true}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistWorker', '{"concurrency":3,"retryCycleMinutes":360,"retryPausedPlaylistIds":[],"existingFileMode":"reuse"}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistArtwork', '{"style":"photo"}');
INSERT INTO "settings" ("key", "value") VALUES ('missingTrackSearch', '{"enabled":false,"intervalDays":1}');
INSERT INTO "settings" ("key", "value") VALUES ('blocklist', '{"artists":[],"tags":[]}');
INSERT INTO "settings" ("key", "value") VALUES ('onboardingComplete', 'true');
INSERT INTO "settings" ("key", "value") VALUES ('aurralDownloadFolderMigration', '{"version":1,"rootPath":"__ROOT__/downloads","status":"complete","items":{"__ROOT__/downloads/aurral-weekly-flow/discover/Old Artist/Old Album/Old Song.mp3":{"status":"complete","destination":"__ROOT__/downloads/_flows/751b1191-d95a-4c0e-8959-9f0507e77a60/Old Artist/Old Album/Old Song.mp3","identity":{"artistName":"Old Artist","albumName":"Old Album","trackName":"Old Song","artistMbid":null,"albumMbid":null,"trackMbid":null},"updatedAt":1791047603129}},"updatedAt":1791047603130,"lastResult":{"scanned":1,"migrated":1,"flowMigrated":1,"removed":0,"retained":0,"failed":0,"failures":[]}}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistStartupMigration', '{"version":1,"rootPath":"__ROOT__/downloads","completedAt":1791047604517}');
INSERT INTO "settings" ("key", "value") VALUES ('identityMarkerMigration', '{"version":1,"completedAt":1791047604518,"checked":0,"moved":0,"failed":0}');
INSERT INTO "settings" ("key", "value") VALUES ('aurral3Readiness', '{"version":1,"ready":true,"checkedAt":1791047604518,"blockers":[]}');
INSERT INTO "images_cache" ("mbid", "image_url", "cache_age", "created_at", "images_json") VALUES ('rg:11111111-1111-4111-8111-111111111111', 'https://ia800000.ca.archive.org/0/items/mbid/front.jpg', 1782864000000, '2026-07-01', NULL);
INSERT INTO "users" ("id", "username", "password_hash", "role", "permissions", "discover_layout", "lastfm_username", "listen_history_provider", "listen_history_username", "lidarr_root_folder_path", "lidarr_quality_profile_id", "listen_history_url", "status", "is_protected", "role_source", "has_local_password", "needs_identity_migration", "allow_identity_adoption", "subsonic_password") VALUES (1, 'listener', 'not-a-real-hash', 'user', '{"accessFlow":true}', NULL, 'listener-lastfm', 'lastfm', 'listener-lastfm', NULL, NULL, NULL, 'active', 0, 'local', 0, 1, 0, NULL);
INSERT INTO "subsonic_star_changes" ("user_id", "changed_at") VALUES (1, 1791047602968);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('v1-done', 'Old Artist', 'Old Song', 'Old Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '751b1191-d95a-4c0e-8959-9f0507e77a60', 0, '751b1191-d95a-4c0e-8959-9f0507e77a60', 'done', NULL, '__ROOT__/downloads/_flows/751b1191-d95a-4c0e-8959-9f0507e77a60/Old Artist/Old Album/Old Song.mp3', NULL, NULL, 1782864001000, 1782864000000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('v1-pending', 'Old Artist', 'Waiting Song', 'Old Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '751b1191-d95a-4c0e-8959-9f0507e77a60', 0, '751b1191-d95a-4c0e-8959-9f0507e77a60', 'pending', NULL, NULL, NULL, NULL, NULL, 1782864002000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs_revision" ("id", "revision") VALUES (1, 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 1);
INSERT INTO sqlite_sequence (name, seq) VALUES ('library_management', 0);
CREATE INDEX idx_images_cache_cache_age ON images_cache(cache_age);
CREATE INDEX idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_lastfm_link_states_expiry
    ON lastfm_link_states(expires_at);
CREATE INDEX idx_play_events_user_played_at
    ON play_events(user_id, played_at DESC);
CREATE INDEX idx_play_album_stats_user_ranking
    ON play_album_stats(user_id, play_count DESC, last_played_at DESC);
CREATE INDEX idx_weekly_flow_download_job_cancellations_time
    ON weekly_flow_download_job_cancellations(cancelled_at);
CREATE INDEX idx_weekly_flow_download_provider_work_job
    ON weekly_flow_download_provider_work(job_id, provider);
CREATE INDEX idx_weekly_flow_download_provider_work_playlist
    ON weekly_flow_download_provider_work(playlist_id, provider);
CREATE INDEX idx_library_albums_artist_id
    ON library_albums (artist_id);
CREATE INDEX idx_library_albums_mbid
    ON library_albums (mbid);
CREATE INDEX idx_library_albums_release_group_mbid
    ON library_albums (release_group_mbid);
CREATE INDEX idx_library_albums_title
    ON library_albums (title COLLATE NOCASE);
CREATE INDEX idx_library_albums_release_date
    ON library_albums (release_date DESC);
CREATE INDEX idx_library_release_calendar_artist
    ON library_release_calendar (artist_id);
CREATE INDEX idx_library_release_calendar_date
    ON library_release_calendar (present, release_date DESC);
CREATE INDEX idx_library_artists_sort_name_name
    ON library_artists (sort_name COLLATE NOCASE, name COLLATE NOCASE);
CREATE INDEX idx_library_artists_mbid
    ON library_artists (mbid);
CREATE INDEX idx_library_artists_provider_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
CREATE INDEX idx_library_artists_foreign_artist_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
CREATE INDEX idx_library_artists_name
    ON library_artists (name COLLATE NOCASE);
CREATE INDEX idx_library_album_tracks_track_id
    ON library_album_tracks (track_id);
CREATE INDEX idx_library_tracks_title
    ON library_tracks (title COLLATE NOCASE);
CREATE INDEX idx_library_tracks_mbid
    ON library_tracks (mbid);
CREATE INDEX idx_library_media_files_track_id
    ON library_media_files (track_id);
CREATE INDEX idx_library_media_files_track_source_available
    ON library_media_files (track_id, source, available);
CREATE INDEX idx_library_media_files_source_available
    ON library_media_files (source, available);
CREATE INDEX idx_library_media_files_scan_id
    ON library_media_files (last_seen_scan_id);
CREATE INDEX idx_playlist_download_jobs_status ON playlist_download_jobs(status);
CREATE INDEX idx_playlist_download_jobs_playlist_id ON playlist_download_jobs(playlist_id);
CREATE UNIQUE INDEX idx_user_identities_provider_subject ON user_identities(provider_type, provider_key, subject);
CREATE INDEX idx_user_identities_user_id ON user_identities(user_id);
CREATE INDEX idx_subsonic_stars_user_created
    ON subsonic_stars (user_id, created_at);
CREATE INDEX idx_aurral_history_created_at ON aurral_history(created_at DESC);
CREATE INDEX idx_inbox_items_user_state ON inbox_items(user_id, is_dismissed, is_read, created_at DESC);
CREATE INDEX idx_inbox_items_expiry ON inbox_items(expires_at, created_at DESC);
CREATE INDEX idx_news_articles_published_at ON news_articles(published_at DESC);
CREATE INDEX idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
CREATE INDEX idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
CREATE INDEX idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
CREATE INDEX idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
CREATE INDEX idx_honker_task_runs_started_at ON honker_task_runs(started_at DESC);
CREATE INDEX idx_honker_task_runs_queue_started ON honker_task_runs(queue, started_at DESC);
CREATE INDEX idx_honker_task_runs_job ON honker_task_runs(job_id, queue);
CREATE TRIGGER play_events_album_stats_insert
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
CREATE INDEX idx_library_media_files_album_source_available
    ON library_media_files (album_id, source, available);
CREATE INDEX idx_library_media_files_track_album_source_available
    ON library_media_files (track_id, album_id, source, available);
CREATE INDEX idx_library_media_files_track_album_source_available_created
    ON library_media_files (track_id, album_id, source, available, created_at DESC);
CREATE UNIQUE INDEX idx_lidarr_artist_id_map_foreign_id
        ON lidarr_artist_id_map (lidarr_foreign_artist_id);
CREATE INDEX idx_library_management_entity
      ON library_management (entity_kind, entity_id);
CREATE INDEX idx_library_management_managed_by
      ON library_management (managed_by);
CREATE INDEX idx_playlist_download_jobs_request_group ON playlist_download_jobs(request_group_id);
CREATE TRIGGER playlist_download_jobs_revision_insert
    AFTER INSERT ON playlist_download_jobs BEGIN
      UPDATE playlist_download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
CREATE TRIGGER playlist_download_jobs_revision_update
    AFTER UPDATE ON playlist_download_jobs BEGIN
      UPDATE playlist_download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
CREATE TRIGGER playlist_download_jobs_revision_delete
    AFTER DELETE ON playlist_download_jobs BEGIN
      UPDATE playlist_download_jobs_revision SET revision = revision + 1 WHERE id = 1;
    END;
CREATE TRIGGER playlist_download_attempt_delete
    AFTER DELETE ON playlist_download_jobs BEGIN
      DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || OLD.id;
    END;
CREATE TRIGGER playlist_download_attempt_complete
    AFTER UPDATE OF status ON playlist_download_jobs WHEN NEW.status = 'done' BEGIN
      DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || NEW.id;
    END;
CREATE INDEX idx_library_genres_name
        ON library_entity_genres (lower(name), entity_kind, entity_id);
CREATE TRIGGER library_genres_artists_insert
        AFTER INSERT ON library_artists BEGIN INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> ''; END;
CREATE TRIGGER library_genres_artists_update
        AFTER UPDATE OF metadata_json ON library_artists
        WHEN OLD.metadata_json IS NOT NEW.metadata_json BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'artists' AND entity_id = OLD.id;
          INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'artists', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '';
        END;
CREATE TRIGGER library_genres_artists_delete
        AFTER DELETE ON library_artists BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'artists' AND entity_id = OLD.id;
        END;
CREATE TRIGGER library_genres_albums_insert
        AFTER INSERT ON library_albums BEGIN INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> ''; END;
CREATE TRIGGER library_genres_albums_update
        AFTER UPDATE OF metadata_json ON library_albums
        WHEN OLD.metadata_json IS NOT NEW.metadata_json BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'albums' AND entity_id = OLD.id;
          INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'albums', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '';
        END;
CREATE TRIGGER library_genres_albums_delete
        AFTER DELETE ON library_albums BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'albums' AND entity_id = OLD.id;
        END;
CREATE TRIGGER library_genres_tracks_insert
        AFTER INSERT ON library_tracks BEGIN INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> ''; END;
CREATE TRIGGER library_genres_tracks_update
        AFTER UPDATE OF metadata_json ON library_tracks
        WHEN OLD.metadata_json IS NOT NEW.metadata_json BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'tracks' AND entity_id = OLD.id;
          INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, name)
        SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genres') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.common.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '' UNION ALL SELECT 'tracks', NEW.id, TRIM(CAST(genre_value.value AS TEXT))
     FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.tags.genre') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> '';
        END;
CREATE TRIGGER library_genres_tracks_delete
        AFTER DELETE ON library_tracks BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = 'tracks' AND entity_id = OLD.id;
        END;
COMMIT;
