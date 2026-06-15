import { randomUUID } from "crypto";
import { db } from "../config/db-sqlite.js";
import { enqueuePipelineJob } from "./honkerDb.js";
import { slskdClient } from "./slskdClient.js";
import { buildPlaylistDestination } from "./playlistPaths.js";

const JOBS_TABLE = "playlist_download_jobs";

function parseArtistAliases(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function stringifyArtistAliases(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function parseAlbumTrackTitles(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function stringifyAlbumTrackTitles(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function normalizePositiveInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
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
    trackMbid: row.track_mbid || null,
    releaseYear: row.release_year || null,
    durationMs:
      row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
        ? Number(row.duration_ms)
        : null,
    trackNumber: normalizePositiveInteger(row.track_number),
    albumTrackCount: normalizePositiveInteger(row.album_track_count),
    albumTrackTitles: parseAlbumTrackTitles(row.album_track_titles),
    artistAliases: parseArtistAliases(row.artist_aliases),
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
    slskdSearchId: row.slskd_search_id || null,
    slskdBatchId: row.slskd_batch_id || null,
    remoteUsername: row.remote_username || null,
    remoteFilename: row.remote_filename || null,
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
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      artist_aliases = ?
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`);
const deleteAllStmt = db.prepare(`DELETE FROM ${JOBS_TABLE}`);
const selectAllStmt = db.prepare(
  `SELECT * FROM ${JOBS_TABLE} ORDER BY created_at ASC, id ASC`,
);
const updatePlaylistTypeStmt = db.prepare(
  `UPDATE ${JOBS_TABLE} SET playlist_type = ?, playlist_id = ? WHERE playlist_type = ?`,
);
const clearSlskdMetaStmt = db.prepare(`
  UPDATE ${JOBS_TABLE}
  SET slskd_search_id = NULL,
      slskd_batch_id = NULL,
      remote_username = NULL,
      remote_filename = NULL
  WHERE id = ?
`);

const sortByCreatedAt = (jobs) =>
  jobs.sort((a, b) => {
    const aCreated = Number(a?.createdAt ?? 0);
    const bCreated = Number(b?.createdAt ?? 0);
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

function sanitizePathPart(value, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

function buildPipelinePayload(job) {
  const playlistId = job.playlistId || job.playlistType;
  const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
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
    destination: buildPlaylistDestination(playlistId, artistDir, albumDir),
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
    this._load();
  }

  isSlskdDispatched(id) {
    const job = this.jobs.get(id);
    return (
      this.slskdDispatched.has(id) ||
      !!job?.slskdBatchId ||
      !!job?.slskdSearchId
    );
  }

  markSlskdDispatched(id) {
    this.slskdDispatched.add(id);
  }

  clearSlskdDispatched(id) {
    this.slskdDispatched.delete(id);
  }

  clearSlskdPipelineState(id) {
    this.clearSlskdDispatched(id);
    const job = this.jobs.get(id);
    if (job) {
      job.slskdSearchId = null;
      job.slskdBatchId = null;
      job.remoteUsername = null;
      job.remoteFilename = null;
    }
    clearSlskdMetaStmt.run(id);
  }

  enqueueSlskdPipeline(jobId) {
    if (!slskdClient.isConfigured()) return false;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;
    if (this.isSlskdDispatched(jobId)) return false;
    enqueuePipelineJob(buildPipelinePayload(job));
    this.markSlskdDispatched(jobId);
    return true;
  }

  _emptyStats() {
    return {
      total: 0,
      pending: 0,
      downloading: 0,
      done: 0,
      failed: 0,
    };
  }

  _cloneStats(stats) {
    return {
      total: Number(stats?.total || 0),
      pending: Number(stats?.pending || 0),
      downloading: Number(stats?.downloading || 0),
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
      if (job.status === "pending") {
        this.pendingFreshQueue.push(job.id);
        this.pendingSet.add(job.id);
      }
    }
  }

  _removeFromPendingQueues(id) {
    this.pendingFreshQueue = this.pendingFreshQueue.filter(
      (entryId) => entryId !== id,
    );
    this.pendingRetryQueue = this.pendingRetryQueue.filter(
      (entryId) => entryId !== id,
    );
  }

  _load() {
    const rows = selectAllStmt.all();
    for (const row of rows) {
      const job = rowToJob(row);
      if (job.playlistType === "recommended") {
        job.playlistType = "discover";
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
          stringifyAlbumTrackTitles(job.albumTrackTitles),
          stringifyArtistAliases(job.artistAliases),
          job.id,
        );
        updatePlaylistTypeStmt.run("discover", "discover", "recommended");
      }
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
          stringifyAlbumTrackTitles(job.albumTrackTitles),
          stringifyArtistAliases(job.artistAliases),
          job.id,
        );
      }
      this.jobs.set(job.id, job);
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
      stringifyAlbumTrackTitles(job.albumTrackTitles),
      stringifyArtistAliases(job.artistAliases),
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
    );
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
      stringifyAlbumTrackTitles(job.albumTrackTitles),
      stringifyArtistAliases(job.artistAliases),
      job.id,
    );
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
      albumTrackTitles: Array.isArray(track?.albumTrackTitles)
        ? track.albumTrackTitles
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
        : [],
      artistAliases: Array.isArray(track?.artistAliases)
        ? track.artistAliases
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
        : [],
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

  updateMetadata(id, metadata = {}) {
    const job = this.jobs.get(id);
    if (!job || !metadata || typeof metadata !== "object") return false;
    let changed = false;
    const assignString = (key) => {
      if (!(key in metadata)) return;
      const nextValue = metadata[key]
        ? String(metadata[key]).trim() || null
        : null;
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
      const nextAliases = Array.isArray(metadata.artistAliases)
        ? metadata.artistAliases
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
        : [];
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
      const nextTitles = Array.isArray(metadata.albumTrackTitles)
        ? metadata.albumTrackTitles
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
        : [];
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
      if (
        lastPlaylistType &&
        String(job.playlistType || "") === String(lastPlaylistType || "")
      ) {
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
      accepts(job);
    this.pendingFreshQueue = this._compactPendingQueue(this.pendingFreshQueue);
    const nextFresh = this._pickPendingFromQueue(
      this.pendingFreshQueue,
      lastPlaylistType,
    );
    if (canProcess(nextFresh)) return nextFresh;
    for (const id of this.pendingFreshQueue) {
      const job = this.jobs.get(id);
      if (canProcess(job)) return job;
    }
    this.pendingRetryQueue = this._compactPendingQueue(this.pendingRetryQueue);
    const nextRetry = this._pickPendingFromQueue(
      this.pendingRetryQueue,
      lastPlaylistType,
    );
    if (canProcess(nextRetry)) return nextRetry;
    for (const id of this.pendingRetryQueue) {
      const job = this.jobs.get(id);
      if (canProcess(job)) return job;
    }
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
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : 10;
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
    job.error =
      typeof error === "string" ? error : (error && error.message) || null;
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
    job.error =
      typeof error === "string" ? error : (error && error.message) || null;
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
    this.clearSlskdPipelineState(id);
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
    this.clearSlskdPipelineState(id);
    this.pendingSet.delete(id);
    this.pendingRetrySet.delete(id);
    this._removeFromPendingQueues(id);
    job.status = "failed";
    job.retryCycle = false;
    job.completedAt = Date.now();
    job.error =
      typeof error === "string" ? error : (error && error.message) || null;
    this._update(job);
    this._applyStatusDelta(job.playlistType, previousStatus, job.status);
    return true;
  }

  getByPlaylistType(playlistType, limit = null) {
    const jobs = [];
    const max =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : null;
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
      count += 1;
    }
    return count;
  }

  getAll() {
    return sortByCreatedAt(Array.from(this.jobs.values()));
  }

  getStats() {
    return this._cloneStats(this.globalStats);
  }

  getStatsByPlaylistType(playlistTypes = []) {
    const statsByType = {};
    if (Array.isArray(playlistTypes) && playlistTypes.length > 0) {
      for (const playlistType of playlistTypes) {
        statsByType[playlistType] = this._cloneStats(
          this.statsByPlaylistType.get(String(playlistType)) ||
            this._emptyStats(),
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

  clearCompleted() {
    const toDelete = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "done" || job.status === "failed") {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.jobs.delete(id);
      deleteStmt.run(id);
    }
    if (toDelete.length > 0) {
      this._rebuildStatsByPlaylistType();
    }
    return toDelete.length;
  }

  clearByPlaylistType(playlistType) {
    const toDelete = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.playlistType === playlistType) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.jobs.delete(id);
      deleteStmt.run(id);
    }
    if (toDelete.length > 0) {
      this._rebuildStatsByPlaylistType();
    }
    return toDelete.length;
  }

  clearPendingByPlaylistType(playlistType) {
    const toDelete = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.playlistType === playlistType && job.status === "pending") {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.jobs.delete(id);
      this.pendingSet.delete(id);
      this.pendingRetrySet.delete(id);
      this._removeFromPendingQueues(id);
      deleteStmt.run(id);
    }
    if (toDelete.length > 0) {
      this._rebuildStatsByPlaylistType();
    }
    return toDelete.length;
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
    return count;
  }
}

export const downloadTracker = new WeeklyFlowDownloadTracker();
