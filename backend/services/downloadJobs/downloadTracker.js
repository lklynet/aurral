import { randomUUID } from "crypto";
import path from "node:path";
import { db } from "../../config/db-sqlite.js";
import { enqueuePipelineJob, listHonkerJobs } from "../honkerDb.js";
import {
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
import { logger } from "../logger.js";
import { recordAlbumGrabQueued, recordAlbumTrackState } from "../albumGrabActivity.js";
import {
  cancelDownloadJob,
  beginDownloadAttempt,
  setActiveDownloadAttemptId,
  cancelDownloadJobs,
  getOwnerDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
} from "./downloadCancellation.js";

const parseDeniedSources = (raw) => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const JOBS_TABLE = "download_jobs";
const dataVersionStmt = db.prepare("PRAGMA data_version");
const persistedRevisionStmt = db.prepare(
  "SELECT revision FROM download_jobs_revision WHERE id = 1",
);
const liveJobStmt = db.prepare(`SELECT * FROM ${JOBS_TABLE} WHERE id = ?`);
const liveOwnerJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE owner_id = ? AND upgrade_for_job_id IS NULL ORDER BY created_at, id`,
);
const liveAllOwnerJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE owner_id = ? ORDER BY created_at, id`,
);
const liveOwnerJobsLimitedStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE owner_id = ? AND upgrade_for_job_id IS NULL ORDER BY created_at, id LIMIT ?`,
);
const liveStatusJobsStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} WHERE status = ? ORDER BY created_at, id`,
);
const liveStatsStmt = db.prepare(
  `SELECT owner_id, upgrade_for_job_id IS NOT NULL AS upgrade, status, COUNT(*) AS count
   FROM ${JOBS_TABLE} GROUP BY owner_id, upgrade, status`,
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
const liveActiveOwnerStmt = db.prepare(
  `SELECT 1 FROM ${JOBS_TABLE} WHERE owner_id = ? AND upgrade_for_job_id IS NULL
   AND status IN ('pending', 'downloading') LIMIT 1`,
);

function rowToJob(row) {
  return {
    id: row.id,
    artistName: row.artist_name,
    trackName: row.track_name,
    albumName: row.album_name || null,
    reason: row.reason || null,
    artistMbid: row.artist_mbid || null,
    albumMbid: row.album_mbid || null,
    trackMbid: row.track_mbid || null,
    releaseYear: row.release_year || null,
    durationMs:
      row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
        ? Number(row.duration_ms)
        : null,
    trackNumber: normalizePositiveInteger(row.track_number),
    albumTrackCount: normalizePositiveInteger(row.album_track_count),
    albumTrackTitles: parseStringListJson(row.album_track_titles),
    artistAliases: parseStringListJson(row.artist_aliases),
    ownerId: row.owner_id,
    ownerGeneration: Number(row.owner_generation ?? 0),
    managedBy: row.managed_by === "lidarr" ? "lidarr" : "aurral",
    requestGroupId: row.request_group_id || null,
    albumGrabAttempted: row.album_grab_attempted === 1,
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
    queuedForPlaylist: row.queued_for_playlist === 1,
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
    track_mbid,
    release_year,
    duration_ms,
    track_number,
    album_track_count,
    album_track_titles,
    artist_aliases,
    owner_id,
    owner_generation,
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
    queued_for_playlist
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      track_mbid = ?,
      release_year = ?,
      duration_ms = ?,
      track_number = ?,
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
      manual_replacement_search = ?,
      queued_for_playlist = ?
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`);
const updateAlbumGrabAttemptedStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET album_grab_attempted = ? WHERE id = ?`,
);
const deleteAllStmt = db.prepare(`DELETE FROM ${JOBS_TABLE}`);
const selectAllStmt = db.prepare(`SELECT * FROM ${JOBS_TABLE} ORDER BY created_at ASC, id ASC`);
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
  SET download_source = COALESCE(?, download_source),
      download_client = COALESCE(?, download_client),
      download_client_id = COALESCE(?, download_client_id),
      release_guid = COALESCE(?, release_guid),
      release_title = COALESCE(?, release_title),
      indexer_id = COALESCE(?, indexer_id),
      indexer_name = COALESCE(?, indexer_name),
      remote_username = COALESCE(?, remote_username),
      remote_filename = COALESCE(?, remote_filename)
  WHERE id = ?
`);

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

function buildPipelinePayload(job) {
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
  const ephemeral = Boolean(flowPlaylistConfig.getFlow(job.ownerId));
  return {
    phase: "search",
    downloadAttemptId: beginDownloadAttempt(job.id),
    jobId: job.id,
    ownerId: job.ownerId,
    ownerGeneration: job.ownerGeneration,
    track: {
      artistName: job.artistName,
      trackName: job.trackName,
      albumName: job.albumName,
      artistMbid: job.artistMbid,
      albumMbid: job.albumMbid,
      trackMbid: job.trackMbid,
      releaseYear: job.releaseYear,
      durationMs: job.durationMs,
      trackNumber: job.trackNumber,
      albumTrackCount: job.albumTrackCount,
      albumTrackTitles: job.albumTrackTitles || [],
      artistAliases: job.artistAliases || [],
    },
    attempt: 0,
    destination: buildAurralTrackDestination(job.ownerId, artistDir, albumDir, { ephemeral }),
    upgrade: Boolean(job.upgradeForJobId) && !job.manualReplacementSearch,
    upgradeForJobId: job.upgradeForJobId || null,
    manualReplacementSearch: job.manualReplacementSearch === true,
    allowedSources:
      job.upgradeForJobId && !job.manualReplacementSearch
        ? ["slskd", "usenet", "deemix"]
        : null,
  };
}

function discardReviewFiles(jobs) {
  const held = jobs.filter((job) => job?.status === "blocked" && job.stagingPath)
    .map((job) => ({ ...job }));
  if (held.length === 0) return;
  import("./reviewFiles.js")
    .then(async ({ discardReviewFile }) => {
      for (const job of held) await discardReviewFile(job);
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
    this.statsByOwner = new Map();
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
    this._rebuildStats();
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
        job.downloadSource = null;
        job.downloadClient = null;
        job.downloadClientId = null;
        job.releaseGuid = null;
        job.releaseTitle = null;
        job.indexerId = null;
        job.indexerName = null;
        job.remoteUsername = null;
        job.remoteFilename = null;
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
    const assign = (key, value) => {
      if (value == null) return;
      const text = String(value).trim();
      if (!text) return;
      job[key] = text;
    };
    assign("downloadSource", metadata.downloadSource);
    assign("downloadClient", metadata.downloadClient);
    assign("downloadClientId", metadata.downloadClientId);
    assign("releaseGuid", metadata.releaseGuid);
    assign("releaseTitle", metadata.releaseTitle);
    assign("indexerId", metadata.indexerId);
    assign("indexerName", metadata.indexerName);
    assign("remoteUsername", metadata.remoteUsername);
    assign("remoteFilename", metadata.remoteFilename);
    updateDownloadMetaStmt.run(
      metadata.downloadSource ?? null,
      metadata.downloadClient ?? null,
      metadata.downloadClientId ?? null,
      metadata.releaseGuid ?? null,
      metadata.releaseTitle ?? null,
      metadata.indexerId ?? null,
      metadata.indexerName ?? null,
      metadata.remoteUsername ?? null,
      metadata.remoteFilename ?? null,
      id,
    );
    recordAlbumTrackState(job);
    return true;
  }

  enqueueDownloadPipeline(jobId) {
    if (!isAnyDownloadSourceConfigured()) return false;
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const activeGrab = job.requestGroupId && job.albumGrabAttempted
      ? listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.albumGrab === true
        && entry.payload?.albumGroupJobIds?.includes(jobId))
      : null;
    if (activeGrab && ["pending", "downloading"].includes(job.status)) {
      recordAlbumGrabQueued(activeGrab.payload, activeGrab.payload.albumGroupJobIds.map((id) => this.jobs.get(id)).filter(Boolean));
      for (const siblingId of activeGrab.payload.albumGroupJobIds) {
        if (this.jobs.get(siblingId)?.status === "pending") {
          this.setDownloading(siblingId);
        }
      }
      if (jobId === activeGrab.payload.jobId) this.markSlskdDispatched(jobId);
      return true;
    }
    if (job.status !== "pending" || this.isSlskdDispatched(jobId)) return false;
    const payload = buildPipelinePayload(job);
    if (!isPipelinePayloadActive(payload)) return false;
    const siblings = job.managedBy === "aurral" && job.ownerId === "library"
      && job.requestGroupId && !job.upgradeForJobId && !job.manualReplacementSearch
      && !job.albumGrabAttempted && isAlbumGrabSourceConfigured()
      ? this.getAll().filter((entry) => entry.requestGroupId === job.requestGroupId
        && entry.albumMbid === job.albumMbid && entry.status === "pending"
        && !entry.upgradeForJobId && !entry.manualReplacementSearch && !entry.albumGrabAttempted)
      : [];
    if (siblings.length > 1) {
      payload.albumGrab = true;
      payload.albumGroupJobIds = [jobId, ...siblings.filter((entry) => entry.id !== jobId)
        .sort((left, right) => Number(left.trackNumber || 0) - Number(right.trackNumber || 0)
          || String(left.id).localeCompare(String(right.id)))
        .map((entry) => entry.id)];
      for (const sibling of siblings) {
        setActiveDownloadAttemptId(sibling.id, payload.downloadAttemptId);
        this.setAlbumGrabAttempted(sibling.id, true);
      }
      for (const sibling of siblings) {
        if (sibling.id !== jobId) this.setDownloading(sibling.id);
      }
    }
    try {
      this.enqueuePipeline(payload);
    } catch (error) {
      for (const siblingId of payload.albumGroupJobIds || []) {
        if (siblingId !== jobId) this.setPending(siblingId);
        this.setAlbumGrabAttempted(siblingId, false);
      }
      throw error;
    }
    this.markSlskdDispatched(jobId);
    if (payload.albumGrab === true) recordAlbumGrabQueued(payload, siblings);
    return true;
  }

  enqueueSlskdPipeline(jobId) {
    return this.enqueueDownloadPipeline(jobId);
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

  _getOrCreateOwnerStats(ownerId) {
    const key = String(ownerId || "");
    let stats = this.statsByOwner.get(key);
    if (!stats) {
      stats = this._emptyStats();
      this.statsByOwner.set(key, stats);
    }
    return stats;
  }

  _applyStatusDelta(job, fromStatus, toStatus) {
    const ownerId = job.upgradeForJobId ? null : job.ownerId;
    if (ownerId) {
      const stats = this._getOrCreateOwnerStats(ownerId);
      if (fromStatus && stats[fromStatus] > 0) {
        stats[fromStatus] -= 1;
        stats.total = Math.max(0, stats.total - 1);
      }
      if (toStatus) {
        stats[toStatus] = (stats[toStatus] || 0) + 1;
        stats.total += 1;
      }
      if (stats.total <= 0) {
        this.statsByOwner.delete(String(ownerId));
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

  _rebuildStats() {
    this.statsByOwner.clear();
    this.globalStats = this._emptyStats();
    this.pendingFreshQueue = [];
    this.pendingRetryQueue = [];
    this.pendingSet = new Set();
    this.pendingRetrySet = new Set();
    for (const job of this.jobs.values()) {
      this._applyStatusDelta(job, null, job.status);
      if (job.status === "pending" && !job.upgradeForJobId) {
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
          job.trackMbid ?? null,
          job.releaseYear ?? null,
          job.durationMs ?? null,
          job.trackNumber ?? null,
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
          job.queuedForPlaylist ? 1 : 0,
          job.id,
        );
      }
      this.jobs.set(job.id, job);
    }
    if (process.env.AURRAL_BACKGROUND_WORKER_GROUP === "downloads" ||
        process.env.NODE_ENV === "test" || process.env.AURRAL_TEST_SERVER === "1") {
      for (const job of this.jobs.values()) {
        if (job.status === "pending" && job.upgradeForJobId && !job.manualReplacementSearch) {
          this.removeJob(job.id);
        }
      }
    }
    this._rebuildStats();
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
      job.trackMbid ?? null,
      job.releaseYear ?? null,
      job.durationMs ?? null,
      job.trackNumber ?? null,
      job.albumTrackCount ?? null,
      stringifyStringListJson(job.albumTrackTitles),
      stringifyStringListJson(job.artistAliases),
      job.ownerId,
      job.ownerGeneration ?? 0,
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
      job.queuedForPlaylist ? 1 : 0,
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
      job.trackMbid ?? null,
      job.releaseYear ?? null,
      job.durationMs ?? null,
      job.trackNumber ?? null,
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
      job.queuedForPlaylist ? 1 : 0,
      job.id,
    );
    recordAlbumTrackState(job);
    this._touchRevision();
  }

  addJob(track, ownerId, options = {}) {
    const id = randomUUID();
    const artistName = String(track?.artistName || "").trim();
    const trackName = String(track?.trackName || "").trim();
    if (!artistName || !trackName) {
      return null;
    }
    const job = {
      id,
      artistName,
      trackName,
      albumName: track?.albumName ? String(track.albumName).trim() : null,
      reason: track?.reason ? String(track.reason).trim() : null,
      artistMbid: track?.artistMbid ? String(track.artistMbid).trim() : null,
      albumMbid: track?.albumMbid ? String(track.albumMbid).trim() : null,
      trackMbid: track?.trackMbid ? String(track.trackMbid).trim() : null,
      releaseYear: track?.releaseYear ? String(track.releaseYear).trim() : null,
      durationMs:
        track?.durationMs != null && Number.isFinite(Number(track.durationMs))
          ? Math.max(0, Math.round(Number(track.durationMs)))
          : null,
      trackNumber: normalizePositiveInteger(track?.trackNumber),
      albumTrackCount: normalizePositiveInteger(track?.albumTrackCount),
      albumTrackTitles: normalizeStringList(track?.albumTrackTitles),
      artistAliases: normalizeStringList(track?.artistAliases),
      ownerId,
      ownerGeneration: Number.isInteger(options?.ownerGeneration)
        ? options.ownerGeneration
        : getOwnerDownloadGeneration(ownerId),
      upgradeForJobId: options?.upgradeForJobId || null,
      manualReplacementSearch: options?.manualReplacementSearch === true,
      managedBy: track?.managedBy === "lidarr" ? "lidarr" : "aurral",
      requestGroupId: track?.requestGroupId
        ? String(track.requestGroupId).trim() || null
        : null,
      queuedForPlaylist: options?.queuedForPlaylist === true,
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
    this._applyStatusDelta(job, null, job.status);
    if (!job.upgradeForJobId) {
      this.pendingFreshQueue.push(id);
      this.pendingSet.add(id);
    }
    return id;
  }

  setQueuedForPlaylist(id, queuedForPlaylist) {
    const job = this.jobs.get(id);
    if (!job || job.queuedForPlaylist === queuedForPlaylist) return false;
    job.queuedForPlaylist = queuedForPlaylist;
    this._update(job);
    return true;
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
    );
    if (!id || !this.setDone(id, resolvedPath, track?.albumName)) return null;
    return this.jobs.get(id) || null;
  }

  addJobs(tracks, ownerId) {
    const ids = [];
    for (const track of tracks) {
      const id = this.addJob(track, ownerId);
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
    return this.addJob(sourceJob, sourceJob.ownerId, {
      ownerGeneration: sourceJob.ownerGeneration,
      upgradeForJobId: sourceJob.id,
    });
  }

  addReplacementSearchJob(sourceJob) {
    if (!sourceJob?.id || sourceJob.status !== "done" || !sourceJob.finalPath) return null;
    if (this.findActiveUpgradeJob(sourceJob)) return null;
    return this.addJob(sourceJob, sourceJob.ownerId, {
      upgradeForJobId: sourceJob.id,
      manualReplacementSearch: true,
    });
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
    if ("trackNumber" in metadata) {
      const nextTrackNumber = normalizePositiveInteger(metadata.trackNumber);
      if (job.trackNumber !== nextTrackNumber) {
        job.trackNumber = nextTrackNumber;
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
    this._applyStatusDelta(job, job.status, null);
    deleteStmt.run(id);
    this._touchRevision();
    return true;
  }

  _pickPendingFromQueue(queue, lastOwnerId = null) {
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
      if (lastOwnerId && String(job.ownerId || "") === String(lastOwnerId || "")) {
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

  getNextPending(lastOwnerId = null) {
    return this.getNextPendingMatching(() => true, lastOwnerId);
  }

  _shouldSkipForWorker(job) {
    return job?.status === "pending" && this.isSlskdDispatched(job.id);
  }

  getNextPendingMatching(predicate = null, lastOwnerId = null) {
    const accepts = typeof predicate === "function" ? predicate : () => true;
    const canProcess = (job) =>
      job &&
      job.status === "pending" &&
      !this._shouldSkipForWorker(job) &&
      isPipelinePayloadActive({
        jobId: job.id,
        ownerId: job.ownerId,
        ownerGeneration: job.ownerGeneration,
      }) &&
      accepts(job);
    this.pendingFreshQueue = this._compactPendingQueue(this.pendingFreshQueue);
    const nextFresh = this._pickPendingFromQueue(this.pendingFreshQueue, lastOwnerId);
    if (canProcess(nextFresh)) return nextFresh;
    this.pendingRetryQueue = this._compactPendingQueue(this.pendingRetryQueue);
    const nextRetry = this._pickPendingFromQueue(this.pendingRetryQueue, lastOwnerId);
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
    this._applyStatusDelta(job, previousStatus, job.status);
    return true;
  }

  setPending(id, error = null, options = {}) {
    const job = this.jobs.get(id);
    if (!job || this._isCancelledAlbumJob(job)) return false;
    const previousStatus = job.status;
    const asRetryCycle = options?.asRetryCycle === true;
    if (asRetryCycle) this.setAlbumGrabAttempted(id, false);
    this.clearSlskdPipelineState(id);
    job.status = "pending";
    job.startedAt = null;
    job.completedAt = null;
    job.stagingPath = null;
    job.finalPath = null;
    job.retryCycle = asRetryCycle;
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._applyStatusDelta(job, previousStatus, job.status);
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
    this._applyStatusDelta(job, "downloading", job.status);
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
    this._applyStatusDelta(job, previousStatus, job.status);
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
    job.finalPath = finalPath;
    job.externalPath = externalPath ?? null;
    const safeAlbum = String(albumName || "").trim();
    if (safeAlbum) {
      job.albumName = safeAlbum;
    } else if (!job.albumName) {
      job.albumName = null;
    }
    this._update(job);
    this._applyStatusDelta(job, previousStatus, job.status);
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
    job.error = typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._applyStatusDelta(job, previousStatus, job.status);
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
    this._applyStatusDelta(job, previousStatus, job.status);
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

  getByOwner(ownerId, limit = null) {
    const jobs = [];
    const max =
      Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : null;
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId && !job.upgradeForJobId) {
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

  getAllForOwner(ownerId) {
    const safeOwnerId = String(ownerId || "").trim();
    if (!safeOwnerId) return [];
    return sortByCreatedAt([...this.jobs.values()].filter((job) => job.ownerId === safeOwnerId));
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
        this._applyStatusDelta(job, previousStatus, job.status);
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

  hasActiveJobsForOwner(ownerId) {
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId || job.upgradeForJobId) continue;
      if (job.status === "pending" || job.status === "downloading") {
        return true;
      }
    }
    return false;
  }

  failActiveJobsForOwner(ownerId, error = "Retry cycle paused") {
    let count = 0;
    const failedJobs = [];
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId || job.upgradeForJobId) continue;
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
      this._applyStatusDelta(job, previousStatus, job.status);
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

  getStatsByOwner(ownerIds = []) {
    const statsByOwner = {};
    if (Array.isArray(ownerIds) && ownerIds.length > 0) {
      for (const ownerId of ownerIds) {
        statsByOwner[ownerId] = this._cloneStats(
          this.statsByOwner.get(String(ownerId)) || this._emptyStats(),
        );
      }
      return statsByOwner;
    }
    for (const [ownerId, stats] of this.statsByOwner.entries()) {
      statsByOwner[ownerId] = this._cloneStats(stats);
    }
    return statsByOwner;
  }

  getOwnerStats(ownerId) {
    return this._cloneStats(this.statsByOwner.get(String(ownerId)) || this._emptyStats());
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
      this._rebuildStats();
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

  clearAllForOwner(ownerId) {
    const safeOwnerId = String(ownerId || "").trim();
    if (!safeOwnerId) return 0;
    return this._deleteJobsWhere((job) => job.ownerId === safeOwnerId);
  }

  clearPendingByOwner(ownerId) {
    return this._deleteJobsWhere(
      (job) => job.ownerId === ownerId && !job.upgradeForJobId && job.status === "pending",
      { cleanPending: true },
    );
  }

  clearAll() {
    const count = this.jobs.size;
    discardReviewFiles([...this.jobs.values()]);
    this.jobs.clear();
    this.statsByOwner.clear();
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
  if (name === "getByOwner") {
    const limit = Number(second);
    const rows = Number.isFinite(limit) && limit > 0
      ? liveOwnerJobsLimitedStmt.all(first ?? null, Math.floor(limit))
      : liveOwnerJobsStmt.all(first ?? null);
    return liveJobs(rows);
  }
  if (name === "getAllForOwner") return liveJobs(liveAllOwnerJobsStmt.all(first ?? null));
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
  if (name === "hasActiveJobsForOwner") {
    return !!liveActiveOwnerStmt.get(first ?? null);
  }
  if (name === "getRevision") return persistedRevisionStmt.get()?.revision || 0;
  if (name === "getStats" || name === "getStatsByOwner" || name === "getOwnerStats") {
    const byOwner = {};
    const totals = emptyLiveStats();
    for (const row of liveStatsStmt.all()) {
      const count = Number(row.count) || 0;
      if (!(row.status in totals)) continue;
      totals[row.status] += count;
      totals.total += count;
      if (row.upgrade) continue;
      byOwner[row.owner_id] ??= emptyLiveStats();
      byOwner[row.owner_id][row.status] += count;
      byOwner[row.owner_id].total += count;
    }
    if (name === "getStats") return totals;
    if (name === "getOwnerStats") return byOwner[String(first)] || emptyLiveStats();
    if (!Array.isArray(first) || first.length === 0) return byOwner;
    return Object.fromEntries(first.map((id) => [id, byOwner[id] || emptyLiveStats()]));
  }
  return undefined;
}

const LIVE_READ_METHODS = new Set([
  "getJob", "getAll", "getByOwner", "getAllForOwner", "getByStatus", "getDoneWithFinalPath",
  "getNextPending", "peekPending", "hasActiveJobsForOwner", "getRevision",
  "getStats", "getStatsByOwner", "getOwnerStats",
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
