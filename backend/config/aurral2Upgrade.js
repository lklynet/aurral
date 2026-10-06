import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { PLAYLIST_FILES_DIR, resolveDownloadRoot } from "../services/downloadPaths.js";
import { StartupRefusal } from "./startupRefusal.js";

const RETIRED_SETTING_PATTERNS = [
  "migration:*",
  "news:rssState",
  "user:*:newsPreferences",
  "aurral3Readiness",
  "storedDataMigration",
  "identityMarkerMigration",
  "playlistStartupMigration",
  "aurralDownloadFolderMigration",
  "deprecatedUsage",
  "playlistMediaRelocation:*",
  "weeklyFlows",
  "weeklyFlowWorker",
  "weeklyFlowPlaylists",
  "sharedFlowPlaylists",
];
const AURRAL_2_PLAYLIST_FILES_DIR = "aurral-weekly-flow";
const KEPT_PLAYLIST_FILE_EXTENSIONS = new Set([".webp", ".jpg", ".no-artwork"]);
const RETIRED_PLAYLIST_FILE_EXTENSIONS = new Set([".png", ".m3u", ".nsp"]);

function readSetting(db, key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

function readDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function moveFile(source, target) {
  if (fs.existsSync(target)) {
    fs.rmSync(source, { force: true });
    return;
  }
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fs.copyFileSync(source, target);
    fs.rmSync(source, { force: true });
  }
}

function removeEmptyDirectories(directory) {
  for (const entry of readDirectory(directory)) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (readDirectory(directory).length === 0) fs.rmSync(directory, { recursive: true, force: true });
}

function movePlaylistFiles(downloadRoot, log) {
  const oldRoot = path.join(downloadRoot, AURRAL_2_PLAYLIST_FILES_DIR);
  const oldFiles = path.join(oldRoot, "_playlists");
  const newFiles = path.join(downloadRoot, PLAYLIST_FILES_DIR);
  let moved = 0;
  for (const entry of readDirectory(oldFiles)) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const source = path.join(oldFiles, entry.name);
    if (KEPT_PLAYLIST_FILE_EXTENSIONS.has(extension)) {
      fs.mkdirSync(newFiles, { recursive: true });
      moveFile(source, path.join(newFiles, entry.name));
      moved += 1;
    } else if (RETIRED_PLAYLIST_FILE_EXTENSIONS.has(extension)) {
      fs.rmSync(source, { force: true });
    }
  }
  if (fs.existsSync(oldRoot)) removeEmptyDirectories(oldRoot);
  if (moved > 0) log(`Moved ${moved} playlist artwork file(s) to ${newFiles}`);
  if (fs.existsSync(oldRoot)) log(`${oldRoot} still holds files that Aurral does not use. Review and remove them.`);
}

export function moveAurral2Files(db, { dataDir, env = process.env, log = () => {} } = {}) {
  const downloadRoot = path.resolve(
    resolveDownloadRoot(readSetting(db, "downloadFolderPath") || env.DOWNLOAD_FOLDER),
  );
  try {
    movePlaylistFiles(downloadRoot, log);
    fs.rmSync(path.join(dataDir, ".image-cache-links-v1"), { force: true });
  } catch (error) {
    throw new StartupRefusal(
      `Could not move Aurral 2 playlist files in ${downloadRoot}: ${error.message}. Fix the folder permissions, then start Aurral again.`,
    );
  }
}

