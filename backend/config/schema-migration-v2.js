const SCHEMA_VERSION_KEY = "schemaVersion";
const V2_SCHEMA_VERSION = 2;
const V4_SCHEMA_VERSION = 4;
export const TARGET_SCHEMA_VERSION = V4_SCHEMA_VERSION;

export function getSchemaVersion(db) {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SCHEMA_VERSION_KEY);
  return Number(row?.value || 1);
}

export function initializeSchemaOnStartup(db, dbHelpers) {
  return applyV3Migration(db, dbHelpers);
}

function tableExists(db, name) {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return !!row;
}

function tryAddColumn(db, sql) {
  try {
    db.exec(sql);
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("duplicate column name")) {
      throw error;
    }
  }
}

function getTableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return [];
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);
}

function buildPlaylistWorkerSettings(weeklyFlowWorker, playlistWorker) {
  const legacy = weeklyFlowWorker && typeof weeklyFlowWorker === "object"
    ? weeklyFlowWorker
    : {};
  const current = playlistWorker && typeof playlistWorker === "object"
    ? playlistWorker
    : {};
  const parsedConcurrency = Number(
    current.concurrency ?? legacy.concurrency,
  );
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : 2;
  const retryCycleMinutes = 360;
  const retryPausedPlaylistIds = Array.isArray(current.retryPausedPlaylistIds)
    ? current.retryPausedPlaylistIds
    : Array.isArray(legacy.retryPausedPlaylistIds)
      ? legacy.retryPausedPlaylistIds
      : [];
  const existingFileModeRaw =
    current.existingFileMode ?? legacy.existingFileMode;
  const existingFileMode =
    String(existingFileModeRaw || "").trim().toLowerCase() === "download"
      ? "download"
      : "reuse";
  return {
    concurrency,
    retryCycleMinutes,
    retryPausedPlaylistIds,
    existingFileMode,
  };
}

function backfillSlskdSettings(db, dbHelpers) {
  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const upsertSettingStmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );
  const integrations = dbHelpers.parseJSON(
    getSettingStmt.get("integrations")?.value,
  );
  if (!integrations) return;
  const weeklyFlowWorker = dbHelpers.parseJSON(
    getSettingStmt.get("weeklyFlowWorker")?.value,
  );
  const slskd = { ...(integrations.slskd || {}) };
  let changed = false;
  if (!slskd.preferredFormat) {
    slskd.preferredFormat =
      String(weeklyFlowWorker?.preferredFormat || "").toLowerCase() === "mp3"
        ? "mp3"
        : "flac";
    changed = true;
  }
  if (slskd.preferredFormatStrict === undefined) {
    slskd.preferredFormatStrict =
      weeklyFlowWorker?.preferredFormatStrict === true;
    changed = true;
  }
  if (!changed) return;
  upsertSettingStmt.run(
    "integrations",
    dbHelpers.stringifyJSON({
      ...integrations,
      slskd,
    }),
  );
}

export function finalizeV2SettingsKeys(db, dbHelpers) {
  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const upsertSettingStmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );

  const flows = dbHelpers.parseJSON(getSettingStmt.get("flows")?.value);
  const weeklyFlows = dbHelpers.parseJSON(
    getSettingStmt.get("weeklyFlows")?.value,
  );
  if (flows == null && weeklyFlows != null) {
    upsertSettingStmt.run("flows", dbHelpers.stringifyJSON(weeklyFlows));
  }

  const sharedPlaylists = dbHelpers.parseJSON(
    getSettingStmt.get("sharedPlaylists")?.value,
  );
  const sharedFlowPlaylists = dbHelpers.parseJSON(
    getSettingStmt.get("sharedFlowPlaylists")?.value,
  );
  if (sharedPlaylists == null && sharedFlowPlaylists != null) {
    upsertSettingStmt.run(
      "sharedPlaylists",
      dbHelpers.stringifyJSON(sharedFlowPlaylists),
    );
  }

  const playlistWorker = dbHelpers.parseJSON(
    getSettingStmt.get("playlistWorker")?.value,
  );
  const weeklyFlowWorker = dbHelpers.parseJSON(
    getSettingStmt.get("weeklyFlowWorker")?.value,
  );
  if (weeklyFlowWorker || playlistWorker) {
    upsertSettingStmt.run(
      "playlistWorker",
      dbHelpers.stringifyJSON(
        buildPlaylistWorkerSettings(weeklyFlowWorker, playlistWorker),
      ),
    );
  }

  backfillSlskdSettings(db, dbHelpers);
}

function ensurePlaylistDownloadJobsTable(db) {
  db.exec(`
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
      quality_tier TEXT,
      quality_format TEXT,
      quality_bitrate_kbps INTEGER,
      quality_sample_rate_hz INTEGER,
      quality_bit_depth INTEGER,
      quality_checked_at INTEGER,
      quality_upgrade_checked_at INTEGER,
      upgrade_for_job_id TEXT
    );
  `);
}

