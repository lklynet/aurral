import type Database from "better-sqlite3";
import { createAurral3Schema } from "./aurral-3-schema.ts";

type Migration = (db: Database.Database) => void;

const indexFinishedDownloadNames: Migration = (db) =>
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_download_jobs_done_name
      ON download_jobs(lower(trim(coalesce(track_name, ''))))
      WHERE status = 'done' AND final_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_download_jobs_done_unicode_name
      ON download_jobs(id)
      WHERE status = 'done' AND final_path IS NOT NULL AND (track_name GLOB '*[^ -~]*' OR length(track_name) <> length(CAST(track_name AS BLOB)));
  `);

// Aurral runs every Library, so nothing reads who managed an artist, an album,
// or a download, and Lidarr's settings, IDs, and open requests have no reader.
const dropLidarrMode: Migration = (db) => {
  db.exec("DROP INDEX IF EXISTS idx_library_management_managed_by");
  const hasColumn = db.prepare<[string, string]>(
    "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
  );
  for (const [table, column] of [
    ["library_management", "managed_by"],
    ["download_jobs", "managed_by"],
    ["users", "lidarr_root_folder_path"],
    ["users", "lidarr_quality_profile_id"],
  ] as const) {
    if (hasColumn.get(table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  db.exec(`
    DROP TABLE IF EXISTS lidarr_artist_id_map;
    UPDATE settings SET value = json_remove(value, '$.lidarr')
      WHERE key = 'integrations' AND json_valid(value);
    DELETE FROM settings WHERE key = 'rootFolderPath';
    UPDATE settings SET value = (
        SELECT json_group_array(json(mapping.value)) FROM json_each(settings.value) AS mapping
        WHERE mapping.type = 'object'
          AND lower(trim(coalesce(mapping.value ->> '$.source', ''))) <> 'lidarr'
      )
      WHERE key = 'pathMappings' AND json_valid(value) AND json_type(value) = 'array';
    UPDATE aurral_history SET status = 'completed', status_label = 'Requested',
        title = 'Requested ' || coalesce(
          CASE WHEN json_valid(metadata) THEN metadata ->> '$.albumName' END, 'album')
      WHERE kind = 'album_requested' AND status = 'processing';
  `);
};

const storeListenbrainzReleaseGroups: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS listenbrainz_release_groups (
      mbid TEXT PRIMARY KEY,
      first_release_date TEXT,
      dates_checked_at INTEGER,
      listen_count INTEGER,
      listener_count INTEGER,
      popularity_checked_at INTEGER
    );
  `);

const storeListenbrainzArtistTags: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS listenbrainz_artist_tags (
      mbid TEXT PRIMARY KEY,
      tags_json TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    );
  `);

const indexPlaysByArtist: Migration = (db) =>
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_play_events_user_artist
      ON play_events(user_id, artist COLLATE NOCASE);
  `);

// A finished download always has its file, and every status is one Aurral reads.
const failUnreadableDownloadJobs: Migration = (db) =>
  db.exec(`
    UPDATE download_jobs SET status = 'failed'
    WHERE (status = 'done' AND coalesce(final_path, '') = '')
      OR status NOT IN (
        'pending', 'downloading', 'blocked', 'done', 'failed', 'cancel_requested', 'cancelled',
        'saved'
      );
  `);

// Album fetches that failed used to wait an hour, six hours, then a day before
// trying again. Any other wait is one BrainzMash asked for, so it stays.
const clearMetadataFailureBackoff: Migration = (db) =>
  db.exec(`
    DELETE FROM metadata_request_state
    WHERE failure_count > 0 AND retry_after - updated_at IN (3600000, 21600000, 86400000);
  `);

