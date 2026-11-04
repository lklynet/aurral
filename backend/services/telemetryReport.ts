import { isDeepStrictEqual } from "node:util";
import { asAppError } from "../../lib/errors.ts";
import {
  APPEARANCES,
  AUTH_MODES,
  DATE_TIME_FORMATS,
  DEPRECATION_KINDS,
  DISCOVERY_SOURCES,
  DOWNLOAD_SOURCES,
  IMPORT_SOURCES,
  INTEGRATIONS,
  LISTEN_SOURCES,
  LOG_CATEGORIES,
  PLAYBACK_SERVERS,
  PLAY_SOURCES,
  SETTING_FLAGS,
  THEME_KINDS,
  TELEMETRY_INTERVAL_MS,
  countBucket,
  type TelemetryReport,
} from "../../lib/telemetry.ts";
import { APP_VERSION, DEFAULT_METADATA_BASE_URL } from "../config/constants.ts";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { isProxyAuthEnabled } from "../middleware/auth.ts";
import { getLastfmApiKey, getTicketmasterApiKey, isNewsConfigured } from "./apiClients/config.ts";
import { getDeprecatedUsage } from "./deprecatedUsage.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { getDownloadSourceStatus } from "./downloadSourceService.ts";
import { isGoogleLoginEnabled } from "./googleAuth.ts";
import { lidarrClient } from "./lidarrClient.ts";
import { logger } from "./logger.ts";
import { listAllLogProblems } from "./logs.ts";
import { getMusicDataSourceName } from "./musicDataSource/index.ts";
import { isOidcEnabled } from "./oidcAuth.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { getPlexServer } from "./plex.ts";
import { activePlugins, PLUGIN_SOURCE_PREFIX, readPlugins } from "./plugins/pluginStore.ts";
import { createDefaultQualityProfile } from "./qualityProfileModel.ts";
import { getQualityProfile } from "./qualityProfileService.ts";
import { isRunningInDocker } from "./runtimeInfo.ts";
import { SHARE_ORIGIN } from "./shareLinks/store.ts";
import { getTelemetryState, markTelemetrySent, seenSince } from "./telemetry.ts";
import { isOfficialBuild } from "./updates.ts";
import { normalizeUserThemeDocument } from "./userTheme.ts";

const GB = 1024 ** 3;

type CountRow = { key: string | null; total: number };

const countStmt = (sql: string) => db.prepare<[], { total: number }>(sql);
const scaleStmts = {
  users: countStmt("SELECT COUNT(*) AS total FROM users"),
  admins: countStmt("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'"),
  artists: countStmt("SELECT COUNT(*) AS total FROM library_artists"),
  albums: countStmt("SELECT COUNT(*) AS total FROM library_albums"),
  tracks: countStmt("SELECT COUNT(*) AS total FROM library_tracks"),
  libraryBytes: countStmt(
    "SELECT COALESCE(SUM(size), 0) AS total FROM library_media_files WHERE available = 1",
  ),
  shareLinks: countStmt("SELECT COUNT(*) AS total FROM share_links"),
};
const managedArtistsStmt = db.prepare<[], CountRow>(
  "SELECT managed_by AS key, COUNT(*) AS total FROM library_management WHERE entity_kind = 'artist' GROUP BY managed_by",
);
const listeningStmt = db.prepare<[], CountRow>(
  "SELECT provider AS key, COUNT(*) AS total FROM listen_history_sources GROUP BY provider",
);
const playbackServersStmt = db.prepare<[], CountRow>(
  "SELECT provider AS key, COUNT(*) AS total FROM history_servers GROUP BY provider",
);
const playsStmt = db.prepare<[number], CountRow>(
  "SELECT source AS key, COUNT(*) AS total FROM play_events WHERE external_id IS NULL AND played_at >= ? GROUP BY source",
);
const downloadsStmt = db.prepare<[number], CountRow & { status: string }>(
  `SELECT download_source AS key, status, COUNT(*) AS total FROM playlist_download_jobs
   WHERE status IN ('done', 'failed') AND COALESCE(completed_at, created_at) >= ?
   GROUP BY download_source, status`,
);
const userIdsStmt = db.prepare<[], { id: number }>("SELECT id FROM users");

const bucketed = (totals: Map<string, number>) =>
  Object.fromEntries([...totals].map(([key, total]) => [key, countBucket(total)]));