function ensureSlskdTransferHistoryTable(db) {
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
  `);
}

function normalizeMonitorMode(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function ensureLibraryManagementTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      managed_by TEXT NOT NULL,
      monitor_mode TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (entity_kind, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_library_management_entity
      ON library_management (entity_kind, entity_id);
    CREATE INDEX IF NOT EXISTS idx_library_management_managed_by
      ON library_management (managed_by);
  `);
}

function backfillJobOwnership(db) {
  tryAddColumn(db, "ALTER TABLE playlist_download_jobs ADD COLUMN managed_by TEXT");
  tryAddColumn(db, "ALTER TABLE playlist_download_jobs ADD COLUMN request_group_id TEXT");
  db.exec(`
    UPDATE playlist_download_jobs
    SET managed_by = 'aurral'
    WHERE managed_by IS NULL OR TRIM(managed_by) = '';
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_request_group ON playlist_download_jobs(request_group_id)",
  );
}

function backfillLidarrManagementState(db) {
  if (!tableExists(db, "library_artists")) {
    return;
  }
  const now = Date.now();
  const artists = db
    .prepare("SELECT id, mbid, metadata_json FROM library_artists")
    .all();
  if (!artists.length) return;
  const managedByMbid = tableExists(db, "lidarr_artist_id_map")
    ? new Set(
        db
          .prepare("SELECT musicbrainz_id FROM lidarr_artist_id_map")
          .all()
          .map((row) => row.musicbrainz_id),
      )
    : new Set();
  const upsertStmt = db.prepare(`
    INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
    VALUES ('artist', ?, 'lidarr', ?, ?, ?)
    ON CONFLICT (entity_kind, entity_id) DO NOTHING
  `);
  for (const artist of artists) {
    let metadata = {};
    try {
      metadata = JSON.parse(artist.metadata_json || "{}");
    } catch {}
    const mapMatch = artist.mbid && managedByMbid.has(artist.mbid);
    const indexerMatch = metadata?.librarySource === "lidarr";
    if (!mapMatch && !indexerMatch) continue;
    const monitorMode = normalizeMonitorMode(metadata?.monitor || metadata?.addOptions?.monitor);
    upsertStmt.run(artist.id, monitorMode, now, now);
  }
}

export function applyOwnershipMigration(db) {
  ensureLibraryManagementTable(db);
  backfillJobOwnership(db);
  backfillLidarrManagementState(db);
}

function legacyColumnExpr(columns, columnName, fallback = "NULL") {
  return columns.includes(columnName) ? columnName : fallback;
}

function syncWeeklyFlowJobsToPlaylistDownloads(db) {
  if (!tableExists(db, "weekly_flow_jobs")) return;

  const columns = getTableColumns(db, "weekly_flow_jobs");
  const playlistTypeExpr = columns.includes("playlist_type")
    ? "NULLIF(TRIM(playlist_type), '')"
    : "NULL";

  db.exec(`
    INSERT INTO playlist_download_jobs (
      id,
      artist_name,
      track_name,
      album_name,
      reason,
      artist_mbid,
      album_mbid,
      track_mbid,
      release_year,
      duration_ms,
      track_number,
      album_track_count,
      album_track_titles,
      artist_aliases,
      playlist_id,
      playlist_type,
      status,
      staging_path,
      final_path,
      error,
      started_at,
      completed_at,
      created_at
    )
    SELECT
      id,
      COALESCE(${legacyColumnExpr(columns, "artist_name")}, 'Unknown Artist'),
      COALESCE(${legacyColumnExpr(columns, "track_name")}, 'Unknown Track'),
      ${legacyColumnExpr(columns, "album_name")},
      ${legacyColumnExpr(columns, "reason")},
      ${legacyColumnExpr(columns, "artist_mbid")},
      ${legacyColumnExpr(columns, "album_mbid")},
      ${legacyColumnExpr(columns, "track_mbid")},
      ${legacyColumnExpr(columns, "release_year")},
      ${legacyColumnExpr(columns, "duration_ms")},
      NULL,
      NULL,
      NULL,
      ${legacyColumnExpr(columns, "artist_aliases")},
      COALESCE(${playlistTypeExpr}, 'discover'),
      ${playlistTypeExpr},
      COALESCE(NULLIF(TRIM(${legacyColumnExpr(columns, "status", "'pending'")}), ''), 'pending'),
      ${legacyColumnExpr(columns, "staging_path")},
      ${legacyColumnExpr(columns, "final_path")},
      ${legacyColumnExpr(columns, "error")},
      ${legacyColumnExpr(columns, "started_at")},
      ${legacyColumnExpr(columns, "completed_at")},
      COALESCE(${legacyColumnExpr(columns, "created_at")}, 0)
    FROM weekly_flow_jobs
    WHERE 1
    ON CONFLICT(id) DO UPDATE SET
      artist_name = excluded.artist_name,
      track_name = excluded.track_name,
      album_name = excluded.album_name,
      reason = excluded.reason,
      artist_mbid = excluded.artist_mbid,
      album_mbid = excluded.album_mbid,
      track_mbid = excluded.track_mbid,
      release_year = excluded.release_year,
      duration_ms = excluded.duration_ms,
      artist_aliases = excluded.artist_aliases,
      playlist_id = excluded.playlist_id,
      playlist_type = excluded.playlist_type,
      status = excluded.status,
      staging_path = excluded.staging_path,
      final_path = excluded.final_path,
      error = excluded.error,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      created_at = excluded.created_at;
  `);
}

function dropLegacyWeeklyFlowJobTriggers(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS sync_playlist_download_jobs_ai_weekly_flow_jobs;
    DROP TRIGGER IF EXISTS sync_playlist_download_jobs_au_weekly_flow_jobs;
    DROP TRIGGER IF EXISTS sync_playlist_download_jobs_ad_weekly_flow_jobs;
  `);
}