// Usenet and Tidarr became download sources like qBittorrent: a job names
// its download with the client that holds it, and a release it turned down
// by the album identity the source lists.
const nameUsenetDownloadsBySource: Migration = (db) => {
  db.exec(`
    UPDATE download_jobs
    SET download_client_id = download_client || ':' || download_client_id,
      download_client = download_source
    WHERE download_source IN ('usenet', 'tidarr')
      AND download_client IN ('nzbget', 'sabnzbd', 'tidarr')
      AND coalesce(download_client_id, '') <> ''
      AND instr(download_client_id, ':') = 0;
  `);
  const rows = db
    .prepare<[], { id: string; denied: string }>(
      `SELECT id, denied_remote_sources AS denied FROM download_jobs
       WHERE denied_remote_sources LIKE '%"usenet"%' OR denied_remote_sources LIKE '%"tidarr"%'`,
    )
    .all();
  const update = db.prepare<[string, string]>(
    "UPDATE download_jobs SET denied_remote_sources = ? WHERE id = ?",
  );
  const identity = (guid: string) => {
    const id = guid.trim().toLowerCase();
    const album = /^(\d+)-(hires_lossless|lossless|high|low)$/.exec(id)?.[1];
    return `album:${album ? `tidarr:${album}` : id}`;
  };
  for (const { id, denied } of rows) {
    let entries: unknown;
    try {
      entries = JSON.parse(denied);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const renamed = entries.map((entry: unknown) =>
      Array.isArray(entry) &&
      (entry[0] === "usenet" || entry[0] === "tidarr") &&
      typeof entry[1] === "string" &&
      !entry[1].startsWith("album:")
        ? [entry[0], identity(entry[1])]
        : entry,
    );
    update.run(JSON.stringify(renamed), id);
  }
};

// These settings became fixed behavior. Each user keeps the discovery mode
// the server used.
const dropFixedSettings: Migration = (db) =>
  db.exec(`
    INSERT OR IGNORE INTO settings (key, value)
      SELECT 'user:' || users.id || ':discoveryMode', json_quote(integrations.value ->> '$.lastfm.discoveryMode')
      FROM users, settings AS integrations
      WHERE integrations.key = 'integrations' AND json_valid(integrations.value)
        AND integrations.value ->> '$.lastfm.discoveryMode' IN ('safer', 'deeper');
    UPDATE settings SET value = json_remove(value,
        '$.lastfm.discoveryMode', '$.lastfm.discoveryAutoRefreshHours',
        '$.lastfm.discoveryRecommendationsPerRefresh', '$.slskd.cleanupAfterRuns',
        '$.prowlarr.categories', '$.prowlarr.maxResults', '$.nzbget.nzbPriority',
        '$.nzbget.addPaused', '$.nzbget.deleteLeftovers', '$.sabnzbd.addPaused',
        '$.sabnzbd.deleteLeftovers')
      WHERE key = 'integrations' AND json_valid(value);
    UPDATE settings SET value = json_remove(value, '$.ssoOnly')
      WHERE key = 'security' AND json_valid(value);
    DELETE FROM settings WHERE key IN ('missingTrackSearch', 'reviewTimeoutHours', 'subsonic', 'playlistFiles');
  `);

// These settings had no reader or no way to change them. A turned-off Inbox
// keeps every item off, which is how Inbox is turned off now.
const dropUnusedSettings: Migration = (db) =>
  db.exec(`
    DELETE FROM settings WHERE key IN ('quality', 'releaseTypes', 'queueCleaner');
    UPDATE settings SET value = json_remove(value,
        '$.lastfm.discoveryPeriod',
        '$.ticketmaster.localDiscoveryIncludeRecommendations',
        '$.ticketmaster.localDiscoveryIncludeTrending',
        '$.metadata.provider',
        '$.metadata.userAgentSuffix',
        '$.metadata.enableNarrowFallbacks')
      WHERE key = 'integrations' AND json_valid(value);
    UPDATE settings SET value = json_set(value,
        '$.releases', json('false'), '$.shows', json('false'), '$.news', json('false'),
        '$.recommendedNews', json('false'), '$.discoveries', json('false'))
      WHERE key = 'inbox' AND json_valid(value) AND json_type(value, '$.enabled') = 'false';
    UPDATE settings SET value = json_remove(value, '$.enabled')
      WHERE key = 'inbox' AND json_valid(value);
  `);

export const migrations: Migration[] = [
  createAurral3Schema,
  indexFinishedDownloadNames,
  dropLidarrMode,
  storeListenbrainzReleaseGroups,
  storeListenbrainzArtistTags,
  indexPlaysByArtist,
  failUnreadableDownloadJobs,
  clearMetadataFailureBackoff,
  nameUsenetDownloadsBySource,
  dropFixedSettings,
  dropUnusedSettings,
];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations) {
  const applied = () => Number(db.pragma("user_version", { simple: true }));
  if (applied() >= steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(applied())) step(db);
    db.pragma(`user_version = ${steps.length}`);
  }).immediate();
}