function removeRetiredIntegrations(db) {
  const integrations = JSON.parse(readSetting(db, "integrations") || "null");
  if (!integrations || typeof integrations !== "object") return;
  delete integrations.soulseek;
  delete integrations.coverArtArchive;
  delete integrations.musicbrainz;
  if (integrations.navidrome) {
    delete integrations.navidrome.m3uPathMode;
    delete integrations.navidrome.pathMappings;
  }
  if (integrations.lastfm) delete integrations.lastfm.discoverFlowArtworkStyle;
  if (integrations.general) {
    delete integrations.general.authUser;
    delete integrations.general.authPassword;
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'integrations'").run(JSON.stringify(integrations));
}

const LIBRARY_OWNER = "library";

function readJsonSetting(db, key, fallback) {
  try {
    return JSON.parse(readSetting(db, key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

const text = (value) => String(value ?? "").trim();
const trackIdentity = (track) => [
  text(track.artistName ?? track.artist_name).toLowerCase(),
  text(track.trackName ?? track.track_name).toLowerCase(),
  text(track.albumName ?? track.album_name).toLowerCase(),
  text(track.artistMbid ?? track.artist_mbid),
  text(track.albumMbid ?? track.album_mbid),
  text(track.trackMbid ?? track.track_mbid),
  text(track.releaseYear ?? track.release_year),
].join("\u0001");
const coreIdentity = (track) => [
  text(track.artistName ?? track.artist_name).toLowerCase(),
  text(track.trackName ?? track.track_name).toLowerCase(),
].join("\u0001");

function trackFromJob(job) {
  return {
    artistName: job.artist_name,
    trackName: job.track_name,
    albumName: job.album_name || null,
    artistMbid: job.artist_mbid || null,
    albumMbid: job.album_mbid || null,
    trackMbid: job.track_mbid || null,
    releaseYear: job.release_year || null,
    durationMs: job.duration_ms ?? null,
    artistAliases: (() => {
      try {
        return JSON.parse(job.artist_aliases || "[]");
      } catch {
        return [];
      }
    })(),
    reason: job.reason || null,
    jobId: job.id,
    membershipId: randomUUID(),
  };
}

function readStaticPlaylists(db) {
  return readJsonSetting(db, "sharedPlaylists", []).map((playlist) => ({
    ...playlist,
    tracks: (Array.isArray(playlist?.tracks) ? playlist.tracks : []).map(({ canonicalJobId, ...track }) =>
      canonicalJobId ? { ...track, jobId: canonicalJobId } : track),
  }));
}

function linkPlaylistTracks(playlist, jobs) {
  const tracks = playlist.tracks.map((track) => ({ ...track }));
  for (const job of jobs) {
    const track =
      tracks.find((entry) => !entry.jobId && trackIdentity(entry) === trackIdentity(job)) ||
      tracks.find((entry) => !entry.jobId && coreIdentity(entry) === coreIdentity(job));
    if (track) track.jobId = job.id;
    else tracks.push(trackFromJob(job));
  }
  return { ...playlist, tracks, trackCount: tracks.length };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function moveStaticPlaylistJobsIntoLibrary(db) {
  db.exec("ALTER TABLE playlist_download_jobs ADD COLUMN queued_for_playlist INTEGER NOT NULL DEFAULT 0");
  const playlists = readStaticPlaylists(db);
  const flowIds = new Set(readJsonSetting(db, "flows", []).map((flow) => flow?.id).filter(Boolean));
  const staticIds = new Set(playlists.map((playlist) => playlist?.id).filter(Boolean));
  const isMoved = (owner) => owner !== LIBRARY_OWNER && !flowIds.has(owner);
  const libraryGeneration = Number(
    db.prepare("SELECT generation FROM weekly_flow_download_cancellations WHERE playlist_id = ?").get(LIBRARY_OWNER)?.generation || 0,
  );
  const jobs = db.prepare("SELECT * FROM playlist_download_jobs ORDER BY created_at, id").all()
    .filter((job) => isMoved(job.playlist_id || job.playlist_type));
  const deletedJobIds = new Set();
  const movedJobIds = new Set();
  const jobsByPlaylist = new Map();
  const moveJob = db.prepare(`
    UPDATE playlist_download_jobs
    SET playlist_id = ?, playlist_type = ?, playlist_generation = ?, queued_for_playlist = ?
    WHERE id = ?
  `);
  for (const job of jobs) {
    const owner = job.playlist_id || job.playlist_type;
    const upgrade = job.playlist_type === "quality-upgrade";
    const unfinished = job.status !== "done";
    if (!staticIds.has(owner) && unfinished) {
      db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(job.id);
      deletedJobIds.add(job.id);
      continue;
    }
    const queuedForPlaylist = staticIds.has(owner) && !upgrade && (unfinished || Boolean(job.download_client));
    moveJob.run(LIBRARY_OWNER, upgrade ? "quality-upgrade" : LIBRARY_OWNER, libraryGeneration, queuedForPlaylist ? 1 : 0, job.id);
    movedJobIds.add(job.id);
    if (staticIds.has(owner) && !upgrade) {
      jobsByPlaylist.set(owner, [...(jobsByPlaylist.get(owner) || []), job]);
    }
  }
  const nextPlaylists = playlists.map((playlist) =>
    jobsByPlaylist.has(playlist.id) ? linkPlaylistTracks(playlist, jobsByPlaylist.get(playlist.id)) : playlist);
  db.prepare("DELETE FROM settings WHERE key = 'sharedPlaylists'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('staticPlaylists', ?)").run(JSON.stringify(nextPlaylists));
  db.prepare("DELETE FROM weekly_flow_download_cancellations WHERE playlist_id != ? AND playlist_id NOT IN (SELECT value FROM json_each(?))")
    .run(LIBRARY_OWNER, JSON.stringify([...flowIds]));
  const moveProviderWork = db.prepare("UPDATE weekly_flow_download_provider_work SET playlist_id = ? WHERE job_id = ?");
  for (const jobId of movedJobIds) moveProviderWork.run(LIBRARY_OWNER, jobId);
  for (const jobId of deletedJobIds) {
    db.prepare("DELETE FROM weekly_flow_download_provider_work WHERE job_id = ?").run(jobId);
  }
  if (!hasTable(db, "_honker_live")) return;
  for (const row of db.prepare("SELECT id, payload FROM _honker_live WHERE queue = 'slskd-pipeline'").all()) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (deletedJobIds.has(payload?.jobId)) {
      db.prepare("DELETE FROM _honker_live WHERE id = ?").run(row.id);
    } else if (movedJobIds.has(payload?.jobId) && isMoved(payload.playlistId)) {
      db.prepare("UPDATE _honker_live SET payload = ? WHERE id = ?").run(
        JSON.stringify({ ...payload, playlistId: LIBRARY_OWNER, playlistGeneration: libraryGeneration }),
        row.id,
      );
    }
  }
}

const RENAMED_TASK_KINDS = {
  "weekly-flow-refresh": "flow-refresh",
  "weekly-flow-startup-check": "flow-startup-check",
  "weekly-flow-reuse-repair": "file-reuse-repair",
  "weekly-flow-startup-reuse-repair": "startup-file-reuse-repair",
};

const renamePrefix = (value, from, to) =>
  typeof value === "string" && value.startsWith(from) ? `${to}${value.slice(from.length)}` : value;

function renameQueuedWork(db) {
  const insertToken = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const row of db.prepare("SELECT key, value FROM settings WHERE key GLOB 'weeklyFlowOperationTokens:*'").all()) {
    insertToken.run(renamePrefix(row.key, "weeklyFlowOperationTokens:", "playlistOperationTokens:"), row.value);
  }
  for (const [scope, token] of Object.entries(readJsonSetting(db, "weeklyFlowOperationTokens", {}))) {
    insertToken.run(`playlistOperationTokens:${encodeURIComponent(scope)}`, JSON.stringify(token));
  }
  db.prepare("DELETE FROM settings WHERE key GLOB 'weeklyFlowOperationTokens*' OR key = 'weeklyFlowIncompleteRetryJobs'").run();
  if (!hasTable(db, "_honker_live")) return;
  db.prepare("DELETE FROM _honker_live WHERE queue IN ('playlist-retry', 'playlist-reserve-build')").run();
  db.prepare("UPDATE _honker_live SET queue = 'playlist-operation' WHERE queue = 'weekly-flow-operation'").run();
  db.prepare(`
    UPDATE _honker_live SET queue = 'release-metadata-refresh', state = 'pending', worker_id = NULL, claim_expires_at = NULL
    WHERE queue = 'system-task' AND json_extract(payload, '$.kind') = 'release-metadata-refresh'
  `).run();
  const updatePayload = db.prepare("UPDATE _honker_live SET payload = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, payload FROM _honker_live").all()) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    if (payload.kind === "reset-playlists") {
      const { playlistTypes, ...rest } = payload;
      updatePayload.run(JSON.stringify({ ...rest, kind: "reset-flows", flowIds: playlistTypes }), row.id);
      continue;
    }
    const kind = RENAMED_TASK_KINDS[payload.kind] || renamePrefix(payload.kind, "shared-playlist-", "static-playlist-");
    const label = renamePrefix(payload.label, "shared-playlist:", "static-playlist:");
    if (kind !== payload.kind || label !== payload.label) {
      updatePayload.run(JSON.stringify({ ...payload, kind, ...(label === undefined ? {} : { label }) }), row.id);
    }
  }
}

function renameDownloadTables(db) {
  db.exec(`
    DELETE FROM playlist_download_jobs WHERE playlist_type = 'quality-upgrade' AND upgrade_for_job_id IS NULL;
    UPDATE playlist_download_jobs SET playlist_id = playlist_type
    WHERE playlist_id = '' AND playlist_type IS NOT NULL AND playlist_type != 'quality-upgrade';
    UPDATE playlist_download_jobs SET playlist_id = COALESCE((
      SELECT source.playlist_id FROM playlist_download_jobs AS source
      WHERE source.id = playlist_download_jobs.upgrade_for_job_id
    ), '') WHERE playlist_id = '' AND upgrade_for_job_id IS NOT NULL;
    DROP TRIGGER IF EXISTS playlist_download_jobs_revision_insert;
    DROP TRIGGER IF EXISTS playlist_download_jobs_revision_update;
    DROP TRIGGER IF EXISTS playlist_download_jobs_revision_delete;
    DROP TRIGGER IF EXISTS playlist_download_attempt_delete;
    DROP TRIGGER IF EXISTS playlist_download_attempt_complete;
    DROP INDEX IF EXISTS idx_playlist_download_jobs_status;
    DROP INDEX IF EXISTS idx_playlist_download_jobs_playlist_id;
    DROP INDEX IF EXISTS idx_playlist_download_jobs_request_group;
    DROP INDEX IF EXISTS idx_weekly_flow_download_job_cancellations_time;
    DROP INDEX IF EXISTS idx_weekly_flow_download_provider_work_job;
    DROP INDEX IF EXISTS idx_weekly_flow_download_provider_work_playlist;
    ALTER TABLE playlist_download_jobs RENAME TO download_jobs;
    ALTER TABLE download_jobs RENAME COLUMN playlist_id TO owner_id;
    ALTER TABLE download_jobs RENAME COLUMN playlist_generation TO owner_generation;
    ALTER TABLE download_jobs DROP COLUMN playlist_type;
    ALTER TABLE playlist_download_jobs_revision RENAME TO download_jobs_revision;
    ALTER TABLE weekly_flow_download_cancellations RENAME TO download_owner_cancellations;
    ALTER TABLE download_owner_cancellations RENAME COLUMN playlist_id TO owner_id;
    ALTER TABLE weekly_flow_download_job_cancellations RENAME TO download_job_cancellations;
    ALTER TABLE weekly_flow_download_provider_work RENAME TO download_provider_work;
    ALTER TABLE download_provider_work RENAME COLUMN playlist_id TO owner_id;
    DELETE FROM settings WHERE key GLOB 'downloadJobTransfers:*';
  `);
  const flowIds = new Set(readJsonSetting(db, "flows", []).map((flow) => flow?.id).filter(Boolean));
  for (const { key } of db.prepare("SELECT key FROM settings WHERE key GLOB 'playlistCancellationWork:*'").all()) {
    const ownerId = key.slice("playlistCancellationWork:".length);
    if (ownerId === LIBRARY_OWNER || flowIds.has(ownerId)) {
      db.prepare("UPDATE settings SET key = ? WHERE key = ?").run(`ownerCancellationWork:${ownerId}`, key);
    } else {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    }
  }
  if (!hasTable(db, "_honker_live")) return;
  const updatePayload = db.prepare("UPDATE _honker_live SET payload = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, payload FROM _honker_live WHERE queue = 'slskd-pipeline'").all()) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const { playlistId, playlistGeneration, ...rest } = payload;
    updatePayload.run(JSON.stringify({ ...rest, ownerId: playlistId, ownerGeneration: playlistGeneration }), row.id);
  }
}