function dropLegacyWeeklyFlowJobs(db) {
  dropLegacyWeeklyFlowJobTriggers(db);
  db.exec(`DROP TABLE IF EXISTS weekly_flow_jobs;`);
}

function migrateJobsTable(db) {
  ensurePlaylistDownloadJobsTable(db);

  const columns = db
    .prepare("PRAGMA table_info(playlist_download_jobs)")
    .all()
    .map((column) => column.name);

  if (!columns.includes("playlist_id")) {
    tryAddColumn(db, "ALTER TABLE playlist_download_jobs ADD COLUMN playlist_id TEXT");
  }
  if (!columns.includes("playlist_type")) {
    tryAddColumn(
      db,
      "ALTER TABLE playlist_download_jobs ADD COLUMN playlist_type TEXT",
    );
  }
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN slskd_search_id TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN slskd_batch_id TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN remote_username TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN remote_filename TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN track_number INTEGER",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN album_track_count INTEGER",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN album_track_titles TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN artist_aliases TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN download_source TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN download_client TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN download_client_id TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN release_guid TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN release_title TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN indexer_id TEXT",
  );
  tryAddColumn(
    db,
    "ALTER TABLE playlist_download_jobs ADD COLUMN indexer_name TEXT",
  );
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
    tryAddColumn(
      db,
      `ALTER TABLE playlist_download_jobs ADD COLUMN ${name} ${type}`,
    );
  }

  dropLegacyWeeklyFlowJobTriggers(db);
  syncWeeklyFlowJobsToPlaylistDownloads(db);

  const latestColumns = db
    .prepare("PRAGMA table_info(playlist_download_jobs)")
    .all()
    .map((column) => column.name);

  if (latestColumns.includes("playlist_type")) {
    db.exec(`
      UPDATE playlist_download_jobs
      SET playlist_id = playlist_type
      WHERE playlist_id IS NULL OR TRIM(playlist_id) = '';
    `);
  }

  if (latestColumns.includes("started_at")) {
    db.exec(`
      UPDATE playlist_download_jobs
      SET status = 'pending',
          started_at = NULL,
          staging_path = NULL
      WHERE status = 'downloading';
    `);
  } else {
    db.exec(`
      UPDATE playlist_download_jobs
      SET status = 'pending'
      WHERE status = 'downloading';
    `);
  }

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_status ON playlist_download_jobs(status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_playlist_id ON playlist_download_jobs(playlist_id)",
  );

  dropLegacyWeeklyFlowJobs(db);
}

function applySchemaMigration(db, dbHelpers, targetVersion) {
  const currentVersion = getSchemaVersion(db);
  const migrated = currentVersion < targetVersion;
  if (!migrated) {
    return { migrated: false, schemaVersion: currentVersion };
  }
  const upsertSettingStmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );
  const run = db.transaction(() => {
    finalizeV2SettingsKeys(db, dbHelpers);
    migrateJobsTable(db);
    ensureSlskdTransferHistoryTable(db);
    if (targetVersion >= V4_SCHEMA_VERSION) {
      applyOwnershipMigration(db);
    }
    if (migrated) {
      upsertSettingStmt.run(SCHEMA_VERSION_KEY, String(targetVersion));
    }
  });
  run();
  return {
    migrated: true,
    schemaVersion: targetVersion,
  };
}

export function applyV2Migration(db, dbHelpers) {
  return applySchemaMigration(db, dbHelpers, V2_SCHEMA_VERSION);
}

export function applyV3Migration(db, dbHelpers) {
  return applySchemaMigration(db, dbHelpers, TARGET_SCHEMA_VERSION);
}

export function applyV4Migration(db, dbHelpers) {
  return applySchemaMigration(db, dbHelpers, V4_SCHEMA_VERSION);
}
