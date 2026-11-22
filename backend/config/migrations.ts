import type Database from "better-sqlite3";
import { createAurral3Schema } from "./aurral-3-schema.ts";
import { NOTIFICATION_EVENTS } from "../../lib/notificationEvents.ts";
import { isRecord } from "../../lib/isRecord.ts";
import { trackArtistCreditFromTags } from "../../lib/artistCredit.ts";
import type { LibraryTracksRow, SettingsRow, UsersRow } from "../db/rows.ts";

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

// Gotify is a webhook to its /message endpoint. Its token is stored encrypted
// the same way webhook header values are, so it moves over as it is.
const moveGotifyToWebhook: Migration = (db) => {
  const row = db
    .prepare<[], string>("SELECT value FROM settings WHERE key = 'integrations'")
    .pluck()
    .get();
  let integrations: unknown;
  try {
    integrations = JSON.parse(row ?? "");
  } catch {
    return;
  }
  if (!isRecord(integrations) || !("gotify" in integrations)) return;
  const { gotify, ...rest } = integrations;
  const url = isRecord(gotify) && typeof gotify.url === "string" ? gotify.url.trim() : "";
  const token = isRecord(gotify) && typeof gotify.token === "string" ? gotify.token.trim() : "";
  const webhooks = Array.isArray(rest.webhooks) ? rest.webhooks : [];
  if (isRecord(gotify) && url && token) {
    webhooks.push({
      url: `${url.replace(/\/+$/, "")}/message`,
      headers: [{ key: "X-Gotify-Key", value: token }],
      body: '{"title":"$title","message":"$message","priority":5}',
      events: NOTIFICATION_EVENTS.filter((event) => gotify[event] === true),
    });
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'integrations'").run(
    JSON.stringify({ ...rest, webhooks }),
  );
};

const recordDownloadCauses: Migration = (db) => {
  const hasColumn = db.prepare<[string]>(
    "SELECT 1 FROM pragma_table_info('download_jobs') WHERE name = ?",
  );
  for (const column of ["cause", "cause_playlist_id"]) {
    if (!hasColumn.get(column)) db.exec(`ALTER TABLE download_jobs ADD COLUMN ${column} TEXT`);
  }
};

const createHubLinks: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      token TEXT NOT NULL,
      user_code TEXT,
      expires_at INTEGER,
      handle TEXT,
      linked_at INTEGER,
      broken INTEGER NOT NULL DEFAULT 0
    );
  `);

const createHubPublications: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_publications (
      playlist_id TEXT NOT NULL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES hub_links(user_id) ON DELETE CASCADE,
      publication_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      published_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hub_publications_user ON hub_publications (user_id);
  `);

const ownOrphanedPlaylists: Migration = (db) => {
  const admin = db
    .prepare<[], Pick<UsersRow, "id">>(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
    )
    .get();
  if (!admin) return;
  const read = db.prepare<[string], Pick<SettingsRow, "value">>(
    "SELECT value FROM settings WHERE key = ? AND json_valid(value)",
  );
  const write = db.prepare<[string, string]>("UPDATE settings SET value = ? WHERE key = ?");
  for (const key of ["staticPlaylists", "flows"]) {
    const stored: unknown = JSON.parse(read.get(key)?.value ?? "null");
    if (!Array.isArray(stored)) continue;
    const owned = stored.map((item: unknown) =>
      isRecord(item) && item.ownerUserId == null ? { ...item, ownerUserId: admin.id } : item,
    );
    write.run(JSON.stringify(owned), key);
  }
};

const shareListeningWithFriends: Migration = (db) => {
  if (
    db.prepare("SELECT 1 FROM pragma_table_info('hub_links') WHERE name = 'share_listening'").get()
  )
    return;
  db.exec("ALTER TABLE hub_links ADD COLUMN share_listening INTEGER NOT NULL DEFAULT 1");
};

const blendWithPeopleOnServer: Migration = (db) => {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'blend'").get()) return;
  db.exec("ALTER TABLE users ADD COLUMN blend INTEGER NOT NULL DEFAULT 0");
};

