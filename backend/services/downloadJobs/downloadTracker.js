import { randomUUID } from "crypto";
import path from "node:path";
import { db } from "../../config/db-sqlite.js";
import { enqueuePipelineJob, listHonkerJobs } from "../honkerDb.js";
import {
  getQuickSearchSources,
  isAlbumGrabSourceConfigured,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.js";
import {
  normalizePositiveInteger,
  normalizeStringList,
  parseStringListJson,
  sanitizePathPart,
  stringifyStringListJson,
} from "../downloadUtils.js";
import {
  buildAurralTrackDestination,
} from "../downloadPaths.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import { isPlaylistOwnerActive } from "./playlistOwnerStatus.js";
import { logger } from "../logger.js";
import { recordAlbumGrabQueued, recordAlbumTrackState } from "../albumGrabActivity.js";
import { mapRequest } from "../releaseManifest.js";
import {
  cancelDownloadJob,
  beginDownloadAttempt,
  getActiveDownloadAttemptId,
  setActiveDownloadAttemptId,
  cancelDownloadJobs,
  getPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
} from "./downloadCancellation.js";

export const NO_RELEASE_REASON = "The requested release could not be resolved; searching for the track";
export const OFF_RELEASE_REASON = "Track is not on the requested release; searching for the track";

const parseDeniedSources = (raw) => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const JOBS_TABLE = "playlist_download_jobs";
const dataVersionStmt = db.prepare("PRAGMA data_version");
const persistedRevisionStmt = db.prepare(
  "SELECT revision FROM playlist_download_jobs_revision WHERE id = 1",
);
const liveJobStmt = db.prepare(`SELECT * FROM ${JOBS_TABLE} WHERE id = ?`);
const livePlaylistJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE playlist_type = ? ORDER BY created_at, id`,
);
const livePlaylistIdJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE}
   WHERE playlist_id = ? OR playlist_type = ?
   ORDER BY created_at, id`,
);
const livePlaylistJobsLimitedStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE playlist_type = ? ORDER BY created_at, id LIMIT ?`,
);
const liveStatusJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status = ? ORDER BY created_at, id`,
);
const liveStatsStmt = db.prepare(
  `SELECT playlist_type, status, COUNT(*) AS count FROM ${JOBS_TABLE} GROUP BY playlist_type, status`,
);
const liveNextPendingStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status = 'pending' AND upgrade_for_job_id IS NULL
   ORDER BY created_at, id LIMIT 1`,
);
const liveDoneWithPathStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status = 'done' AND final_path IS NOT NULL
   ORDER BY created_at, id LIMIT ?`,
);
const livePendingStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status = 'pending' AND upgrade_for_job_id IS NULL
   ORDER BY created_at, id LIMIT ?`,
);
const liveActivePlaylistStmt = db.prepare(
  `SELECT 1 FROM ${JOBS_TABLE} WHERE playlist_type = ?
   AND status IN ('pending', 'downloading') LIMIT 1`,
);
const liveActivePlaylistJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status IN ('pending', 'downloading')
   AND COALESCE(NULLIF(playlist_type, ''), playlist_id) = ?
   ORDER BY created_at, id`,
);
const liveAlbumJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE album_mbid IS NOT NULL AND album_mbid != ''`,
);

function parseHeldForReview(value) {
  try {
    const held = JSON.parse(value || "null");
    return held?.sourcePath ? held : null;
  } catch {
    return null;
  }
}

function rowToJob(row) {
  return {
    id: row.id,
    artistName: row.artist_name,
    trackName: row.track_name,
    albumName: row.album_name || null,
    reason: row.reason || null,
    artistMbid: row.artist_mbid || null,
    albumMbid: row.album_mbid || null,
    releaseMbid: row.release_mbid || null,
    trackMbid: row.track_mbid || null,
    releaseYear: row.release_year || null,
    durationMs:
      row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
        ? Number(row.duration_ms)
        : null,
    trackNumber: normalizePositiveInteger(row.track_number),
    discNumber: normalizePositiveInteger(row.disc_number),
    albumTrackCount: normalizePositiveInteger(row.album_track_count),
    albumTrackTitles: parseStringListJson(row.album_track_titles),
    artistAliases: parseStringListJson(row.artist_aliases),
    playlistId: row.playlist_id || row.playlist_type,
    playlistGeneration: Number(row.playlist_generation ?? 0),
    playlistType: row.playlist_type || row.playlist_id,
    managedBy: row.managed_by === "lidarr" ? "lidarr" : "aurral",
    requestGroupId: row.request_group_id || null,
    requestKind: row.request_kind === "album" ? "album" : "track",
    albumGrabAttempted: row.album_grab_attempted === 1,
    quickSearchedSources: parseStringListJson(row.quick_searched_sources),
    heldForReview: parseHeldForReview(row.held_for_review),
    albumGrabFailures: Number(row.album_grab_failures) || 0,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    stagingPath: row.staging_path,
    finalPath: row.final_path,
    externalPath: row.external_path || null,
    error: row.error,
    createdAt: row.created_at,
    downloadSource: row.download_source || null,
    downloadClient: row.download_client || null,
    downloadClientId: row.download_client_id || null,
    releaseGuid: row.release_guid || null,
    releaseTitle: row.release_title || null,
    indexerId: row.indexer_id || null,
    indexerName: row.indexer_name || null,
    slskdSearchId: row.slskd_search_id || null,
    slskdBatchId: row.slskd_batch_id || null,
    remoteUsername: row.remote_username || null,
    remoteFilename: row.remote_filename || null,
    deniedRemoteSources: parseDeniedSources(row.denied_remote_sources),
    qualityTier: row.quality_tier || null,
    qualityFormat: row.quality_format || null,
    qualityBitrateKbps: row.quality_bitrate_kbps ?? null,
    qualitySampleRate: row.quality_sample_rate_hz ?? null,
    qualityBitDepth: row.quality_bit_depth ?? null,
    qualityCheckedAt: row.quality_checked_at ?? null,
    qualityUpgradeCheckedAt: row.quality_upgrade_checked_at ?? null,
    upgradeForJobId: row.upgrade_for_job_id || null,
    manualReplacementSearch: row.manual_replacement_search === 1,
    retryCycle: false,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO ${JOBS_TABLE} (
    id,
    artist_name,
    track_name,
    album_name,
    reason,
    artist_mbid,
    album_mbid,
    release_mbid,
    track_mbid,
    release_year,
    duration_ms,
    track_number,
    disc_number,
    album_track_count,
    album_track_titles,
    artist_aliases,
    playlist_id,
    playlist_generation,
    playlist_type,
    managed_by,
    request_group_id,
    status,
    staging_path,
    final_path,
    external_path,
    error,
    started_at,
    completed_at,
    created_at,
    quality_tier,
    quality_format,
    quality_bitrate_kbps,
    quality_sample_rate_hz,
    quality_bit_depth,
    quality_checked_at,
    quality_upgrade_checked_at,
    upgrade_for_job_id,
    manual_replacement_search,
    request_kind
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET status = ?,
      staging_path = ?,
      final_path = ?,
      external_path = ?,
      error = ?,
      started_at = ?,
      completed_at = ?,
      album_name = ?,
      reason = ?,
      artist_mbid = ?,
      album_mbid = ?,
      release_mbid = ?,
      track_mbid = ?,
      release_year = ?,
      duration_ms = ?,
      track_number = ?,
      disc_number = ?,
      album_track_count = ?,
      album_track_titles = ?,
      artist_aliases = ?,
      quality_tier = ?,
      quality_format = ?,
      quality_bitrate_kbps = ?,
      quality_sample_rate_hz = ?,
      quality_bit_depth = ?,
      quality_checked_at = ?,
      quality_upgrade_checked_at = ?,
      upgrade_for_job_id = ?,
      manual_replacement_search = ?
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`);
const updateAlbumGrabAttemptedStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET album_grab_attempted = ? WHERE id = ?`,
);
const updateQuickSearchedSourcesStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET quick_searched_sources = ? WHERE id = ?`,
);
const updateHeldForReviewStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET held_for_review = ? WHERE id = ?`,
);
const updateRequestKindStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET request_kind = ? WHERE id = ?`,
);
const updateAlbumGrabFailuresStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET album_grab_failures = ? WHERE id = ?`,
);
const deleteAllStmt = db.prepare(`DELETE FROM ${JOBS_TABLE}`);
const selectAllStmt = db.prepare(`SELECT * FROM ${JOBS_TABLE} ORDER BY created_at ASC, id ASC`);
const updatePlaylistTypeStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET playlist_type = ?, playlist_id = ? WHERE playlist_type = ?`,
);
const clearSlskdMetaStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET download_source = NULL,
      download_client = NULL,
      download_client_id = NULL,
      release_guid = NULL,
      release_title = NULL,
      indexer_id = NULL,
      indexer_name = NULL,
      slskd_search_id = NULL,
      slskd_batch_id = NULL,
      remote_username = NULL,
      remote_filename = NULL
  WHERE id = ?