function bucketsFor<const Keys extends readonly string[]>(
  keys: Keys,
  rows: CountRow[],
  keyOf: (key: string) => Keys[number] | undefined = (key) => keys.find((known) => known === key),
) {
  const totals = new Map<Keys[number], number>();
  for (const row of rows) {
    const key = keyOf(String(row.key ?? ""));
    if (key) totals.set(key, (totals.get(key) ?? 0) + row.total);
  }
  return bucketed(totals);
}

function integrations() {
  const settings = dbOps.getSettings();
  const sources = getDownloadSourceStatus();
  const connected: Record<(typeof INTEGRATIONS)[number], boolean> = {
    lidarr: lidarrClient.isConfigured(),
    slskd: sources.slskd.configured,
    prowlarr: sources.usenet.prowlarrConfigured,
    nzbget: sources.usenet.nzbgetConfigured,
    sabnzbd: sources.usenet.sabnzbdConfigured,
    tidarr: getDownloadClient("tidarr").isConfigured(),
    ytdlp: sources.ytdlp.configured,
    deemix: sources.deemix.configured,
    lastfm: Boolean(getLastfmApiKey()),
    ticketmaster: Boolean(getTicketmasterApiKey()),
    gotify: Boolean(settings.integrations?.gotify?.url && settings.integrations.gotify.token),
    webhooks: (settings.integrations?.webhooks?.length ?? 0) > 0,
    plex: getPlexServer() !== null,
    customMetadata:
      (settings.integrations?.metadata?.baseUrl || DEFAULT_METADATA_BASE_URL) !==
      DEFAULT_METADATA_BASE_URL,
  };
  return INTEGRATIONS.filter((name) => connected[name]);
}

function appearance() {
  const appearances = new Map<(typeof APPEARANCES)[number], number>();
  const themes = new Map<(typeof THEME_KINDS)[number], number>();
  const add = <Key>(map: Map<Key, number>, key: Key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { id } of userIdsStmt.all()) {
    const stored = dbOps.getUserTheme(id);
    let document: ReturnType<typeof normalizeUserThemeDocument> | null = null;
    try {
      document = stored ? normalizeUserThemeDocument(stored) : null;
    } catch {}
    add(appearances, document?.appearance ?? "system");
    const themeId = document?.themeId ?? "aurral";
    add(
      themes,
      themeId === "aurral"
        ? "aurral"
        : document?.themes.some((theme) => theme.id === themeId)
          ? "custom"
          : "preset",
    );
  }
  return { appearance: bucketed(appearances), themes: bucketed(themes) };
}

async function problems(since: number) {
  const totals = new Map<(typeof LOG_CATEGORIES)[number], { warn: number; error: number }>();
  for (const problem of await listAllLogProblems(since)) {
    if (problem.level !== "warn" && problem.level !== "error") continue;
    const category = problem.cat.startsWith(PLUGIN_SOURCE_PREFIX)
      ? "plugins"
      : (LOG_CATEGORIES.find((known) => known === problem.cat) ?? "other");
    const total = totals.get(category) ?? { warn: 0, error: 0 };
    total[problem.level] += problem.count;
    totals.set(category, total);
  }
  return Object.fromEntries(
    [...totals].map(([category, total]) => [
      category,
      { warn: countBucket(total.warn), error: countBucket(total.error) },
    ]),
  );
}

