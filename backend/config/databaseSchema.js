export const SCHEMA_VERSION = 5;

export function createSchema(db) {
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
      listen_history_url TEXT,
      lidarr_root_folder_path TEXT,
      lidarr_quality_profile_id INTEGER,
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

    CREATE TABLE IF NOT EXISTS subsonic_stars (
      user_id INTEGER NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
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

    CREATE TABLE IF NOT EXISTS play_album_stats (
      user_id INTEGER NOT NULL,
      album_key TEXT NOT NULL,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, album_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

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

    CREATE TABLE IF NOT EXISTS download_jobs (
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
      owner_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      managed_by TEXT,
      request_group_id TEXT,
      status TEXT NOT NULL,
      staging_path TEXT,
      final_path TEXT,
      external_path TEXT,
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
      album_grab_attempted INTEGER NOT NULL DEFAULT 0,
      queued_for_playlist INTEGER NOT NULL DEFAULT 0
    );

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
    CREATE TRIGGER IF NOT EXISTS download_attempt_delete
      AFTER DELETE ON download_jobs BEGIN
        DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS download_attempt_complete
      AFTER UPDATE OF status ON download_jobs WHEN NEW.status = 'done' BEGIN
        DELETE FROM settings WHERE key = 'activeDownloadAttempt:' || NEW.id;
      END;

    CREATE TABLE IF NOT EXISTS download_owner_cancellations (
      owner_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active',
      changed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS download_job_cancellations (
      job_id TEXT PRIMARY KEY,
      cancelled_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS download_provider_work (
      job_id TEXT NOT NULL,
      owner_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      work_id TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, provider, work_id, username)
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

    CREATE TABLE IF NOT EXISTS library_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_key TEXT NOT NULL UNIQUE,
      mbid TEXT,
      title TEXT NOT NULL,
      artist_name TEXT,
      metadata_json TEXT,
      monitored INTEGER NOT NULL DEFAULT 1,
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

    CREATE TABLE IF NOT EXISTS library_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      managed_by TEXT NOT NULL,
      monitor_mode TEXT,
      last_missing_search_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (entity_kind, entity_id)
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

    CREATE TABLE IF NOT EXISTS metadata_provider_budget (
      base_url TEXT PRIMARY KEY,
      next_request_at INTEGER NOT NULL DEFAULT 0,
      forbidden_until INTEGER NOT NULL DEFAULT 0,
      rate_limited_until INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_lastfm_link_states_expiry ON lastfm_link_states(expires_at);
    CREATE INDEX IF NOT EXISTS idx_play_events_user_played_at ON play_events(user_id, played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_play_album_stats_user_ranking
      ON play_album_stats(user_id, play_count DESC, last_played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_owner_id ON download_jobs(owner_id);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_request_group ON download_jobs(request_group_id);
    CREATE INDEX IF NOT EXISTS idx_download_job_cancellations_time
      ON download_job_cancellations(cancelled_at);
    CREATE INDEX IF NOT EXISTS idx_download_provider_work_job
      ON download_provider_work(job_id, provider);
    CREATE INDEX IF NOT EXISTS idx_download_provider_work_owner
      ON download_provider_work(owner_id, provider);
    CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
    CREATE INDEX IF NOT EXISTS idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject
      ON user_identities(provider_type, provider_key, subject);
    CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);
    CREATE INDEX IF NOT EXISTS idx_subsonic_stars_user_created ON subsonic_stars (user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lidarr_artist_id_map_foreign_id
      ON lidarr_artist_id_map (lidarr_foreign_artist_id);
    CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id ON library_albums (artist_id);
    CREATE INDEX IF NOT EXISTS idx_library_albums_mbid ON library_albums (mbid);
    CREATE INDEX IF NOT EXISTS idx_library_albums_release_group_mbid ON library_albums (release_group_mbid);
    CREATE INDEX IF NOT EXISTS idx_library_albums_title ON library_albums (title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_albums_release_date ON library_albums (release_date DESC);
    CREATE INDEX IF NOT EXISTS idx_library_release_calendar_artist ON library_release_calendar (artist_id);
    CREATE INDEX IF NOT EXISTS idx_library_release_calendar_date
      ON library_release_calendar (present, release_date DESC);
    CREATE INDEX IF NOT EXISTS idx_library_artists_sort_name_name
      ON library_artists (sort_name COLLATE NOCASE, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_artists_mbid ON library_artists (mbid);
    CREATE INDEX IF NOT EXISTS idx_library_artists_provider_id
      ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
    CREATE INDEX IF NOT EXISTS idx_library_artists_foreign_artist_id
      ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
    CREATE INDEX IF NOT EXISTS idx_library_artists_name ON library_artists (name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_album_tracks_track_id ON library_album_tracks (track_id);
    CREATE INDEX IF NOT EXISTS idx_library_tracks_title ON library_tracks (title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_library_tracks_mbid ON library_tracks (mbid);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id ON library_media_files (track_id);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_source_available
      ON library_media_files (track_id, source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available ON library_media_files (source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id ON library_media_files (last_seen_scan_id);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_album_source_available
      ON library_media_files (album_id, source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_album_source_available
      ON library_media_files (track_id, album_id, source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_album_source_available_created
      ON library_media_files (track_id, album_id, source, available, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_library_management_entity ON library_management (entity_kind, entity_id);
    CREATE INDEX IF NOT EXISTS idx_library_management_managed_by ON library_management (managed_by);
    CREATE INDEX IF NOT EXISTS idx_aurral_history_created_at ON aurral_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_user_state
      ON inbox_items(user_id, is_dismissed, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_expiry ON inbox_items(expires_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_articles_published_at ON news_articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username
      ON slskd_transfer_history(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status
      ON slskd_transfer_history(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup
      ON slskd_transfer_history(cleaned_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_honker_task_runs_started_at ON honker_task_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_honker_task_runs_queue_started ON honker_task_runs(queue, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_honker_task_runs_job ON honker_task_runs(job_id, queue);
  `);
}