`);

const clearTransientPipelineMetaStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET slskd_search_id = NULL,
      slskd_batch_id = NULL
  WHERE id = ?
`);

const updateDownloadMetaStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET download_source = ?,
      download_client = ?,
      download_client_id = ?,
      release_guid = ?,
      release_title = ?,
      indexer_id = ?,
      indexer_name = ?,
      remote_username = ?,
      remote_filename = ?
  WHERE id = ?
`);

const DOWNLOAD_METADATA_KEYS = [
  "downloadSource",
  "downloadClient",
  "downloadClientId",
  "releaseGuid",
  "releaseTitle",
  "indexerId",
  "indexerName",
  "remoteUsername",
  "remoteFilename",
];

const updateDeniedSourcesStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET denied_remote_sources = ?
  WHERE id = ?
`);

const sortByCreatedAt = (jobs) =>
  jobs.sort((a, b) => {
    const aCreated = Number(a?.createdAt ?? 0);
    const bCreated = Number(b?.createdAt ?? 0);
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

// The order upgrade release attempts started in, by attempt ID, while each
// still downloads its release.
const upgradeAttemptOrder = new Map();
const MAX_UPGRADE_ATTEMPTS_ORDERED = 1000;
let upgradeAttemptsStarted = 0;

function orderUpgradeAttempt(attemptId) {
  upgradeAttemptOrder.set(attemptId, ++upgradeAttemptsStarted);
  if (upgradeAttemptOrder.size > MAX_UPGRADE_ATTEMPTS_ORDERED) {
    upgradeAttemptOrder.delete(upgradeAttemptOrder.keys().next().value);
  }
}

// A job that ended and is asked for again searches its quick sources again.
const ENDED_STATUSES = new Set(["done", "failed", "cancelled", "blocked"]);
const triesRelease = (job) => !job.manualReplacementSearch && !job.albumGrabAttempted;
const searchesByRelease = (job) => Boolean(job?.albumMbid) && triesRelease(job);

function buildPipelinePayload(job) {
  const playlistId = job.playlistId || job.playlistType;
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
  const ephemeral = Boolean(
    flowPlaylistConfig.getFlow(String(job.playlistId || job.playlistType || "").trim()),
  );
  return {
    phase: "search",
    downloadAttemptId: beginDownloadAttempt(job.id),
    jobId: job.id,
    playlistId,
    playlistGeneration: job.playlistGeneration,
    track: {
      artistName: job.artistName,
      trackName: job.trackName,
      albumName: job.albumName,
      artistMbid: job.artistMbid,
      albumMbid: job.albumMbid,
      releaseMbid: job.releaseMbid || null,
      trackMbid: job.trackMbid,
      releaseYear: job.releaseYear,
      durationMs: job.durationMs,
      trackNumber: job.trackNumber,
      discNumber: job.discNumber,
      albumTrackCount: job.albumTrackCount,
      albumTrackTitles: job.albumTrackTitles || [],
      artistAliases: job.artistAliases || [],
      recordingMbidAliases: job.recordingMbidAliases || [],
    },
    attempt: 0,
    destination: buildAurralTrackDestination(playlistId, artistDir, albumDir, { ephemeral }),
    upgrade: Boolean(job.upgradeForJobId) && !job.manualReplacementSearch,
    upgradeForJobId: job.upgradeForJobId || null,
    manualReplacementSearch: job.manualReplacementSearch === true,
    allowedSources:
      job.upgradeForJobId && !job.manualReplacementSearch
        ? ["slskd", "usenet", "deemix"]
        : null,
    triedSources: [...job.quickSearchedSources],
    heldForReview: job.heldForReview,
  };
}

// The files these jobs hold for review: a blocked job's file, unless only
// the file a job keeps while it searches on is wanted.
function discardReviewFiles(jobs, { heldOnly = false } = {}) {
  const reviewed = heldOnly ? [] : jobs.filter((job) => job?.status === "blocked" && job.stagingPath)
    .map((job) => ({ ...job }));
  const held = jobs.filter((job) => job?.heldForReview && job.heldForReview.sourcePath !== job.stagingPath)
    .map((job) => [job.id, job.heldForReview]);
  if (reviewed.length === 0 && held.length === 0) return;
  import("./reviewFiles.js")
    .then(async ({ discardReviewFile, discardHeldFile }) => {
      for (const job of reviewed) await discardReviewFile(job);
      for (const [jobId, file] of held) await discardHeldFile(jobId, file);
    })
    .catch((error) => {
      logger.warn("downloads", "Could not remove files held for review", {
        reason: error?.message || String(error),
      });
    });
}

export class DownloadTracker {
  constructor({ enqueuePipeline = enqueuePipelineJob } = {}) {
    this.enqueuePipeline = enqueuePipeline;
    this.jobs = new Map();
    this.statsByPlaylistType = new Map();
    this.globalStats = this._emptyStats();
    this.pendingFreshQueue = [];
    this.pendingRetryQueue = [];
    this.pendingSet = new Set();
    this.pendingRetrySet = new Set();
    this.slskdDispatched = new Set();
    this.revision = 0;
    this._load();
    this.externalDataVersion = dataVersionStmt.get()?.data_version;
    this.externalJobsRevision = persistedRevisionStmt.get()?.revision;
  }

  _refreshExternalChanges() {
    if (this.externalDataVersion === undefined) return;
    if (process.env.NODE_ENV === "test" || process.env.AURRAL_TEST_SERVER === "1") return;
    const version = dataVersionStmt.get()?.data_version;
    if (version === this.externalDataVersion) return;
    this.externalDataVersion = version;
    const jobsRevision = persistedRevisionStmt.get()?.revision;
    if (jobsRevision === this.externalJobsRevision) return;
    this.externalJobsRevision = jobsRevision;
    this.reconcileCommittedJobs();
  }

  reconcileCommittedJobs(redirects = []) {
    const previousJobs = this.jobs;
    const previousRetryIds = this.pendingRetrySet;
    const nextJobs = new Map();
    for (const row of selectAllStmt.all()) {
      const fresh = rowToJob(row);
      const previous = previousJobs.get(fresh.id);
      fresh.retryCycle = previous?.retryCycle === true || previousRetryIds.has(fresh.id);
      if (previous) Object.assign(previous, fresh);
      nextJobs.set(fresh.id, previous || fresh);
    }
    this.jobs = nextJobs;
    this.slskdDispatched = new Set(
      [...this.slskdDispatched].filter((id) => nextJobs.has(id)),
    );
    for (const { fromJobId, toJobId, dispatched } of redirects) {
      this.slskdDispatched.delete(fromJobId);
      if (dispatched && nextJobs.has(toJobId)) this.slskdDispatched.add(toJobId);
    }
    this._rebuildStatsByPlaylistType();
    for (const id of previousRetryIds) {
      const job = nextJobs.get(id);
      if (!job || job.status !== "pending") continue;
      this.pendingRetrySet.add(id);
      this.pendingFreshQueue = this.pendingFreshQueue.filter((entry) => entry !== id);
      this.pendingRetryQueue.push(id);
    }
    this._touchRevision();
    this.externalDataVersion = dataVersionStmt.get()?.data_version;
    this.externalJobsRevision = persistedRevisionStmt.get()?.revision;
  }

  _touchRevision() {
    this.revision += 1;
  }

  isSlskdDispatched(id) {
    const job = this.jobs.get(id);
    return this.slskdDispatched.has(id) || !!job?.slskdBatchId || !!job?.slskdSearchId;
  }

  setAlbumGrabAttempted(id, attempted) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.albumGrabAttempted = attempted === true;
    updateAlbumGrabAttemptedStmt.run(job.albumGrabAttempted ? 1 : 0, id);
    return true;
  }

  // A quick source counts as searched once its search ends, so a search cut
  // off by a restart runs again.
  recordQuickSearched(id, source) {
    const job = this.jobs.get(id);
    if (!job || job.quickSearchedSources.includes(source)) return false;
    this._setQuickSearchedSources(job, [...job.quickSearchedSources, source]);
    return true;
  }

  _setQuickSearchedSources(job, sources) {
    job.quickSearchedSources = sources;
    updateQuickSearchedSourcesStmt.run(JSON.stringify(sources), job.id);
  }

  // A file a source holds for review stays with the job until the job ends,
  // so a restart or an attempt that hands the job back does not lose it. The
  // job's next attempt carries it on.
  keepHeldForReview(id, held) {
    const job = this.jobs.get(id);
    if (!job || ENDED_STATUSES.has(job.status) || !held?.sourcePath) return false;
    if (job.heldForReview?.sourcePath === held.sourcePath) return true;
    this._setHeldForReview(job, held);
    return true;
  }

  _setHeldForReview(job, held) {
    job.heldForReview = held;
    updateHeldForReviewStmt.run(held ? JSON.stringify(held) : null, job.id);
  }

  // A job that ended keeps no held file, unless that file went to review.
  _dropHeldForReview(job) {
    if (!job.heldForReview) return;
    discardReviewFiles([job], { heldOnly: true });
    this._setHeldForReview(job, null);
  }

  setRequestKind(id, kind) {
    const job = this.jobs.get(id);
    if (!job || !["album", "track"].includes(kind)) return false;
    job.requestKind = kind;
    updateRequestKindStmt.run(kind, id);
    return true;
  }

  markSlskdDispatched(id) {
    this.slskdDispatched.add(id);
  }

  clearSlskdDispatched(id) {
    this.slskdDispatched.delete(id);
  }

  clearSlskdPipelineState(id, options = {}) {
    const clearDownloadMetadata = options.clearDownloadMetadata !== false;
    this.clearSlskdDispatched(id);
    const job = this.jobs.get(id);
    if (job) {
      if (clearDownloadMetadata) {
        for (const key of DOWNLOAD_METADATA_KEYS) job[key] = null;
      }
      job.slskdSearchId = null;
      job.slskdBatchId = null;
    }
    if (clearDownloadMetadata) {
      clearSlskdMetaStmt.run(id);
    } else {
      clearTransientPipelineMetaStmt.run(id);
    }
  }

  updateDownloadMetadata(id, metadata = {}) {
    const job = this.jobs.get(id);
    if (!job || !metadata || typeof metadata !== "object") return false;
    const values = Object.fromEntries(DOWNLOAD_METADATA_KEYS.map((key) => [
      key,
      String(metadata[key] ?? "").trim() || null,
    ]));
    const movedSource = values.downloadSource && values.downloadSource !== job.downloadSource;
    for (const key of DOWNLOAD_METADATA_KEYS) {
      if (movedSource || values[key]) job[key] = values[key];
    }
    updateDownloadMetaStmt.run(...DOWNLOAD_METADATA_KEYS.map((key) => job[key] ?? null), id);
    recordAlbumTrackState(job);
    return true;
  }

  // The queued album attempt this job is still part of. A job released from
  // an attempt no longer shares its download attempt, so a step of that
  // attempt that is still queued cannot claim it again.
  _activeAlbumGrab(jobId) {
    const attemptId = getActiveDownloadAttemptId(jobId);
    if (!attemptId) return null;
    return listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.albumGrab === true
      && entry.payload.downloadAttemptId === attemptId
      && entry.payload.albumGroupJobIds?.includes(jobId)) || null;
  }

  releaseFromAlbumGrab(id, reason = null, options = {}) {
    setActiveDownloadAttemptId(id, null);
    return this.setPending(id, reason, options);
  }

  // Album attempts that ended on a step that failed every retry since the
  // job last finished or failed.
  recordAlbumGrabFailure(id) {
    const job = this.jobs.get(id);
    if (!job) return 0;
    this._setAlbumGrabFailures(job, (job.albumGrabFailures || 0) + 1);
    return job.albumGrabFailures;
  }

  _setAlbumGrabFailures(job, count) {
    if ((job.albumGrabFailures || 0) === count) return;
    job.albumGrabFailures = count;
    updateAlbumGrabFailuresStmt.run(count, job.id);
  }

  canSearchByRelease(job) {
    return !job.upgradeForJobId && searchesByRelease(job) && isAlbumGrabSourceConfigured();
  }

  // A track request first searches the sources that download only a track
  // when the user ranks them above every album source, each once per request.
  // A whole-album request never does. It needs no release to start.
  quickSearchSourcesDue(job) {
    if (job.requestKind !== "track" || job.upgradeForJobId || !this.canAwaitRelease(job)) return [];
    return getQuickSearchSources().filter((source) => !job.quickSearchedSources.includes(source));
  }

  startsWithQuickSearch(job) {
    return this.canSearchByRelease(job) && this.quickSearchSourcesDue(job).length > 0;
  }

  // A track that would search by release once metadata reads its album.
  canAwaitRelease(job) {
    return Boolean(job) && triesRelease(job) && isAlbumGrabSourceConfigured();
  }

  // The tracks one release attempt fills: this job and the pending tracks of
  // its request that the release lists, each pinned to that release. A pin
  // the release group no longer lists, as after a merge, pins nothing.
  // An upgrade's attempt holds only upgrades: every one of the release still
  // waiting to start, whatever request or owner its track came from, as the
  // upgrade check queues them together. An upgrade whose owner is not active
  // neither leads nor joins one, since its attempt would wait for the owner.
  // No other attempt holds an upgrade or a track still due its quick search.
  _releaseMembers(job, release) {
    const listed = (pin) => !release.groupReleaseMbids || release.groupReleaseMbids.includes(String(pin).toLowerCase());
    const pinnedElsewhere = (entry) => entry.releaseMbid && entry.releaseMbid !== release.releaseMbid
      && listed(entry.releaseMbid);
    const ownerActive = (entry) => isPlaylistOwnerActive(entry.playlistId || entry.playlistType);
    const fits = (entry) => entry.albumMbid === job.albumMbid && searchesByRelease(entry) && !pinnedElsewhere(entry);
    const joins = (entry) => entry.status === "pending" && fits(entry)
      && (job.upgradeForJobId
        ? Boolean(entry.upgradeForJobId) && ownerActive(entry)
        : (entry.requestGroupId || null) === (job.requestGroupId || null)
          && !entry.upgradeForJobId && !this.startsWithQuickSearch(entry));
    if (!release || !fits(job) || !isAlbumGrabSourceConfigured()) return [];
    if (job.upgradeForJobId && !ownerActive(job)) return [];
    const candidates = job.requestGroupId || job.upgradeForJobId
      ? this.getAll().filter((entry) => entry.id === job.id || joins(entry))
      : [job];
    const ids = [...mapRequest(release, candidates).wanted.values()];
    if (!ids.includes(job.id)) return [];
    return [job.id, ...ids.filter((id) => id !== job.id)].map((id) => this.jobs.get(id));
  }

  // A job that could have searched by release but searches for the track
  // says why, once.
  _noteTrackSearch(job, release) {
    if (!this.canSearchByRelease(job)) return;
    const reason = release ? OFF_RELEASE_REASON : NO_RELEASE_REASON;
    if (job.error === reason) return;
    job.error = reason;
    this._update(job);
    logger.info("downloads", "Searching for the track without its release", { jobId: job.id, reason });
  }

  // `release` is the manifest the job just resolved to, or null when it
  // resolved to none. A track that can search by release is never queued
  // without it, so no caller skips the one place that chooses a release.
  enqueueDownloadPipeline(jobId, { release } = {}) {
    if (!isAnyDownloadSourceConfigured()) return false;
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const activeGrab = job.albumGrabAttempted ? this._activeAlbumGrab(jobId) : null;
    if (activeGrab && ["pending", "downloading"].includes(job.status)) {
      const { albumGroupJobIds, downloadAttemptId } = activeGrab.payload;
      recordAlbumGrabQueued(activeGrab.payload, albumGroupJobIds.map((id) => this.jobs.get(id)).filter(Boolean));
      for (const memberId of albumGroupJobIds) {
        if (this.jobs.get(memberId)?.status === "pending" && getActiveDownloadAttemptId(memberId) === downloadAttemptId) {
          this.setDownloading(memberId);
        }
      }
      if (jobId === activeGrab.payload.jobId) this.markSlskdDispatched(jobId);
      return true;
    }
    if (job.status !== "pending" || this.isSlskdDispatched(jobId)) return false;
    const quick = this.startsWithQuickSearch(job);
    if (release === undefined && !quick && this.canSearchByRelease(job)) {
      throw new Error("A track that can search by release is queued only with the release it resolved to");
    }
    const payload = buildPipelinePayload(job);
    if (!isPipelinePayloadActive(payload)) return false;
    const members = quick ? [] : this._releaseMembers(job, release);
    if (quick) {
      payload.quickSearch = true;
      payload.allowedSources = this.quickSearchSourcesDue(job);
      this.setDownloading(jobId);
    } else if (members.length > 0) {
      this._holdForRelease(payload, members, release);
    } else if (release !== undefined) {
      this._noteTrackSearch(job, release);
    }
    try {
      this.enqueuePipeline(payload);
    } catch (error) {
      if (quick) this.setPending(jobId);
      for (const memberId of payload.albumGroupJobIds || []) {
        if (memberId !== jobId) this.setPending(memberId);
        this.setAlbumGrabAttempted(memberId, false);
      }
      throw error;
    }
    this.markSlskdDispatched(jobId);
    if (payload.albumGrab === true) recordAlbumGrabQueued(payload, members);
    return true;
  }

  _holdForRelease(payload, members, release) {
    payload.albumGrab = true;
    payload.releaseMbid = release.releaseMbid;
    payload.albumGroupJobIds = members.map((member) => member.id);
    if (payload.upgrade === true) orderUpgradeAttempt(payload.downloadAttemptId);
    for (const member of members) {
      setActiveDownloadAttemptId(member.id, payload.downloadAttemptId);
      this.setAlbumGrabAttempted(member.id, true);
      this.updateMetadata(member.id, { releaseMbid: release.releaseMbid });
      if (member.id !== payload.jobId) this.setDownloading(member.id);
    }
  }

  // NZBGet puts two downloads of one release in one folder, where the first
  // import leaves the second short of the release. Usenet titles do not name
  // a pressing, so two pressings of an album can pick one NZB. An upgrade's
  // release attempt therefore waits while one that started before it still
  // downloads an upgrade of the same album by release, and then downloads
  // the release whole.
  upgradeAttemptAhead(payload) {
    const order = upgradeAttemptOrder.get(payload.downloadAttemptId);
    const albumMbid = this.jobs.get(payload.jobId)?.albumMbid;
    if (order === undefined || !albumMbid) return false;
    return this.getAll().some((job) => job.upgradeForJobId && job.albumMbid === albumMbid
      && ["pending", "downloading"].includes(job.status)
      && (upgradeAttemptOrder.get(getActiveDownloadAttemptId(job.id)) ?? Infinity) < order);
  }

  // An upgrade attempt that searches for its track no longer downloads its
  // release, so no later attempt waits for it.
  endUpgradeReleaseDownload(attemptId) {
    upgradeAttemptOrder.delete(attemptId);
  }

  // After its quick search found nothing to import, a track request tries
  // its release the way a queued track does. Returns the attempt, or null
  // when the track searches for itself.
  searchByReleaseAfterQuickSearch(payload, release) {
    const job = this.jobs.get(payload.jobId);
    if (!job || !["pending", "downloading"].includes(job.status)) return null;
    const members = this._releaseMembers(job, release);
    if (members.length === 0) {
      this._noteTrackSearch(job, release);
      return null;
    }
    const attempt = { ...payload };
    this._holdForRelease(attempt, members, release);
    recordAlbumGrabQueued(attempt, members);
    return attempt;
  }

  enqueueManualSelection(jobId, { source, candidate, downloadClient = null } = {}) {
    const job = this.jobs.get(jobId);
    const normalizedSource = String(source || "").trim();
    if (!job || job.status !== "failed" || job.upgradeForJobId) return false;
    if (!candidate?.raw || !["slskd", "usenet", "deemix", "ytdlp"].includes(normalizedSource)) {
      return false;
    }
    const payload = {
      ...buildPipelinePayload(job),
      phase: "download",
      source: normalizedSource,
      allowedSources: [normalizedSource],
      candidates: [candidate],
      candidateIndex: 0,
      manualSelection: true,
      manualDownloadClient: downloadClient || null,
    };
    if (!this.setPending(jobId, "Manual download queued", { asRetryCycle: false })) return false;
    // Reserve the job before publishing it so automatic dispatch cannot claim it
    // during the queue handoff.
    this.markSlskdDispatched(jobId);
    try {
      this.enqueuePipeline(payload);
      return true;
    } catch {
      // Preserve the manual workflow on failure: the result session remains
      // available and the job cannot fall through to automatic selection.
      this.setFailed(jobId, "Manual download could not be queued");
      return false;
    }
  }

  enqueueManualReplacementSelection(
    jobId,
    { source, candidate, downloadClient = null } = {},
  ) {
    const sourceJob = this.jobs.get(jobId);
    const normalizedSource = String(source || "").trim();
    if (!sourceJob || sourceJob.status !== "done" || !sourceJob.finalPath) return false;
    if (!candidate?.raw || !["slskd", "usenet", "deemix", "ytdlp"].includes(normalizedSource)) {
      return false;
    }
    const replacementJobId = this.addReplacementSearchJob(sourceJob);
    if (!replacementJobId) return false;
    const replacementJob = this.jobs.get(replacementJobId);
    const payload = {
      ...buildPipelinePayload(replacementJob),
      phase: "download",
      source: normalizedSource,
      allowedSources: [normalizedSource],
      candidates: [candidate],
      candidateIndex: 0,
      manualSelection: true,
      manualDownloadClient: downloadClient || null,
    };
    this.markSlskdDispatched(replacementJobId);
    try {
      this.enqueuePipeline(payload);
      return true;
    } catch {
      this.removeJob(replacementJobId);
      return false;
    }
  }

  _emptyStats() {
    return {
      total: 0,
      pending: 0,
      downloading: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      cancel_requested: 0,
      cancelled: 0,
    };
  }

  _cloneStats(stats) {
    return {
      total: Number(stats?.total || 0),
      pending: Number(stats?.pending || 0),
      downloading: Number(stats?.downloading || 0),
      blocked: Number(stats?.blocked || 0),
      done: Number(stats?.done || 0),
      failed: Number(stats?.failed || 0),
      cancel_requested: Number(stats?.cancel_requested || 0),
      cancelled: Number(stats?.cancelled || 0),
    };
  }

  _getOrCreatePlaylistStats(playlistType) {
    const key = String(playlistType || "");
    let stats = this.statsByPlaylistType.get(key);
    if (!stats) {
      stats = this._emptyStats();
      this.statsByPlaylistType.set(key, stats);
    }
    return stats;
  }

  _applyStatusDelta(playlistType, fromStatus, toStatus) {
    if (playlistType) {
      const stats = this._getOrCreatePlaylistStats(playlistType);
      if (fromStatus && stats[fromStatus] > 0) {
        stats[fromStatus] -= 1;
        stats.total = Math.max(0, stats.total - 1);
      }
      if (toStatus) {
        stats[toStatus] = (stats[toStatus] || 0) + 1;
        stats.total += 1;
      }
      if (stats.total <= 0) {
        this.statsByPlaylistType.delete(String(playlistType));
      }
    }
    if (fromStatus && this.globalStats[fromStatus] > 0) {
      this.globalStats[fromStatus] -= 1;
      this.globalStats.total = Math.max(0, this.globalStats.total - 1);
    }
    if (toStatus) {
      this.globalStats[toStatus] = (this.globalStats[toStatus] || 0) + 1;
      this.globalStats.total += 1;
    }
  }

  _rebuildStatsByPlaylistType() {
    this.statsByPlaylistType.clear();
    this.globalStats = this._emptyStats();
    this.pendingFreshQueue = [];
    this.pendingRetryQueue = [];
    this.pendingSet = new Set();
    this.pendingRetrySet = new Set();
    for (const job of this.jobs.values()) {
      this._applyStatusDelta(job.playlistType, null, job.status);
      if (job.status === "pending" && !job.manualReplacementSearch) {
        this.pendingFreshQueue.push(job.id);
        this.pendingSet.add(job.id);
      }
    }
  }

  _removeFromPendingQueues(id) {
    this.pendingFreshQueue = this.pendingFreshQueue.filter((entryId) => entryId !== id);
    this.pendingRetryQueue = this.pendingRetryQueue.filter((entryId) => entryId !== id);
  }

  _load() {
    updatePlaylistTypeStmt.run("discover", "discover", "recommended");
    const rows = selectAllStmt.all();
    for (const row of rows) {
      const job = rowToJob(row);
      if ((job.status === "downloading" || job.status === "cancel_requested") && (
        process.env.AURRAL_BACKGROUND_WORKER_GROUP === "downloads" ||
        process.env.NODE_ENV === "test" || process.env.AURRAL_TEST_SERVER === "1"
      )) {
        if (this._isInterruptedCancellation(job)) {
          job.status = "cancelled";
          job.completedAt = Date.now();
        } else {
          job.status = "pending";
        }
        job.startedAt = null;
        job.stagingPath = null;
        updateStmt.run(
          job.status,
          job.stagingPath,
          job.finalPath,
          job.externalPath ?? null,
          job.error,
          job.startedAt,
          job.completedAt,
          job.albumName ?? null,
          job.reason ?? null,
          job.artistMbid ?? null,
          job.albumMbid ?? null,
          job.releaseMbid ?? null,
          job.trackMbid ?? null,
          job.releaseYear ?? null,
          job.durationMs ?? null,
          job.trackNumber ?? null,
          job.discNumber ?? null,
          job.albumTrackCount ?? null,
          stringifyStringListJson(job.albumTrackTitles),
          stringifyStringListJson(job.artistAliases),
          job.qualityTier ?? null,
          job.qualityFormat ?? null,
          job.qualityBitrateKbps ?? null,
          job.qualitySampleRate ?? null,
          job.qualityBitDepth ?? null,
          job.qualityCheckedAt ?? null,
          job.qualityUpgradeCheckedAt ?? null,
          job.upgradeForJobId ?? null,
          job.manualReplacementSearch ? 1 : 0,
          job.id,
        );
      }
      this.jobs.set(job.id, job);
      if (ENDED_STATUSES.has(job.status)) this._dropHeldForReview(job);
    }
    if (process.env.AURRAL_BACKGROUND_WORKER_GROUP === "downloads" ||
        process.env.NODE_ENV === "test" || process.env.AURRAL_TEST_SERVER === "1") {
      for (const job of this.jobs.values()) {
        if (job.status === "pending" && job.upgradeForJobId && !job.manualReplacementSearch) {
          this.removeJob(job.id);
        }
      }
    }
    this._rebuildStatsByPlaylistType();
  }

  _insert(job) {
    const createdAt = job.createdAt ?? Date.now();
    job.createdAt = createdAt;
    insertStmt.run(
      job.id,
      job.artistName,
      job.trackName,
      job.albumName ?? null,
      job.reason ?? null,
      job.artistMbid ?? null,
      job.albumMbid ?? null,
      job.releaseMbid ?? null,
      job.trackMbid ?? null,
      job.releaseYear ?? null,
      job.durationMs ?? null,
      job.trackNumber ?? null,
      job.discNumber ?? null,
      job.albumTrackCount ?? null,
      stringifyStringListJson(job.albumTrackTitles),
      stringifyStringListJson(job.artistAliases),
      job.playlistId || job.playlistType,
      job.playlistGeneration ?? 0,
      job.playlistType || job.playlistId,
      job.managedBy === "lidarr" ? "lidarr" : "aurral",
      job.requestGroupId ?? null,
      job.status,
      job.stagingPath ?? null,
      job.finalPath ?? null,
      job.externalPath ?? null,
      job.error ?? null,
      job.startedAt ?? null,
      job.completedAt ?? null,
      createdAt,
      job.qualityTier ?? null,
      job.qualityFormat ?? null,
      job.qualityBitrateKbps ?? null,
      job.qualitySampleRate ?? null,
      job.qualityBitDepth ?? null,
      job.qualityCheckedAt ?? null,
      job.qualityUpgradeCheckedAt ?? null,
      job.upgradeForJobId ?? null,
      job.manualReplacementSearch ? 1 : 0,
      job.requestKind === "album" ? "album" : "track",
    );
    this._touchRevision();
  }

  _update(job) {
    updateStmt.run(
      job.status,
      job.stagingPath ?? null,
      job.finalPath ?? null,
      job.externalPath ?? null,
      job.error ?? null,
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.albumName ?? null,
      job.reason ?? null,
      job.artistMbid ?? null,
      job.albumMbid ?? null,
      job.releaseMbid ?? null,
      job.trackMbid ?? null,
      job.releaseYear ?? null,
      job.durationMs ?? null,
      job.trackNumber ?? null,
      job.discNumber ?? null,
      job.albumTrackCount ?? null,
      stringifyStringListJson(job.albumTrackTitles),
      stringifyStringListJson(job.artistAliases),
      job.qualityTier ?? null,
      job.qualityFormat ?? null,
      job.qualityBitrateKbps ?? null,
      job.qualitySampleRate ?? null,
      job.qualityBitDepth ?? null,
      job.qualityCheckedAt ?? null,
      job.qualityUpgradeCheckedAt ?? null,
      job.upgradeForJobId ?? null,
      job.manualReplacementSearch ? 1 : 0,
      job.id,
    );
    if (ENDED_STATUSES.has(job.status)) this._dropHeldForReview(job);
    recordAlbumTrackState(job);
    this._touchRevision();
  }

  addJob(track, playlistType, options = {}) {
    const id = randomUUID();
    const artistName = String(track?.artistName || "").trim();
    const trackName = String(track?.trackName || "").trim();
    if (!artistName || !trackName) {
      return null;
    }
    const playlistId = options?.playlistId || playlistType;
    const job = {
      id,
      artistName,
      trackName,
      albumName: track?.albumName ? String(track.albumName).trim() : null,
      reason: track?.reason ? String(track.reason).trim() : null,
      artistMbid: track?.artistMbid ? String(track.artistMbid).trim() : null,
      albumMbid: track?.albumMbid ? String(track.albumMbid).trim() : null,
      releaseMbid: track?.releaseMbid ? String(track.releaseMbid).trim() || null : null,
      trackMbid: track?.trackMbid ? String(track.trackMbid).trim() : null,
      releaseYear: track?.releaseYear ? String(track.releaseYear).trim() : null,
      durationMs:
        track?.durationMs != null && Number.isFinite(Number(track.durationMs))
          ? Math.max(0, Math.round(Number(track.durationMs)))
          : null,
      trackNumber: normalizePositiveInteger(track?.trackNumber),
      discNumber: normalizePositiveInteger(track?.discNumber),
      albumTrackCount: normalizePositiveInteger(track?.albumTrackCount),
      albumTrackTitles: normalizeStringList(track?.albumTrackTitles),
      artistAliases: normalizeStringList(track?.artistAliases),
      playlistId,
      playlistGeneration: Number.isInteger(options?.playlistGeneration)
        ? options.playlistGeneration
        : getPlaylistDownloadGeneration(playlistId),
      playlistType,
      managedBy: track?.managedBy === "lidarr" ? "lidarr" : "aurral",
      requestGroupId: track?.requestGroupId
        ? String(track.requestGroupId).trim() || null
        : null,
      requestKind: options?.requestKind === "album" ? "album" : "track",
      quickSearchedSources: [],
      status: "pending",
      startedAt: null,
      completedAt: null,
      stagingPath: null,
      finalPath: null,
      externalPath: null,
      error: null,
      createdAt: Date.now(),
      retryCycle: false,
    };
    this.jobs.set(id, job);
    this._insert(job);
    this._applyStatusDelta(playlistType, null, job.status);
    this.pendingFreshQueue.push(id);
    this.pendingSet.add(id);
    this.pendingRetrySet.delete(id);
    return id;
  }

  ensureLibraryTrackJob(track, finalPath) {
    const sourcePath = String(finalPath || "").trim();
    if (!sourcePath) return null;
    const resolvedPath = path.resolve(sourcePath);
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.status === "done" &&
        job.managedBy === "aurral" &&
        !job.upgradeForJobId &&
        job.finalPath &&
        path.resolve(job.finalPath) === resolvedPath,
    );
    if (existing) return existing;

    const id = this.addJob(
      { ...track, managedBy: "aurral", reason: track?.reason || "Aurral library track" },
      "library",
      { playlistId: "library" },
    );
    if (!id || !this.setDone(id, resolvedPath, track?.albumName)) return null;
    return this.jobs.get(id) || null;
  }

  addJobs(tracks, playlistType) {
    const ids = [];
    for (const track of tracks) {
      const id = this.addJob(track, playlistType);
      if (!id) continue;
      ids.push(id);
    }
    return ids;
  }

  findActiveUpgradeJob(sourceJob) {
    if (!sourceJob?.finalPath) return null;
    return [...this.jobs.values()].find((job) => {
      if (
        !job.upgradeForJobId ||
        !["pending", "downloading", "blocked"].includes(job.status)
      ) {
        return false;
      }
      return this.jobs.get(job.upgradeForJobId)?.finalPath === sourceJob.finalPath;
    }) || null;
  }

  addUpgradeJob(sourceJob) {
    if (!sourceJob?.id || sourceJob.status !== "done" || !sourceJob.finalPath) return null;
    if (this.findActiveUpgradeJob(sourceJob)) return null;
    const playlistId = sourceJob.playlistId || sourceJob.playlistType;
    const id = this.addJob(sourceJob, "quality-upgrade", {
      playlistId,
      playlistGeneration: sourceJob.playlistGeneration,
    });
    const job = this.jobs.get(id);
    job.upgradeForJobId = sourceJob.id;
    this._update(job);
    return id;
  }

  queueFirst(ids) {
    const first = new Set(ids);
    this.pendingFreshQueue = [...ids, ...this.pendingFreshQueue.filter((id) => !first.has(id))];
  }

  addReplacementSearchJob(sourceJob) {
    if (!sourceJob?.id || sourceJob.status !== "done" || !sourceJob.finalPath) return null;
    if (this.findActiveUpgradeJob(sourceJob)) return null;
    const playlistId = sourceJob.playlistId || sourceJob.playlistType;
    const id = this.addJob(sourceJob, "quality-upgrade", {
      playlistId,
      playlistGeneration: getPlaylistDownloadGeneration(playlistId),
    });
    const job = this.jobs.get(id);
    job.upgradeForJobId = sourceJob.id;
    job.manualReplacementSearch = true;
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    this._update(job);
    return id;
  }

  updateQuality(id, quality = {}) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.qualityTier = quality.tier || null;
    job.qualityFormat = quality.format || null;
    job.qualityBitrateKbps = quality.bitrateKbps ?? null;
    job.qualitySampleRate = quality.sampleRate ?? null;
    job.qualityBitDepth = quality.bitDepth ?? null;
    job.qualityCheckedAt = quality.checkedAt ?? Date.now();
    if (quality.upgradeCheckedAt !== undefined) {
      job.qualityUpgradeCheckedAt = quality.upgradeCheckedAt;
    }
    this._update(job);
    return true;
  }

  markQualityUpgradeChecked(id, checkedAt = Date.now()) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.qualityUpgradeCheckedAt = checkedAt;
    this._update(job);
    return true;
  }

  replaceFinalPath(sourcePath, finalPath, quality) {
    const changed = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "done" || job.finalPath !== sourcePath) continue;
      job.finalPath = finalPath;
      job.externalPath = null;
      job.qualityTier = quality?.tier || null;
      job.qualityFormat = quality?.format || null;
      job.qualityBitrateKbps = quality?.bitrateKbps ?? null;
      job.qualitySampleRate = quality?.sampleRate ?? null;
      job.qualityBitDepth = quality?.bitDepth ?? null;
      job.qualityCheckedAt = Date.now();
      job.qualityUpgradeCheckedAt = Date.now();
      this._update(job);
      changed.push(job);
    }
    return changed;
  }

  updateFinalPath(id, finalPath) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "done") return false;
    job.finalPath = finalPath;
    this._update(job);
    return true;
  }

  updateMetadata(id, metadata = {}) {
    const job = this.jobs.get(id);
    if (!job || !metadata || typeof metadata !== "object") return false;
    let changed = false;
    const assignString = (key) => {
      if (!(key in metadata)) return;
      const nextValue = metadata[key] ? String(metadata[key]).trim() || null : null;
      if (job[key] !== nextValue) {
        job[key] = nextValue;
        changed = true;
      }
    };
    assignString("artistName");
    assignString("trackName");
    assignString("albumName");
    assignString("reason");
    assignString("artistMbid");
    assignString("albumMbid");
    assignString("releaseMbid");
    assignString("trackMbid");
    assignString("releaseYear");
    if ("durationMs" in metadata) {
      const nextDuration =
        metadata.durationMs != null && Number.isFinite(Number(metadata.durationMs))
          ? Math.max(0, Math.round(Number(metadata.durationMs)))
          : null;
      if (job.durationMs !== nextDuration) {
        job.durationMs = nextDuration;
        changed = true;
      }
    }
    if ("artistAliases" in metadata) {
      const nextAliases = normalizeStringList(metadata.artistAliases);
      const previousSerialized = JSON.stringify(job.artistAliases || []);
      const nextSerialized = JSON.stringify(nextAliases);
      if (previousSerialized !== nextSerialized) {
        job.artistAliases = nextAliases;
        changed = true;
      }
    }
    for (const key of ["trackNumber", "discNumber"]) {
      if (!(key in metadata)) continue;
      const next = normalizePositiveInteger(metadata[key]);
      if (job[key] !== next) {
        job[key] = next;
        changed = true;
      }
    }
    if ("albumTrackCount" in metadata) {
      const nextTrackCount = normalizePositiveInteger(metadata.albumTrackCount);
      if (job.albumTrackCount !== nextTrackCount) {
        job.albumTrackCount = nextTrackCount;
        changed = true;
      }
    }
    if ("albumTrackTitles" in metadata) {
      const nextTitles = normalizeStringList(metadata.albumTrackTitles);
      const previousSerialized = JSON.stringify(job.albumTrackTitles || []);
      const nextSerialized = JSON.stringify(nextTitles);
      if (previousSerialized !== nextSerialized) {
        job.albumTrackTitles = nextTitles;
        changed = true;
      }
    }
    if (changed) {
      this._update(job);
    }
    return changed;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  removeJob(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    discardReviewFiles([job]);
    cancelDownloadJob(id);
    this.clearSlskdPipelineState(id);
    this.jobs.delete(id);
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    this._applyStatusDelta(job.playlistType, job.status, null);
    deleteStmt.run(id);
    this._touchRevision();
    return true;
  }

  _pickPendingFromQueue(queue, lastPlaylistType = null) {
    let fallbackIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const nextId = queue[index];
      if (!this.pendingSet.has(nextId)) {
        continue;
      }
      const job = this.jobs.get(nextId);
      if (!job || job.status !== "pending") {
        continue;
      }
      if (lastPlaylistType && String(job.playlistType || "") === String(lastPlaylistType || "")) {
        if (fallbackIndex === -1) fallbackIndex = index;
        continue;
      }
      return job;
    }
    if (fallbackIndex >= 0) {
      const fallbackId = queue[fallbackIndex];
      const fallbackJob = this.jobs.get(fallbackId);
      if (fallbackJob && fallbackJob.status === "pending") {
        return fallbackJob;
      }
    }
    return null;
  }

  _compactPendingQueue(queue) {
    return queue.filter((id) => {
      if (!this.pendingSet.has(id)) return false;
      const job = this.jobs.get(id);
      return !!job && job.status === "pending";
    });
  }

  getNextPending(lastPlaylistType = null) {
    return this.getNextPendingMatching(() => true, lastPlaylistType);
  }

  _shouldSkipForWorker(job) {
    return job?.status === "pending" && this.isSlskdDispatched(job.id);
  }

  getNextPendingMatching(predicate = null, lastPlaylistType = null) {
    const accepts = typeof predicate === "function" ? predicate : () => true;
    const canProcess = (job) =>
      job &&
      job.status === "pending" &&
      !this._shouldSkipForWorker(job) &&
      isPipelinePayloadActive({
        jobId: job.id,
        playlistId: job.playlistId || job.playlistType,
        playlistGeneration: job.playlistGeneration,
      }) &&
      accepts(job);
    this.pendingFreshQueue = this._compactPendingQueue(this.pendingFreshQueue);
    const nextFresh = this._pickPendingFromQueue(this.pendingFreshQueue, lastPlaylistType);
    if (canProcess(nextFresh)) return nextFresh;
    this.pendingRetryQueue = this._compactPendingQueue(this.pendingRetryQueue);
    const nextRetry = this._pickPendingFromQueue(this.pendingRetryQueue, lastPlaylistType);
    if (canProcess(nextRetry)) return nextRetry;
    if (this.pendingSet.size > 0) {
      for (const id of this.pendingSet) {
        const job = this.jobs.get(id);
        if (canProcess(job)) return job;
      }
    }
    return null;
  }

  peekPending(limit = 10) {
    const max =
      Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 10;
    const jobs = [];
    const combined = [...this.pendingFreshQueue, ...this.pendingRetryQueue];
    for (const id of combined) {
      if (jobs.length >= max) break;
      if (!this.pendingSet.has(id)) continue;
      const job = this.jobs.get(id);
      if (!job || job.status !== "pending") continue;
      jobs.push(job);
    }
    return jobs;
  }

  getPending(limit = 10) {
    const pending = [];
    for (const job of this.jobs.values()) {
      if (job.status === "pending" && pending.length < limit) {
        pending.push(job);
      }
    }
    return pending;
  }

  setDownloading(id, stagingPath = null) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "downloading";
    job.startedAt = Date.now();
    if (stagingPath) {
      job.stagingPath = stagingPath;
    }
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setPending(id, error = null, options = {}) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    const asRetryCycle = options?.asRetryCycle === true;
    if (asRetryCycle) this.setAlbumGrabAttempted(id, false);
    if (ENDED_STATUSES.has(previousStatus)) this._setQuickSearchedSources(job, []);
    this.clearSlskdPipelineState(id);
    job.status = "pending";
    job.startedAt = null;
    job.completedAt = null;
    job.stagingPath = null;
    job.finalPath = null;
    job.retryCycle = asRetryCycle;
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    this.pendingSet.add(id);
    this._removeFromPendingQueues(id);
    if (asRetryCycle) {
      this.pendingRetrySet.add(id);
      this.pendingRetryQueue.push(id);
    } else {
      this.pendingRetrySet.delete(id);
      this.pendingFreshQueue.push(id);
    }
    return true;
  }

  deferPendingToBack(id, error = null, options = {}) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "pending" || this._isCancelledAlbumJob(job)) return false;
    const keepRetryTier = options?.keepRetryTier === true;
    const currentlyRetryTier = this.pendingRetrySet.has(id);
    const moveToRetryTier = keepRetryTier ? currentlyRetryTier : false;
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._removeFromPendingQueues(id);
    this.pendingSet.add(id);
    if (moveToRetryTier) {
      this.pendingRetrySet.add(id);
      this.pendingRetryQueue.push(id);
    } else {
      this.pendingRetrySet.delete(id);
      this.pendingFreshQueue.push(id);
    }
    return true;
  }

  _isCancelledAlbumJob(job) {
    return Boolean(job?.requestGroupId) && isDownloadJobCancelled(job.id);
  }

  _isInterruptedCancellation(job) {
    return job.status === "cancel_requested" || this._isCancelledAlbumJob(job);
  }

  setCancelRequested(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "downloading") return false;
    job.status = "cancel_requested";
    this._update(job);
    this._applyStatusDelta(job.playlistType, "downloading", job.status);
    return true;
  }

  setCancelled(id) {
    const job = this.jobs.get(id);
    if (!job || !["pending", "downloading", "cancel_requested"].includes(job.status)) {
      return false;
    }
    const previousStatus = job.status;
    this.clearSlskdPipelineState(id, { clearDownloadMetadata: false });
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "cancelled";
    job.retryCycle = false;
    job.startedAt = null;
    job.stagingPath = null;
    job.completedAt = Date.now();
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setDone(id, finalPath, albumName = null, externalPath = null) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    this.clearSlskdPipelineState(id, { clearDownloadMetadata: false });
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "done";
    job.retryCycle = false;
    job.completedAt = Date.now();
    this._setAlbumGrabFailures(job, 0);
    job.finalPath = finalPath;
    job.externalPath = externalPath ?? null;
    const safeAlbum = String(albumName || "").trim();
    if (safeAlbum) {
      job.albumName = safeAlbum;
    } else if (!job.albumName) {
      job.albumName = null;
    }
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setFailed(id, error) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    this.clearSlskdPipelineState(id, { clearDownloadMetadata: false });
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "failed";
    job.retryCycle = false;
    job.completedAt = Date.now();
    this._setAlbumGrabFailures(job, 0);
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setBlocked(id, error, stagingPath = null) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    this.clearSlskdPipelineState(id, { clearDownloadMetadata: false });
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "blocked";
    job.retryCycle = false;
    job.completedAt = Date.now();
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    if (stagingPath) job.stagingPath = stagingPath;
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  recordDeniedSource(id, source, key) {
    const job = this.jobs.get(id);
    if (!job) return false;
    const safeSource = String(source || "").trim();
    const safeKey = String(key || "").trim();
    if (!safeSource || !safeKey) return false;
    const sources = Array.isArray(job.deniedRemoteSources) ? [...job.deniedRemoteSources] : [];
    const duplicate = sources.some(
      (entry) => Array.isArray(entry) && entry[0] === safeSource && entry[1] === safeKey,
    );
    if (duplicate) return false;
    sources.push([safeSource, safeKey]);
    job.deniedRemoteSources = sources;
    updateDeniedSourcesStmt.run(JSON.stringify(sources), id);
    this._touchRevision();
    return true;
  }

  getByPlaylistType(playlistType, limit = null) {
    const jobs = [];
    const max =
      Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : null;
    for (const job of this.jobs.values()) {
      if (job.playlistType === playlistType) {
        jobs.push(job);
        if (max != null && jobs.length >= max) {
          break;
        }
      }
    }
    if (max != null) {
      return jobs;
    }
    return sortByCreatedAt(jobs);
  }

  getByPlaylistId(playlistId) {
    const safePlaylistId = String(playlistId || "").trim();
    if (!safePlaylistId) return [];
    return sortByCreatedAt(
      [...this.jobs.values()].filter(
        (job) => job.playlistId === safePlaylistId || job.playlistType === safePlaylistId,
      ),
    );
  }

  getByStatus(status) {
    const jobs = [];
    for (const job of this.jobs.values()) {
      if (job.status === status) {
        jobs.push(job);
      }
    }
    return jobs;
  }

  migratePlaylistTypes(idMap) {
    if (!idMap || idMap.size === 0) return 0;
    let count = 0;
    for (const [fromId, toId] of idMap.entries()) {
      updatePlaylistTypeStmt.run(toId, toId, fromId);
      for (const job of this.jobs.values()) {
        if (job.playlistType === fromId) {
          job.playlistId = toId;
          job.playlistType = toId;
          count += 1;
        }
      }
    }
    this._rebuildStatsByPlaylistType();
    if (count > 0) this._touchRevision();
    return count;
  }

  resetDownloadingToPending() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "cancel_requested" || (job.status === "downloading" && this._isCancelledAlbumJob(job))) {
        this.setCancelled(job.id);
        continue;
      }
      if (job.status === "downloading") {
        const previousStatus = job.status;
        this.clearSlskdPipelineState(job.id);
        job.status = "pending";
        job.startedAt = null;
        job.stagingPath = null;
        this._update(job);
        this._applyStatusDelta(job.playlistType, previousStatus, job.status);
        this.pendingSet.add(job.id);
        this._removeFromPendingQueues(job.id);
        if (job.retryCycle === true) {
          this.pendingRetrySet.add(job.id);
          this.pendingRetryQueue.push(job.id);
        } else {
          this.pendingRetrySet.delete(job.id);
          this.pendingFreshQueue.push(job.id);
        }
        count++;
      }
    }
    return count;
  }

  getActiveByPlaylistType(playlistType) {
    return sortByCreatedAt([...this.jobs.values()].filter((job) =>
      job.playlistType === playlistType && (job.status === "pending" || job.status === "downloading")));
  }

  getByAlbumMbid(matches) {
    return sortByCreatedAt([...this.jobs.values()].filter((job) => job.albumMbid && matches(job.albumMbid)));
  }

  hasActiveJobsForPlaylist(playlistType) {
    for (const job of this.jobs.values()) {
      if (job.playlistType !== playlistType) continue;
      if (job.status === "pending" || job.status === "downloading") {
        return true;
      }
    }
    return false;
  }

  failActiveJobsForPlaylist(playlistType, error = "Retry cycle paused") {
    let count = 0;
    const failedJobs = [];
    for (const job of this.jobs.values()) {
      if (job.playlistType !== playlistType) continue;
      if (job.status !== "pending" && job.status !== "downloading") continue;
      const previousStatus = job.status;
      this.clearSlskdPipelineState(job.id);
      this.pendingSet.delete(job.id);
      this.pendingRetrySet.delete(job.id);
      this._removeFromPendingQueues(job.id);
      job.status = "failed";
      job.retryCycle = false;
      job.startedAt = null;
      job.stagingPath = null;
      job.completedAt = Date.now();
      job.error = typeof error === "string" ? error : String(error || "");
      this._update(job);
      this._applyStatusDelta(job.playlistType, previousStatus, job.status);
      failedJobs.push(job);
      count += 1;
    }
    if (failedJobs.length > 0) {
      import("../aurralHistoryService.js")
        .then(({ recordTrackJobFailed }) => {
          for (const job of failedJobs) {
            recordTrackJobFailed(job, job.error || error);
          }
        })
        .catch((historyError) => {
          logger.warn("history", "Could not record failed download jobs", {
            jobCount: failedJobs.length,
            reason: historyError?.message || String(historyError),
          });
        });
    }
    return count;
  }

  getAll() {
    return sortByCreatedAt(Array.from(this.jobs.values()));
  }

  getDoneWithFinalPath(limit = 500) {
    const max =
      Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 500;
    const jobs = [];
    for (const job of this.jobs.values()) {
      if (job?.status !== "done" || typeof job?.finalPath !== "string") {
        continue;
      }
      jobs.push(job);
      if (jobs.length >= max) break;
    }
    return jobs;
  }

  getStats() {
    return this._cloneStats(this.globalStats);
  }

  getStatsByPlaylistType(playlistTypes = []) {
    const statsByType = {};
    if (Array.isArray(playlistTypes) && playlistTypes.length > 0) {
      for (const playlistType of playlistTypes) {
        statsByType[playlistType] = this._cloneStats(
          this.statsByPlaylistType.get(String(playlistType)) || this._emptyStats(),
        );
      }
      return statsByType;
    }
    for (const [playlistType, stats] of this.statsByPlaylistType.entries()) {
      statsByType[playlistType] = this._cloneStats(stats);
    }
    return statsByType;
  }

  getPlaylistTypeStats(playlistType) {
    return this._cloneStats(
      this.statsByPlaylistType.get(String(playlistType)) || this._emptyStats(),
    );
  }

  _deleteJobsWhere(matches, { cleanPending = false } = {}) {
    const toDelete = [];
    for (const [id, job] of this.jobs.entries()) {
      if (matches(job, id)) {
        toDelete.push(id);
      }
    }
    discardReviewFiles(toDelete.map((id) => this.jobs.get(id)));
    cancelDownloadJobs(toDelete);
    for (const id of toDelete) {
      this.jobs.delete(id);
      if (cleanPending) {
        this.pendingSet.delete(id);
        this.pendingRetrySet.delete(id);
        this._removeFromPendingQueues(id);
      }
      deleteStmt.run(id);
    }
    if (toDelete.length > 0) {
      this._rebuildStatsByPlaylistType();
      this._touchRevision();
    }
    return toDelete.length;
  }

  clearCompleted() {
    return this._deleteJobsWhere(
      (job) =>
        (job.status === "done" || job.status === "failed") &&
        !(job.status === "done" && this.findActiveUpgradeJob(job)),
    );
  }

  clearByPlaylistType(playlistType) {
    return this._deleteJobsWhere((job) => job.playlistType === playlistType);
  }

  clearByPlaylistId(playlistId) {
    const safePlaylistId = String(playlistId || "").trim();
    if (!safePlaylistId) return 0;
    return this._deleteJobsWhere(
      (job) => job.playlistId === safePlaylistId || job.playlistType === safePlaylistId,
    );
  }

  clearPendingByPlaylistType(playlistType) {
    return this._deleteJobsWhere(
      (job) => job.playlistType === playlistType && job.status === "pending",
      { cleanPending: true },
    );
  }

  clearAll() {
    const count = this.jobs.size;
    discardReviewFiles([...this.jobs.values()]);
    this.jobs.clear();
    this.statsByPlaylistType.clear();
    this.globalStats = this._emptyStats();
    this.pendingFreshQueue = [];
    this.pendingRetryQueue = [];
    this.pendingSet = new Set();
    this.pendingRetrySet = new Set();
    deleteAllStmt.run();
    this._touchRevision();
    return count;
  }

  getRevision() {
    return this.revision;
  }
}