export function upgradeFromAurral2(db) {
  const removeSettings = db.prepare("DELETE FROM settings WHERE key GLOB ?");
  for (const pattern of RETIRED_SETTING_PATTERNS) removeSettings.run(pattern);
  removeRetiredIntegrations(db);
  moveStaticPlaylistJobsIntoLibrary(db);
  renameQueuedWork(db);
  renameDownloadTables(db);
  db.exec(`
    UPDATE users SET permissions = replace(permissions, '"accessFlow"', '"accessPlaylists"');
    UPDATE settings SET value = replace(value, '"notifyWeeklyFlowDone"', '"notifyFlowDone"') WHERE key = 'integrations';
  `);
  if (hasTable(db, "_honker_live")) {
    db.exec(`
      UPDATE _honker_live SET payload = replace(payload, '"notifyWeeklyFlowDone"', '"notifyFlowDone"')
      WHERE queue = 'notification-outbox';
    `);
  }
  db.exec(`
    ALTER TABLE users DROP COLUMN needs_identity_migration;
    ALTER TABLE users DROP COLUMN allow_identity_adoption;
  `);
  db.exec(`
    DELETE FROM discovery_cache
    WHERE key = 'topTags' OR key LIKE '%fallbackGenres' OR key LIKE '%fallbackGenrePools';
    UPDATE discovery_cache SET value = 'listenbrainz' WHERE key = 'provider' AND value = 'listenbrainz-fallback';
  `);
  db.exec(`
    DELETE FROM images_cache
    WHERE image_url LIKE 'http://archive.org/%'
       OR image_url LIKE 'https://archive.org/%'
       OR image_url GLOB 'http*://*.ca.archive.org/*';
  `);
}
