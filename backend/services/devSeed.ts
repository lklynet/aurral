import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { dbOps, userOps } from "../db/helpers/index.ts";
import type { UsersRow } from "../db/rows.ts";
import { hashPassword } from "../middleware/passwordHash.ts";

export const SEED_LOGIN = { username: "test", password: "password" };

const SCRUBBED_SETTINGS = [
  "integrations",
  "pathMappings",
  "security",
  "_encryptionKey",
  "_betterAuthSecret",
  "shareInstanceId",
  "shareInstanceSecret",
  "scrobbleConnections",
  "spotifyConnections",
  "plexConnections",
  "jellyfinPlaylistPointers",
  "navidromePlaylistPointers",
  "plexPlaylistPointers",
  "pendingLibraryScanJob",
  "slskdSearchStartedAt",
  "storageHealthSnapshot",
  "weeklyFlowIncompleteRetryJobs",
];
const SCRUBBED_SETTING_PREFIXES = ["activeDownloadAttempt:", "weeklyFlowOperationTokens"];

export const flowsSchema = v.array(v.looseObject({}));

function patchSetting(key: string, patch: Record<string, unknown>) {
  const value = dbOps.getJSONSetting(key, v.looseObject({}));
  if (value) dbOps.setJSONSetting(key, { ...value, ...patch });
}

function scrubSettings() {
  const remove = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");
  for (const key of SCRUBBED_SETTINGS) remove.run(key);
  const removePrefix = db.prepare<[{ prefix: string }]>(
    "DELETE FROM settings WHERE substr(key, 1, length(@prefix)) = @prefix",
  );
  for (const prefix of SCRUBBED_SETTING_PREFIXES) removePrefix.run({ prefix });

  const flows = dbOps.getJSONSetting("flows", flowsSchema);
  if (flows) {
    dbOps.setJSONSetting(
      "flows",
      flows.map((flow) => ({ ...flow, enabled: false, nextRunAt: null, lidarrFeedToken: null })),
    );
  }
  patchSetting("missingTrackSearch", { enabled: false });
  patchSetting("qualityProfile", { automaticUpgrades: false });
  dbOps.invalidateSettingsCache();
  dbOps.updateSettings({
    integrations: {
      general: { authUser: SEED_LOGIN.username, authPassword: SEED_LOGIN.password },
    },
  });
}

function resetUsers() {
  const users = db.prepare<[], Pick<UsersRow, "id" | "role">>("SELECT id, role FROM users").all();
  const admin = users.find((user) => user.role === "admin");
  const renameAdmin = !userOps.getUserByUsername(SEED_LOGIN.username);
  const passwordHash = hashPassword(SEED_LOGIN.password);
  for (const user of users) {
    userOps.updateUser(user.id, {
      passwordHash,
      subsonicPassword: SEED_LOGIN.password,
      hasLocalPassword: true,
      ...(renameAdmin && user === admin ? { username: SEED_LOGIN.username } : {}),
    });
  }
}

type TablePlan = "keep" | "clear" | (() => void);

const TABLES = new Map<string, TablePlan>(
  Object.entries({
    settings: scrubSettings,
    users: resetUsers,
    playlist_download_jobs: () =>
      db.exec(
        "UPDATE playlist_download_jobs SET status = 'cancelled' WHERE status NOT IN ('done', 'failed', 'cancelled')",
      ),
    library_file_operations: () =>
      db.exec(
        "UPDATE library_file_operations SET status = 'cancelled' WHERE status IN ('planning', 'running')",
      ),

    sessions: "clear",
    user_identities: "clear",
    lastfm_link_states: "clear",
    share_links: "clear",
    share_downloads: "clear",
    lidarr_artist_id_map: "clear",
    metadata_provider_budget: "clear",
    metadata_request_state: "clear",
    weekly_flow_download_provider_work: "clear",
    honker_task_runs: "clear",
    _honker_dead: "clear",
    _honker_live: "clear",
    _honker_locks: "clear",
    _honker_notifications: "clear",
    _honker_rate_limits: "clear",
    _honker_results: "clear",
    _honker_scheduler_tasks: "clear",
    _honker_stream: "clear",
    _honker_stream_consumers: "clear",

    accounts: "clear",
    activity_log: "clear",
    app_passwords: "clear",
    verifications: "clear",

    artist_overrides: "keep",
    aurral_history: "keep",
    custom_artwork: "keep",
    deezer_mbid_cache: "keep",
    discovery_cache: "keep",
    images_cache: "keep",
    inbox_items: "keep",
    library_album_credits: "keep",
    library_album_tracks: "keep",
    library_albums: "keep",
    library_artists: "keep",
    library_entity_genres: "keep",
    library_file_operation_items: "keep",
    library_management: "keep",
    library_media_files: "keep",
    library_monitoring_exclusions: "keep",
    library_release_calendar: "keep",
    library_release_calendar_artists: "keep",
    library_scan_runs: "keep",
    library_search_documents: "keep",
    library_search_fts: "keep",
    library_search_fts_config: "keep",
    library_search_fts_data: "keep",
    library_search_fts_docsize: "keep",
    library_search_fts_idx: "keep",
    library_tracks: "keep",
    metadata_response_cache: "keep",
    musicbrainz_artist_mbid_cache: "keep",
    news_articles: "keep",
    play_album_stats: "keep",
    play_events: "keep",
    playlist_download_jobs_revision: "keep",
    slskd_transfer_history: "keep",
    subsonic_play_queues: "keep",
    subsonic_star_changes: "keep",
    subsonic_stars: "keep",
    trending_chart_days: "keep",
    trending_charts: "keep",
    weekly_flow_download_cancellations: "keep",
    weekly_flow_download_job_cancellations: "keep",
    wrapped_reports: "keep",
  }),
);

export function seedDatabase() {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .all()
    .map((table) => table.name);
  const unknown = tables.filter((name) => !TABLES.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `The seed does not know what to do with ${unknown.join(", ")}. Add each table to TABLES in backend/services/devSeed.ts.`,
    );
  }
  db.transaction(() => {
    for (const name of tables) {
      const plan = TABLES.get(name);
      if (plan === "clear") db.exec(`DELETE FROM "${name}"`);
      else if (typeof plan === "function") plan();
    }
  })();
  return {
    downloadFolder: db
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'downloadFolderPath'")
      .get()?.value,
  };
}