const liveJobs = (rows) => rows.map(rowToJob);
const emptyLiveStats = () => ({
  total: 0, pending: 0, downloading: 0, blocked: 0, done: 0, failed: 0,
});

function readTrackerFromDatabase(name, args) {
  const [first, second] = args;
  if (name === "getJob") {
    const row = liveJobStmt.get(first ?? null);
    return row ? rowToJob(row) : null;
  }
  if (name === "getAll") return liveJobs(selectAllStmt.all());
  if (name === "getByPlaylistType") {
    const limit = Number(second);
    const rows = Number.isFinite(limit) && limit > 0
      ? livePlaylistJobsLimitedStmt.all(first ?? null, Math.floor(limit))
      : livePlaylistJobsStmt.all(first ?? null);
    return liveJobs(rows);
  }
  if (name === "getByPlaylistId") {
    return liveJobs(livePlaylistIdJobsStmt.all(first ?? null, first ?? null));
  }
  if (name === "getByStatus") return liveJobs(liveStatusJobsStmt.all(first ?? null));
  if (name === "getDoneWithFinalPath") {
    const limit = Number.isFinite(Number(first)) && Number(first) > 0 ? Math.floor(Number(first)) : 500;
    return liveJobs(liveDoneWithPathStmt.all(limit));
  }
  if (name === "getNextPending") {
    const row = liveNextPendingStmt.get();
    return row ? rowToJob(row) : null;
  }
  if (name === "peekPending") {
    const limit = Number.isFinite(Number(first)) && Number(first) > 0 ? Math.floor(Number(first)) : 10;
    return liveJobs(livePendingStmt.all(limit));
  }
  if (name === "hasActiveJobsForPlaylist") {
    return !!liveActivePlaylistStmt.get(first ?? null);
  }
  if (name === "getActiveByPlaylistType") return liveJobs(liveActivePlaylistJobsStmt.all(first ?? null));
  if (name === "getByAlbumMbid") {
    const jobs = [];
    for (const row of liveAlbumJobsStmt.iterate()) {
      if (first(row.album_mbid)) jobs.push(rowToJob(row));
    }
    return sortByCreatedAt(jobs);
  }
  if (name === "getRevision") return persistedRevisionStmt.get()?.revision || 0;
  if (name === "getStats" || name === "getStatsByPlaylistType" || name === "getPlaylistTypeStats") {
    const byPlaylist = {};
    const totals = emptyLiveStats();
    for (const row of liveStatsStmt.all()) {
      const count = Number(row.count) || 0;
      if (!byPlaylist[row.playlist_type]) byPlaylist[row.playlist_type] = emptyLiveStats();
      if (row.status in totals) {
        byPlaylist[row.playlist_type][row.status] += count;
        byPlaylist[row.playlist_type].total += count;
        totals[row.status] += count;
        totals.total += count;
      }
    }
    if (name === "getStats") return totals;
    if (name === "getPlaylistTypeStats") return byPlaylist[String(first)] || emptyLiveStats();
    if (!Array.isArray(first) || first.length === 0) return byPlaylist;
    return Object.fromEntries(first.map((id) => [id, byPlaylist[id] || emptyLiveStats()]));
  }
  return undefined;
}

const LIVE_READ_METHODS = new Set([
  "getJob", "getAll", "getByPlaylistType", "getByPlaylistId", "getByStatus", "getDoneWithFinalPath",
  "getNextPending", "peekPending", "hasActiveJobsForPlaylist", "getActiveByPlaylistType", "getByAlbumMbid",
  "getRevision", "getStats", "getStatsByPlaylistType", "getPlaylistTypeStats",
]);

for (const name of Object.getOwnPropertyNames(DownloadTracker.prototype)) {
  if (name === "constructor" || name.startsWith("_")) continue;
  const original = DownloadTracker.prototype[name];
  if (typeof original !== "function") continue;
  DownloadTracker.prototype[name] = function (...args) {
    if (process.env.NODE_ENV !== "test" && process.env.AURRAL_TEST_SERVER !== "1" &&
        process.env.AURRAL_BACKGROUND_WORKER_GROUP !== "downloads" && LIVE_READ_METHODS.has(name)) {
      return readTrackerFromDatabase(name, args);
    }
    this._refreshExternalChanges();
    return original.apply(this, args);
  };
}

export const downloadTracker = new DownloadTracker();