export async function buildTelemetryReport(now = Date.now()): Promise<TelemetryReport> {
  const since = now - TELEMETRY_INTERVAL_MS;
  const settings = dbOps.getSettings();
  const quality = getQualityProfile();
  const managed = new Map(managedArtistsStmt.all().map((row) => [row.key, row.total]));
  const flows = flowPlaylistConfig.getFlows();
  const playlists = flowPlaylistConfig.getStaticPlaylists();
  const total = (stmt: { get: () => { total: number } | undefined }) => stmt.get()?.total ?? 0;

  const downloads: TelemetryReport["downloads"] = {};
  for (const row of downloadsStmt.all(since)) {
    const source = String(row.key ?? "").startsWith(PLUGIN_SOURCE_PREFIX)
      ? "plugin"
      : DOWNLOAD_SOURCES.find((known) => known === row.key);
    if (!source || (row.status !== "done" && row.status !== "failed")) continue;
    downloads[source] = {
      done: "0",
      failed: "0",
      ...downloads[source],
      [row.status]: countBucket(row.total),
    };
  }

  const auth: Record<(typeof AUTH_MODES)[number], boolean> = {
    oidc: isOidcEnabled(),
    proxy: isProxyAuthEnabled(),
    google: isGoogleLoginEnabled(),
    ssoOnly: settings.security?.ssoOnly === true,
    localNetworkBypass: settings.security?.localNetworkBypass?.enabled === true,
  };
  const flags: Record<(typeof SETTING_FLAGS)[number], boolean> = {
    inbox: settings.inbox?.enabled !== false,
    news: isNewsConfigured(),
    missingTrackSearch: settings.missingTrackSearch?.enabled === true,
    qualityUpgrades: quality.automaticUpgrades,
    customQuality: !isDeepStrictEqual(
      quality,
      createDefaultQualityProfile(settings.integrations?.slskd),
    ),
    favoriteAutoKeep: settings.subsonic?.favoriteAutoKeep !== false,
    pathMappings: settings.pathMappings.length > 0,
  };

  const deprecations = getDeprecatedUsage()
    .filter((usage) => usage.lastSeenAt === null || usage.lastSeenAt >= since)
    .map((usage) => DEPRECATION_KINDS.find((kind) => kind === usage.kind))
    .filter((kind) => kind !== undefined);

  return {
    schema: 1,
    version: APP_VERSION,
    docker: await isRunningInDocker(),
    os:
      (["linux", "darwin", "win32", "freebsd"] as const).find((os) => os === process.platform) ??
      "other",
    arch: (["x64", "arm64", "arm"] as const).find((arch) => arch === process.arch) ?? "other",
    scale: {
      users: countBucket(total(scaleStmts.users)),
      admins: countBucket(total(scaleStmts.admins)),
      artists: countBucket(total(scaleStmts.artists)),
      albums: countBucket(total(scaleStmts.albums)),
      tracks: countBucket(total(scaleStmts.tracks)),
      libraryGb: countBucket(Math.floor(total(scaleStmts.libraryBytes) / GB)),
      aurralArtists: countBucket(managed.get("aurral") ?? 0),
      lidarrArtists: countBucket(managed.get("lidarr") ?? 0),
      flows: countBucket(flows.length),
      playlists: countBucket(playlists.length),
      shareLinks: countBucket(total(scaleStmts.shareLinks)),
      plugins: countBucket(readPlugins().filter((plugin) => plugin.manifest).length),
      activePlugins: countBucket(activePlugins().length),
    },
    integrations: integrations(),
    auth: AUTH_MODES.filter((mode) => auth[mode]),
    settings: SETTING_FLAGS.filter((flag) => flags[flag]),
    dateTimeFormat:
      DATE_TIME_FORMATS.find((format) => format === settings.dateTimeFormat) ?? "browser",
    discovery: DISCOVERY_SOURCES.find((name) => name === getMusicDataSourceName()) ?? "lastfm",
    listening: bucketsFor(LISTEN_SOURCES, listeningStmt.all()),
    playbackServers: bucketsFor(PLAYBACK_SERVERS, playbackServersStmt.all()),
    plays: bucketsFor(PLAY_SOURCES, playsStmt.all(since), (key) =>
      key === "native-player" ? "aurral" : key === "subsonic" ? "subsonic" : "other",
    ),
    downloads,
    imports: bucketsFor(
      IMPORT_SOURCES,
      playlists.map((playlist) => ({ key: playlist.importSource?.provider ?? null, total: 1 })),
      (key) =>
        key.startsWith(PLUGIN_SOURCE_PREFIX)
          ? "plugin"
          : IMPORT_SOURCES.find((known) => known === key),
    ),
    ...appearance(),
    seen: seenSince(since),
    problems: await problems(since),
    deprecations,
  };
}

export async function sendTelemetryReport(now = Date.now()) {
  const state = getTelemetryState();
  if (!state.enabled || !isOfficialBuild()) return false;
  if (state.lastSentAt !== null && now - state.lastSentAt < TELEMETRY_INTERVAL_MS) return false;
  try {
    const response = await fetch(`${SHARE_ORIGIN}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await buildTelemetryReport(now)),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`aurral.org answered ${response.status}`);
    markTelemetrySent(now);
    return true;
  } catch (error) {
    logger.debug("system", "Could not send usage stats to aurral.org:", {
      message: asAppError(error)?.message,
    });
    return false;
  }
}
