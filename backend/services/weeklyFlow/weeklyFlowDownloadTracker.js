import { randomUUID } from "crypto";
import { db } from "../../config/db-sqlite.js";
import { enqueuePipelineJob } from "../honkerDb.js";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.js";
import {
  normalizePositiveInteger,
  normalizeStringList,
  parseStringListJson,
  sanitizePathPart,
  stringifyStringListJson,
} from "../playlistDownloadUtils.js";
import {
  buildAurralTrackDestination,
} from "../playlistPaths.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";

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
    playlistId: row.playlist_id || row.playlist_type,
    playlistType: row.playlist_type || row.playlist_id,
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
    playlist_id,
    playlist_type,
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
    upgrade_for_job_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      upgrade_for_job_id = ?
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`);
const deleteAllStmt = db.prepare(`DELETE FROM ${JOBS_TABLE}`);
const selectAllStmt = db.prepare(`SELECT * FROM ${JOBS_TABLE} ORDER BY created_at ASC, id ASC`);
const updatePlaylistTypeStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET playlist_type = ?, playlist_id = ? WHERE playlist_type = ?`,
);
const updatePlaylistIdStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET playlist_id = ? WHERE id = ?`,
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
  const playlistId = job.playlistId || job.playlistType;
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
  const ephemeral = Boolean(flowPlaylistConfig.getFlow(String(job.playlistType || "").trim()));
  return {
    phase: "search",
    jobId: job.id,
    playlistId,
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
    destination: buildAurralTrackDestination(playlistId, artistDir, albumDir, { ephemeral }),
    upgrade: Boolean(job.upgradeForJobId),
    upgradeForJobId: job.upgradeForJobId || null,
    allowedSources: job.upgradeForJobId ? ["slskd", "usenet"] : null,
  };
}

export class WeeklyFlowDownloadTracker {
  constructor() {
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
  }

  _touchRevision() {
    this.revision += 1;
  }

  isSlskdDispatched(id) {
    const job = this.jobs.get(id);
    return this.slskdDispatched.has(id) || !!job?.slskdBatchId || !!job?.slskdSearchId;
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
    return true;
  }

  enqueueDownloadPipeline(jobId) {
    if (!isAnyDownloadSourceConfigured()) return false;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;
    if (this.isSlskdDispatched(jobId)) return false;
    enqueuePipelineJob(buildPipelinePayload(job));
    this.markSlskdDispatched(jobId);
    return true;
  }

  enqueueSlskdPipeline(jobId) {
    return this.enqueueDownloadPipeline(jobId);
  }

  _emptyStats() {
    return {
      total: 0,
      pending: 0,
      downloading: 0,
      blocked: 0,
      done: 0,
      failed: 0,
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
    updatePlaylistTypeStmt.run("discover", "discover", "recommended");
    const rows = selectAllStmt.all();
    for (const row of rows) {
      const job = rowToJob(row);
      if (job.status === "downloading") {
        job.status = "pending";
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
          job.id,
        );
      }
      this.jobs.set(job.id, job);
    }
    for (const job of this.jobs.values()) {
      if (job.status === "pending" && job.upgradeForJobId) this.removeJob(job.id);
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
      job.trackMbid ?? null,
      job.releaseYear ?? null,
      job.durationMs ?? null,
      job.trackNumber ?? null,
      job.albumTrackCount ?? null,
      stringifyStringListJson(job.albumTrackTitles),
      stringifyStringListJson(job.artistAliases),
      job.playlistId || job.playlistType,
      job.playlistType || job.playlistId,
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
      job.id,
    );
    this._touchRevision();
  }

  addJob(track, playlistType) {
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
      playlistId: playlistType,
      playlistType,
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
        (job.status !== "pending" && job.status !== "downloading")
      ) {
        return false;
      }
      return this.jobs.get(job.upgradeForJobId)?.finalPath === sourceJob.finalPath;
    }) || null;
  }

  addUpgradeJob(sourceJob) {
    if (!sourceJob?.id || sourceJob.status !== "done" || !sourceJob.finalPath) return null;
    if (this.findActiveUpgradeJob(sourceJob)) return null;
    const id = this.addJob(sourceJob, "quality-upgrade");
    const job = this.jobs.get(id);
    job.playlistId = sourceJob.playlistId || sourceJob.playlistType;
    job.upgradeForJobId = sourceJob.id;
    updatePlaylistIdStmt.run(job.playlistId, id);
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
      job && job.status === "pending" && !this._shouldSkipForWorker(job) && accepts(job);
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
    if (!job) return false;
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
    if (!job) return false;
    const previousStatus = job.status;
    const asRetryCycle = options?.asRetryCycle === true;
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
    if (!job || job.status !== "pending") return false;
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

  setDone(id, finalPath, albumName = null, externalPath = null) {
    const job = this.jobs.get(id);
    if (!job) return false;
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
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setFailed(id, error) {
    const job = this.jobs.get(id);
    if (!job) return false;
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
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  setBlocked(id, error, stagingPath = null) {
    const job = this.jobs.get(id);
    if (!job) return false;
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
        .catch(() => {});
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
    return this._deleteJobsWhere((job) => job.status === "done" || job.status === "failed");
  }

  clearByPlaylistType(playlistType) {
    return this._deleteJobsWhere((job) => job.playlistType === playlistType);
  }

  clearPendingByPlaylistType(playlistType) {
    return this._deleteJobsWhere(
      (job) => job.playlistType === playlistType && job.status === "pending",
      { cleanPending: true },
    );
  }

  clearAll() {
    const count = this.jobs.size;
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

export const downloadTracker = new WeeklyFlowDownloadTracker();