const blendByDefault: Migration = (db) =>
  db.exec(`
    ALTER TABLE users DROP COLUMN blend;
    ALTER TABLE users ADD COLUMN blend INTEGER NOT NULL DEFAULT 1;
  `);

const storeFriendBlendTracks: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_friend_tracks (
      user_id INTEGER NOT NULL REFERENCES hub_links(user_id) ON DELETE CASCADE,
      handle TEXT NOT NULL,
      tracks TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, handle)
    );
  `);

const renewSessionsOnUse: Migration = (db) => {
  if (
    !db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'last_used_at'").get()
  ) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_used_at INTEGER");
  }
};

const restoreStoredTrackArtistCredits: Migration = (db) => {
  const rows = db
    .prepare<
      [],
      Pick<LibraryTracksRow, "id" | "artist_name" | "metadata_json">
    >(`SELECT id, artist_name, metadata_json FROM library_tracks
       WHERE json_valid(metadata_json)
         AND json_type(metadata_json, '$.tags.artists') IN ('array', 'text')`)
    .all();
  const update = db.prepare<[string, number]>(
    "UPDATE library_tracks SET artist_name = ? WHERE id = ?",
  );
  let changed = false;
  for (const row of rows) {
    const metadata: unknown = JSON.parse(row.metadata_json ?? "null");
    if (!isRecord(metadata) || !isRecord(metadata.tags)) continue;
    const current = String(row.artist_name ?? "").trim();
    const tagged = String(metadata.tags.artist ?? metadata.tags.albumartist ?? "").trim();
    if (current && current.toLocaleLowerCase() !== tagged.toLocaleLowerCase()) continue;
    const credit = trackArtistCreditFromTags(metadata.tags.artist, metadata.tags.artists);
    if (!credit || credit === current) continue;
    update.run(credit, row.id);
    changed = true;
  }
  if (changed) db.prepare("DELETE FROM settings WHERE key = 'librarySearchIndexVersion'").run();
};

const syncRestoredFileArtistTags: Migration = (db) => {
  const rows = db
    .prepare<
      [],
      Pick<LibraryTracksRow, "id" | "artist_name" | "metadata_json">
    >(`SELECT id, artist_name, metadata_json FROM library_tracks AS track
       WHERE json_valid(metadata_json)
         AND json_type(metadata_json, '$.tags.artists') IN ('array', 'text')
         AND EXISTS (SELECT 1 FROM library_media_files
           WHERE track_id = track.id AND artist_tag <> track.artist_name)`)
    .all();
  const update = db.prepare<[string, number, string]>(
    "UPDATE library_media_files SET artist_tag = ? WHERE track_id = ? AND artist_tag = ?",
  );
  for (const row of rows) {
    const metadata: unknown = JSON.parse(row.metadata_json ?? "null");
    if (!isRecord(metadata) || !isRecord(metadata.tags)) continue;
    const credit = trackArtistCreditFromTags(metadata.tags.artist, metadata.tags.artists);
    const tagged = String(metadata.tags.artist ?? "").trim();
    if (!tagged || credit === tagged || credit !== row.artist_name) continue;
    update.run(credit, row.id, tagged);
  }
};

// Aurral no longer talks to Last.fm, so its keys, scrobble sessions, link
// state, history usernames, and queued Last.fm work have no reader.
const dropLastfm: Migration = (db) => {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'lastfm_username'").get()) {
    db.exec("ALTER TABLE users DROP COLUMN lastfm_username");
  }
  db.exec(`
    DROP TABLE IF EXISTS lastfm_link_states;
    DELETE FROM listen_history_sources WHERE provider = 'lastfm';
    DELETE FROM settings WHERE key = 'lastfmRejectedKey';
    UPDATE settings SET value = json_remove(value, '$.lastfm')
      WHERE key = 'integrations' AND json_valid(value);
    UPDATE settings SET value = (
        SELECT json_group_object(entry.key, json_remove(entry.value, '$.lastfm'))
        FROM json_each(settings.value) AS entry
        WHERE entry.type = 'object' AND json_remove(entry.value, '$.lastfm') <> '{}'
      )
      WHERE key = 'scrobbleConnections' AND json_valid(value);
    DELETE FROM jobs WHERE state IN ('pending', 'running') AND (
      kind = 'lastfm-key-check'
      OR (queue = 'play-events' AND json_valid(payload) AND payload ->> '$.provider' = 'lastfm')
    );
  `);
};

const storeReleaseFeed: Migration = (db) =>
  db.exec(`
    DROP TABLE IF EXISTS library_release_calendar_artists;
    CREATE TABLE IF NOT EXISTS release_feed (
      artist_mbid TEXT NOT NULL,
      release_group_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      release_date TEXT NOT NULL,
      release_type TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (artist_mbid, release_group_mbid)
    ) WITHOUT ROWID;
  `);

const storeReleaseFeedCovers: Migration = (db) => {
  if (
    db.prepare("SELECT 1 FROM pragma_table_info('release_feed') WHERE name = 'cover_url'").get()
  ) {
    return;
  }
  db.exec(`
    DELETE FROM release_feed;
    ALTER TABLE release_feed ADD COLUMN cover_url TEXT;
  `);
};

// Aurral moved from the BrainzMash relay to the maintainers' server, which
// serves the same data, so cached answers carry over and relay waits do not.
const moveMetadataToMaintainersServer: Migration = (db) =>
  db.exec(`
    UPDATE OR IGNORE metadata_response_cache
    SET cache_key = 'https://brainzmash.kell.ly' || substr(cache_key, 32)
    WHERE substr(cache_key, 1, 31) = 'https://lidarrapi.brainzmash.cc';
    DELETE FROM metadata_response_cache
    WHERE substr(cache_key, 1, 31) = 'https://lidarrapi.brainzmash.cc';
    DELETE FROM metadata_request_state
    WHERE substr(cache_key, 1, 31) = 'https://lidarrapi.brainzmash.cc';
  `);

// Installs set up before #1575 saved the relay's address as their own server,
// which would keep them on the relay after the default moved.
const forgetSavedRelayAddress: Migration = (db) =>
  db.exec(`
    UPDATE settings SET value = json_set(value, '$.metadata.baseUrl', '')
    WHERE key = 'integrations' AND json_valid(value)
      AND rtrim(lower(value ->> '$.metadata.baseUrl'), '/')
        IN ('https://lidarrapi.brainzmash.cc', 'http://lidarrapi.brainzmash.cc');
  `);

// Aurral moved to static v1 files on data.aurral.org, which replace BrainzMash's
// entity shapes, so old BrainzMash cache rows and saved defaults are cleared.
const moveMetadataToDataAurral: Migration = (db) =>
  db.exec(`
    UPDATE settings SET value = json_set(value, '$.metadata.baseUrl', '')
    WHERE key = 'integrations' AND json_valid(value)
      AND rtrim(lower(value ->> '$.metadata.baseUrl'), '/')
        IN ('https://brainzmash.kell.ly', 'http://brainzmash.kell.ly');
    DELETE FROM metadata_response_cache
    WHERE substr(cache_key, 1, 26) = 'https://brainzmash.kell.ly';
    DROP TABLE IF EXISTS metadata_request_state;
    DROP TABLE IF EXISTS listenbrainz_release_groups;
    DROP TABLE IF EXISTS listenbrainz_artist_tags;
  `);

const forgetArtistCoverAlbums: Migration = (db) =>
  db.exec("DELETE FROM deezer_mbid_cache WHERE cache_key LIKE 'artist_rg:%'");

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
  moveGotifyToWebhook,
  recordDownloadCauses,
  createHubLinks,
  createHubPublications,
  ownOrphanedPlaylists,
  shareListeningWithFriends,
  blendWithPeopleOnServer,
  blendByDefault,
  storeFriendBlendTracks,
  renewSessionsOnUse,
  restoreStoredTrackArtistCredits,
  syncRestoredFileArtistTags,
  dropLastfm,
  storeReleaseFeed,
  storeReleaseFeedCovers,
  moveMetadataToMaintainersServer,
  forgetSavedRelayAddress,
  moveMetadataToDataAurral,
  forgetArtistCoverAlbums,
];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations) {
  const applied = () => Number(db.pragma("user_version", { simple: true }));
  if (applied() >= steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(applied())) step(db);
    db.pragma(`user_version = ${steps.length}`);
  }).immediate();
}
