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
    images_json TEXT,
    cache_age INTEGER,
    created_at TEXT NOT NULL
  );
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subsonic_password TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    permissions TEXT,
    discover_layout TEXT
  , lastfm_username TEXT, listen_history_provider TEXT, listen_history_username TEXT, lidarr_root_folder_path TEXT, lidarr_quality_profile_id INTEGER, listen_history_url TEXT, status TEXT NOT NULL DEFAULT 'active', is_protected INTEGER NOT NULL DEFAULT 0, role_source TEXT NOT NULL DEFAULT 'local', has_local_password INTEGER NOT NULL DEFAULT 0, needs_identity_migration INTEGER NOT NULL DEFAULT 0, allow_identity_adoption INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
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
CREATE TABLE _honker_notifications (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           channel TEXT NOT NULL,
           payload TEXT NOT NULL,
           created_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
CREATE TABLE _honker_live (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL DEFAULT (unixepoch()),
      worker_id TEXT,
      claim_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER
    );
CREATE TABLE _honker_dead (
      id INTEGER PRIMARY KEY,
      queue TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      died_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
CREATE TABLE _honker_locks (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
CREATE TABLE _honker_rate_limits (
      name TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, window_start)
    );
CREATE TABLE _honker_scheduler_tasks (
      name TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      expires_s INTEGER,
      next_fire_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 3
    );
CREATE TABLE _honker_results (
      job_id INTEGER PRIMARY KEY,
      value TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER
    );
CREATE TABLE _honker_stream (
      offset INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      key TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
CREATE TABLE _honker_stream_consumers (
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, topic)
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
INSERT INTO "settings" ("key", "value") VALUES ('_encryptionKey', '2PO/FlhCdp21IpGmcpfBQaXBLdwiuoI70b734HPECCQ=');
INSERT INTO "settings" ("key", "value") VALUES ('weeklyFlowOperationTokens:flow%3A2c860b40-aa75-46bc-90e1-a02c8af0bb7d', '"fixture-flow-token"');
INSERT INTO "settings" ("key", "value") VALUES ('integrations', '{"gotify":{"url":"https://gotify.example.invalid","token":"AURRAL_ENC:qYs90qKE36+gnDZRqU+p5YkdBpRgJz/Q0Ngt5ZGVmWJffDJgkq/LkDw=","notifyWeeklyFlowDone":true},"webhooks":[{"id":"hook-1","name":"Flow hook","url":"https://hooks.example.invalid/flow","enabled":true}],"webhookEvents":{"notifyWeeklyFlowDone":true,"notifyRequestMade":true}}');
INSERT INTO "settings" ("key", "value") VALUES ('quality', 'standard');
INSERT INTO "settings" ("key", "value") VALUES ('dateTimeFormat', 'browser');
INSERT INTO "settings" ("key", "value") VALUES ('qualityProfile', '{"order":["flac-hires","flac-standard","mp3-320","m4a-320","mp3-256","m4a-256","mp3-192","m4a-192","mp3-128","m4a-128"],"enabled":["flac-hires","flac-standard","mp3-320","m4a-320","mp3-256","m4a-256","mp3-192","m4a-192","mp3-128","m4a-128"],"cutoff":"flac-standard","automaticUpgrades":false,"intervalDays":2}');
INSERT INTO "settings" ("key", "value") VALUES ('queueCleaner', '{}');
INSERT INTO "settings" ("key", "value") VALUES ('security', '{"localNetworkBypass":{"enabled":false}}');
INSERT INTO "settings" ("key", "value") VALUES ('inbox', '{"enabled":true,"releases":true,"shows":true,"news":true,"recommendedNews":false,"discoveries":true}');
INSERT INTO "settings" ("key", "value") VALUES ('downloadFolderPath', '__ROOT__/downloads');
INSERT INTO "settings" ("key", "value") VALUES ('pathMappings', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('releaseTypes', '[]');
INSERT INTO "settings" ("key", "value") VALUES ('flows', '[{"id":"2c860b40-aa75-46bc-90e1-a02c8af0bb7d","name":"Weekly Mix","ownerUserId":1,"enabled":false,"recordHistory":true,"showInLibrary":false,"scheduleDays":[],"scheduleTime":"00:00","deepDive":false,"yearFrom":null,"yearTo":null,"nextRunAt":null,"lastRunAt":null,"size":10,"mix":{"discover":34,"mix":33,"trending":33,"focus":0},"tags":[],"relatedArtists":[],"discoverPresetId":null,"type":null,"tag":null,"description":null,"lidarrFeedToken":null,"createdAt":1791046686872}]');
INSERT INTO "settings" ("key", "value") VALUES ('sharedPlaylists', '[{"id":"c9f40977-9e07-40f8-abd4-91f9c749bb4e","name":"Imported","ownerUserId":1,"sourceName":null,"sourceFlowId":null,"discoverPresetId":null,"type":null,"description":null,"importSource":{"provider":"spotify-playlist","externalId":"spotify-playlist","externalName":"Imported","syncEnabled":true,"syncIntervalHours":24,"keepRemovedTracks":false,"lastSyncAt":null,"lastSyncError":null,"lastSyncTrackCount":null},"recordHistory":true,"showTrackAvailability":false,"importedAt":1791046686874,"createdAt":1791046686874,"tracks":[{"artistName":"Imp Artist","trackName":"Downloaded","albumName":"Imp Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"membershipId":"9408889a-dc85-473f-8df5-ce807d1f53b7"},{"artistName":"Imp Artist","trackName":"Queued","albumName":"Imp Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"membershipId":"d2713964-5a64-4374-8eb2-a91ab76c513d"},{"artistName":"Imp Artist","trackName":"Failed","albumName":"Imp Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"membershipId":"4894624f-37b6-4883-9a1d-43a857332357"},{"artistName":"Lib Artist","trackName":"Library Done","albumName":"Lib Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"membershipId":"ede69dc5-8913-4a7a-8bd4-997f67ded080"}],"trackCount":4},{"id":"3c44852e-cd9a-4dc6-85e8-cbe946238d99","name":"Copied","ownerUserId":2,"sourceName":null,"sourceFlowId":null,"discoverPresetId":null,"type":null,"description":null,"importSource":null,"recordHistory":true,"showTrackAvailability":false,"importedAt":1791046686879,"createdAt":1791046686879,"tracks":[{"artistName":"Imp Artist","trackName":"Downloaded","albumName":"Imp Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"canonicalJobId":"c60f8d96-9275-4286-b77c-c7d28efa1520","membershipId":"6f1b6e91-0920-41b7-8fae-3e3d2e74934a"},{"artistName":"Lib Artist","trackName":"Library Done","albumName":"Lib Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"canonicalJobId":"9cfd2592-c729-4e4b-b010-91913e649c9f","membershipId":"5d5351c6-8a68-4ad9-bbcb-7aa001bf37e7"},{"artistName":"Sub Artist","trackName":"Subsonic Pending","albumName":"Sub Album","artistMbid":null,"albumMbid":null,"trackMbid":null,"releaseYear":null,"durationMs":null,"artistAliases":[],"reason":null,"canonicalJobId":"3904f356-ef91-44c4-ba23-6d9c4c1f732f","membershipId":"88b3a727-9ab8-4c72-9eb6-c27f69e9c14c"}],"trackCount":3}]');
INSERT INTO "settings" ("key", "value") VALUES ('subsonic', '{"favoriteAutoKeep":true}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistWorker', '{"concurrency":2,"retryCycleMinutes":360,"retryPausedPlaylistIds":[],"existingFileMode":"reuse"}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistArtwork', '{"style":"photo"}');
INSERT INTO "settings" ("key", "value") VALUES ('missingTrackSearch', '{"enabled":false,"intervalDays":1}');
INSERT INTO "settings" ("key", "value") VALUES ('blocklist', '{"artists":[],"tags":[]}');
INSERT INTO "settings" ("key", "value") VALUES ('onboardingComplete', 'true');
INSERT INTO "settings" ("key", "value") VALUES ('storedDataMigration', '{"version":1,"completedAt":1791046687052}');
INSERT INTO "settings" ("key", "value") VALUES ('aurralDownloadFolderMigration', '{"version":1,"rootPath":"__ROOT__/downloads","status":"complete","items":{},"updatedAt":1791046687060,"lastResult":{"scanned":0,"migrated":0,"flowMigrated":0,"removed":0,"retained":0,"failed":0,"failures":[]}}');
INSERT INTO "settings" ("key", "value") VALUES ('playlistStartupMigration', '{"version":1,"rootPath":"__ROOT__/downloads","completedAt":1791046687061}');
INSERT INTO "settings" ("key", "value") VALUES ('identityMarkerMigration', '{"version":1,"completedAt":1791046687069,"checked":0,"moved":0,"failed":3}');
INSERT INTO "settings" ("key", "value") VALUES ('aurral3Readiness', '{"version":1,"ready":true,"checkedAt":1791046687069,"blockers":[]}');
INSERT INTO "images_cache" ("mbid", "image_url", "images_json", "cache_age", "created_at") VALUES ('rg:22222222-2222-4222-8222-222222222222', 'https://archive.org/download/mbid-x/front.jpg', NULL, 1791046686893, '2026-10-03T16:58:06.893Z');
INSERT INTO "images_cache" ("mbid", "image_url", "images_json", "cache_age", "created_at") VALUES ('rg:33333333-3333-4333-8333-333333333333', 'https://images.example.invalid/kept.jpg', NULL, 1791046686894, '2026-10-03T16:58:06.894Z');
INSERT INTO "users" ("id", "username", "password_hash", "subsonic_password", "role", "permissions", "discover_layout", "lastfm_username", "listen_history_provider", "listen_history_username", "lidarr_root_folder_path", "lidarr_quality_profile_id", "listen_history_url", "status", "is_protected", "role_source", "has_local_password", "needs_identity_migration", "allow_identity_adoption") VALUES (1, 'admin', 'scrypt$b8bb4707ed1156dba276ee07fdbaf2d5$94896234a60f926e04a9968493a523faf42212fe2bf9606587b5a3935d2173927143860a9e9082b97a5cadec233a8103b7680d6c1ccb54457b380dc19c843733', NULL, 'admin', '{"accessFlow":false,"addArtist":true,"addAlbum":true,"changeMonitoring":false,"deleteArtist":false,"deleteAlbum":false,"deleteTrack":false}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 0, 'local', 1, 0, 0);
INSERT INTO "users" ("id", "username", "password_hash", "subsonic_password", "role", "permissions", "discover_layout", "lastfm_username", "listen_history_provider", "listen_history_username", "lidarr_root_folder_path", "lidarr_quality_profile_id", "listen_history_url", "status", "is_protected", "role_source", "has_local_password", "needs_identity_migration", "allow_identity_adoption") VALUES (2, 'olduser', 'scrypt$7f839b70d75e88f123ddd69fefe2702a$6e57de848dd7dc1072aca6e3bcaffd52aebd6a0fafb21847f23d9b54bc612696fe4abb6efc3d6ddbb85fef60b1a6642508af8449b3ced12eb8e4b589115620f8', NULL, 'user', '{"accessFlow":false,"addArtist":true,"addAlbum":true,"changeMonitoring":false,"deleteArtist":false,"deleteAlbum":false,"deleteTrack":false}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 0, 'local', 1, 1, 1);
INSERT INTO "users" ("id", "username", "password_hash", "subsonic_password", "role", "permissions", "discover_layout", "lastfm_username", "listen_history_provider", "listen_history_username", "lidarr_root_folder_path", "lidarr_quality_profile_id", "listen_history_url", "status", "is_protected", "role_source", "has_local_password", "needs_identity_migration", "allow_identity_adoption") VALUES (3, 'ssouser', 'scrypt$44753c946c91bafa5b0d5ee5b4c2136b$2d8a3e4180846ab571b4a8def874f91712247ed7ce2b37c2b4074dac62735727f05554ecd9937123249e647ec758c83bfcc53ef25ab258a2429d8d8604db52a6', NULL, 'user', '{"accessFlow":false,"addArtist":true,"addAlbum":true,"changeMonitoring":false,"deleteArtist":false,"deleteAlbum":false,"deleteTrack":false}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 0, 'local', 0, 0, 0);
INSERT INTO "user_identities" ("id", "user_id", "provider_type", "provider_key", "subject", "display_name", "linked_at") VALUES (1, 3, 'oidc', 'https://issuer.example.invalid', 'subject-1', 'SSO User', 1780000000000);
INSERT INTO "subsonic_star_changes" ("user_id", "changed_at") VALUES (1, 1791046686958);
INSERT INTO "subsonic_star_changes" ("user_id", "changed_at") VALUES (2, 1791046686958);
INSERT INTO "subsonic_star_changes" ("user_id", "changed_at") VALUES (3, 1791046686958);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('b9f4d21e-ec84-45f1-b99b-75f4cac1993c', 'Flow Artist', 'Flow Done', 'Flow Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2c860b40-aa75-46bc-90e1-a02c8af0bb7d', 0, '2c860b40-aa75-46bc-90e1-a02c8af0bb7d', 'done', NULL, '__ROOT__/downloads/_flows/2c860b40-aa75-46bc-90e1-a02c8af0bb7d/Flow Artist/Flow Album/Flow Done.mp3', NULL, NULL, 1791046686874, 1791046686873, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('fd0633d5-aaa2-4218-8b54-bea60098a07d', 'Flow Artist', 'Flow Pending', 'Flow Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2c860b40-aa75-46bc-90e1-a02c8af0bb7d', 0, '2c860b40-aa75-46bc-90e1-a02c8af0bb7d', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046686874, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('9cfd2592-c729-4e4b-b010-91913e649c9f', 'Lib Artist', 'Library Done', 'Lib Album', 'Track request', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'library', 0, 'library', 'done', NULL, '__ROOT__/downloads/Lib Artist/Lib Album/Library Done.flac', NULL, NULL, 1791046686874, 1791046686874, 'ytdlp', 'ytdlp', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('579de165-6c8b-4638-b87c-e94cae38950e', 'Album Artist', 'Album Track', 'Requested Album', 'Aurral album request', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'library', 0, 'library', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046686874, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', 'album-request-1');
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('c60f8d96-9275-4286-b77c-c7d28efa1520', 'Imp Artist', 'Downloaded', 'Imp Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'done', NULL, '__ROOT__/downloads/Imp Artist/Imp Album/Downloaded.flac', NULL, NULL, 1791046686875, 1791046686875, 'slskd', 'slskd', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'mp3-192', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('329c7666-4624-4dfc-8080-54aa87ec3fb2', 'Imp Artist', 'Queued', 'Imp Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046686875, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('745960e3-6906-4b86-8b55-85e233c2cea8', 'Imp Artist', 'Failed', 'Imp Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'failed', NULL, NULL, 'No source found', NULL, 1791046686875, 1791046686875, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('b0299dee-9fb8-4307-b7e5-be983ea7cb9d', 'Lib Artist', 'Library Done', 'Lib Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'done', NULL, '__ROOT__/downloads/Lib Artist/Lib Album/Library Done.flac', NULL, NULL, 1791046686876, 1791046686875, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('94013701-cd5f-44e9-a19b-b1132440a62c', 'Extra Artist', 'Only In Jobs', 'Extra Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'done', NULL, '__ROOT__/downloads/Extra Artist/Extra Album/Only In Jobs.flac', NULL, NULL, 1791046686876, 1791046686876, 'deemix', 'deemix', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('3904f356-ef91-44c4-ba23-6d9c4c1f732f', 'Sub Artist', 'Subsonic Pending', 'Sub Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'library', 0, 'library', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046686880, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('77bcd57c-0bde-4ce9-8c1d-9b0a2bf1b89f', 'Gone Artist', 'Gone Pending', 'Gone Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'deleted-playlist', 0, 'deleted-playlist', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046686891, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('c2278271-c87d-45b9-9aba-70d29a5847c3', 'Gone Artist', 'Gone Done', 'Gone Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'deleted-playlist', 0, 'deleted-playlist', 'done', NULL, '__ROOT__/downloads/Gone Artist/Gone Album/Gone Done.flac', NULL, NULL, 1791046686891, 1791046686891, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'aurral', NULL);
INSERT INTO "playlist_download_jobs" ("id", "artist_name", "track_name", "album_name", "reason", "artist_mbid", "album_mbid", "track_mbid", "release_year", "duration_ms", "track_number", "album_track_count", "album_track_titles", "artist_aliases", "playlist_id", "playlist_generation", "playlist_type", "status", "staging_path", "final_path", "error", "started_at", "completed_at", "created_at", "download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename", "denied_remote_sources", "quality_tier", "quality_format", "quality_bitrate_kbps", "quality_sample_rate_hz", "quality_bit_depth", "quality_checked_at", "quality_upgrade_checked_at", "upgrade_for_job_id", "manual_replacement_search", "album_grab_attempted", "external_path", "managed_by", "request_group_id") VALUES ('56d3fc58-0a9f-41d9-855f-cf26e3cd615a', 'Imp Artist', 'Downloaded', 'Imp Album', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'quality-upgrade', 'pending', NULL, NULL, NULL, NULL, NULL, 1791046687208, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'c60f8d96-9275-4286-b77c-c7d28efa1520', 0, 0, NULL, 'aurral', NULL);
INSERT INTO "weekly_flow_download_cancellations" ("playlist_id", "generation", "state", "changed_at") VALUES ('2c860b40-aa75-46bc-90e1-a02c8af0bb7d', 0, 'active', 1791046686873);
INSERT INTO "weekly_flow_download_cancellations" ("playlist_id", "generation", "state", "changed_at") VALUES ('c9f40977-9e07-40f8-abd4-91f9c749bb4e', 0, 'active', 1791046686875);
INSERT INTO "weekly_flow_download_cancellations" ("playlist_id", "generation", "state", "changed_at") VALUES ('deleted-playlist', 0, 'cancelled', 1791046686891);
INSERT INTO "weekly_flow_download_job_cancellations" ("job_id", "cancelled_at") VALUES ('53d32d0d-73f7-4a12-b915-8cab45d4c0cc', 1791046687045);
INSERT INTO "weekly_flow_download_provider_work" ("job_id", "playlist_id", "provider", "work_id", "username", "created_at") VALUES ('329c7666-4624-4dfc-8080-54aa87ec3fb2', 'c9f40977-9e07-40f8-abd4-91f9c749bb4e', 'slskd', 'search-1', '', 1791046686876);
INSERT INTO "playlist_download_jobs_revision" ("id", "revision") VALUES (1, 35);
INSERT INTO "_honker_live" ("id", "queue", "payload", "state", "priority", "run_at", "worker_id", "claim_expires_at", "attempts", "max_attempts", "created_at", "expires_at") VALUES (1, 'slskd-pipeline', '{"phase":"search","jobId":"329c7666-4624-4dfc-8080-54aa87ec3fb2","playlistId":"c9f40977-9e07-40f8-abd4-91f9c749bb4e","playlistGeneration":0,"source":"slskd"}', 'pending', 0, 1791046686, NULL, NULL, 0, 5, 1791046686, NULL);
INSERT INTO "_honker_live" ("id", "queue", "payload", "state", "priority", "run_at", "worker_id", "claim_expires_at", "attempts", "max_attempts", "created_at", "expires_at") VALUES (2, 'weekly-flow-operation', '{"kind":"shared-playlist-update","playlistId":"c9f40977-9e07-40f8-abd4-91f9c749bb4e","name":"Imported"}', 'pending', 0, 1791046686, NULL, NULL, 0, 3, 1791046686, NULL);
INSERT INTO "_honker_live" ("id", "queue", "payload", "state", "priority", "run_at", "worker_id", "claim_expires_at", "attempts", "max_attempts", "created_at", "expires_at") VALUES (3, 'system-task', '{"kind":"weekly-flow-reuse-repair"}', 'pending', 0, 1791046686, NULL, NULL, 0, 3, 1791046686, NULL);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('weekly-flow-refresh', 'system-task-maintenance', '@every 1h', '{"kind":"weekly-flow-refresh"}', 0, NULL, 1791050286, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('session-cleanup', 'system-task-maintenance', '@every 1h', '{"kind":"session-cleanup"}', 0, NULL, 1791050286, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('weekly-flow-reuse-repair', 'system-task', '@every 30m', '{"kind":"weekly-flow-reuse-repair"}', 0, NULL, 1791048486, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('quality-upgrade-check', 'system-task', '@every 1h', '{"kind":"quality-upgrade-check"}', -10, NULL, 1791050286, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('discovery-refresh-check', 'system-task', '@every 15m', '{"kind":"discovery-refresh-check"}', 0, NULL, 1791047586, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('inbox-refresh', 'system-task-inbox', '@every 24h', '{"kind":"inbox-refresh"}', 0, NULL, 1791133086, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('news-refresh', 'system-task-maintenance', '@every 15m', '{"kind":"news-refresh"}', 0, NULL, 1791047586, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('import-list-sync', 'system-task', '@every 30m', '{"kind":"import-list-sync"}', 0, NULL, 1791048486, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('release-metadata-refresh', 'release-metadata-refresh', '@every 24h', '{"kind":"release-metadata-refresh"}', -5, NULL, 1791133086, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('aurral-monitoring-reconcile', 'system-task', '@every 24h', '{"kind":"aurral-monitoring-reconcile"}', 0, NULL, 1791133086, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('aurral-missing-track-search', 'system-task', '@every 24h', '{"kind":"aurral-missing-track-search"}', 0, NULL, 1791133086, 1, 3);
INSERT INTO "_honker_scheduler_tasks" ("name", "queue", "cron_expr", "payload", "priority", "expires_s", "next_fire_at", "enabled", "max_attempts") VALUES ('playlist-mbid-enrichment-sweep', 'playlist-mbid-enrichment', '@every 6h', '{"kind":"playlist-mbid-enrichment-sweep","reason":"schedule"}', 0, NULL, 1791068286, 1, 4);
INSERT INTO sqlite_sequence (name, seq) VALUES ('library_management', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('user_identities', 1);
INSERT INTO sqlite_sequence (name, seq) VALUES ('_honker_live', 3);
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
CREATE INDEX idx_images_cache_cache_age ON images_cache(cache_age);
CREATE INDEX idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
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
CREATE INDEX _honker_notifications_recent
           ON _honker_notifications(channel, id);
CREATE INDEX _honker_live_claim
      ON _honker_live(queue, priority DESC, run_at, id)
      WHERE state IN ('pending', 'processing');
CREATE INDEX _honker_live_pending_deadline
      ON _honker_live(queue, run_at)
      WHERE state = 'pending';
CREATE INDEX _honker_live_processing_deadline
      ON _honker_live(queue, claim_expires_at)
      WHERE state = 'processing';
CREATE INDEX _honker_stream_topic
      ON _honker_stream(topic, offset);
COMMIT;
