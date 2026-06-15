import { randomUUID } from "crypto";
import { db } from "../config/db-sqlite.js";

const RECENT_HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CLEANUP_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const FAILURE_STATUSES = new Set([
  "batch_empty",
  "enqueue_failed",
  "missing_file",
  "transfer_failed",
  "transfer_timeout",
  "validation_failed",
]);

const insertOutcomeStmt = db.prepare(`
  INSERT INTO slskd_transfer_history (
    id,
    job_id,
    username,
    remote_filename,
    transfer_id,
    search_id,
    batch_id,
    status,
    reason,
    score,
    artist_name,
    track_name,
    album_name,
    source_path,
    final_path,
    actual_duration_ms,
    created_at,
    cleaned_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);

const recentPeerRowsStmt = db.prepare(`
  SELECT
    LOWER(username) AS user_key,
    username,
    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
    SUM(CASE WHEN status IN (
      'batch_empty',
      'enqueue_failed',
      'missing_file',
      'transfer_failed',
      'transfer_timeout',
      'validation_failed'
    ) THEN 1 ELSE 0 END) AS failures,
    SUM(CASE WHEN status = 'validation_failed' THEN 1 ELSE 0 END) AS validation_failures,
    MAX(created_at) AS latest_at
  FROM slskd_transfer_history
  WHERE created_at >= ?
  GROUP BY LOWER(username)
`);

const activePeerRowsStmt = db.prepare(`
  SELECT LOWER(remote_username) AS user_key, remote_username AS username, COUNT(*) AS active
  FROM playlist_download_jobs
  WHERE status = 'downloading'
    AND remote_username IS NOT NULL
    AND TRIM(remote_username) != ''
  GROUP BY LOWER(remote_username)
`);

const cleanupRowsStmt = db.prepare(`
  SELECT id, username, remote_filename, transfer_id, search_id
  FROM slskd_transfer_history
  WHERE cleaned_at IS NULL
    AND created_at >= ?
    AND status IN (
      'batch_empty',
      'enqueue_failed',
      'missing_file',
      'success',
      'transfer_failed',
      'transfer_timeout',
      'validation_failed'
    )
  ORDER BY created_at ASC
`);

const markCleanedStmt = db.prepare(`
  UPDATE slskd_transfer_history
  SET cleaned_at = ?
  WHERE cleaned_at IS NULL
    AND created_at >= ?
`);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeUsername(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSearchIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = values
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  return [...new Set(ids)];
}

function serializeSearchIds(value) {
  const ids = normalizeSearchIds(value);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return JSON.stringify(ids);
}

function deserializeSearchIds(value) {
  const text = normalizeText(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return normalizeSearchIds(parsed);
    } catch {}
  }
  return [text];
}

function readCandidateRaw(candidate) {
  return candidate?.raw && typeof candidate.raw === "object"
    ? candidate.raw
    : {};
}

function readTransferId(transfer) {
  return normalizeText(
    transfer?.id ||
      transfer?.Id ||
      transfer?.transferId ||
      transfer?.TransferId ||
      "",
  );
}

export function recordSlskdTransferOutcome({
  job = null,
  candidate = null,
  status,
  reason = null,
  transfer = null,
  transferId = null,
  searchIds = [],
  batchId = null,
  sourcePath = null,
  finalPath = null,
  validation = null,
} = {}) {
  const raw = readCandidateRaw(candidate);
  const username = normalizeText(raw.user || candidate?.username || job?.remoteUsername);
  if (!username) return null;
  const normalizedStatus = normalizeText(status) || "unknown";
  const actualTransferId = normalizeText(transferId) || readTransferId(transfer);
  const rowId = randomUUID();
  insertOutcomeStmt.run(
    rowId,
    job?.id || null,
    username,
    normalizeText(raw.file || candidate?.file || job?.remoteFilename) || null,
    actualTransferId || null,
    serializeSearchIds(searchIds),
    normalizeText(batchId || job?.slskdBatchId) || null,
    normalizedStatus,
    normalizeText(reason) || null,
    Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
    normalizeText(job?.artistName) || null,
    normalizeText(job?.trackName) || null,
    normalizeText(job?.albumName) || normalizeText(candidate?.resolvedAlbumName) || null,
    normalizeText(sourcePath) || null,
    normalizeText(finalPath) || null,
    Number.isFinite(Number(validation?.actualDurationMs))
      ? Math.round(Number(validation.actualDurationMs))
      : null,
    Date.now(),
  );
  return rowId;
}

export function buildSlskdRankingHistoryOptions() {
  const cutoff = Date.now() - RECENT_HISTORY_WINDOW_MS;
  const peerStats = new Map();
  for (const row of recentPeerRowsStmt.all(cutoff)) {
    const key = normalizeUsername(row.user_key || row.username);
    if (!key) continue;
    peerStats.set(key, {
      successes: Number(row.successes || 0),
      failures: Number(row.failures || 0),
      validationFailures: Number(row.validation_failures || 0),
      active: 0,
    });
  }
  for (const row of activePeerRowsStmt.all()) {
    const key = normalizeUsername(row.user_key || row.username);
    if (!key) continue;
    const stats =
      peerStats.get(key) ||
      { successes: 0, failures: 0, validationFailures: 0, active: 0 };
    stats.active = Number(row.active || 0);
    peerStats.set(key, stats);
  }

  return {
    isUserBlacklisted: (username) => {
      const stats = peerStats.get(normalizeUsername(username));
      if (!stats) return false;
      if (stats.successes > 0) return false;
      return stats.failures >= 5 || stats.validationFailures >= 3;
    },
    getUserQueuePenalty: (username) => {
      const stats = peerStats.get(normalizeUsername(username));
      if (!stats) return 0;
      const penalty =
        stats.active * 80 +
        stats.failures * 25 +
        stats.validationFailures * 20 -
        stats.successes * 8;
      return Math.max(0, Math.min(220, penalty));
    },
  };
}

export function getSlskdCleanupTargets() {
  const cutoff = Date.now() - CLEANUP_HISTORY_WINDOW_MS;
  const rows = cleanupRowsStmt.all(cutoff);
  const searchIds = new Set();
  const transfers = [];
  const seenTransfers = new Set();

  for (const row of rows) {
    for (const searchId of deserializeSearchIds(row.search_id)) {
      searchIds.add(searchId);
    }
    const username = normalizeText(row.username);
    const transferId = normalizeText(row.transfer_id);
    if (username && transferId) {
      const key = `${username}\0${transferId}`;
      if (!seenTransfers.has(key)) {
        seenTransfers.add(key);
        transfers.push({
          username,
          transferId,
          remoteFilename: normalizeText(row.remote_filename) || null,
        });
      }
    }
  }

  return {
    searchIds: [...searchIds],
    transfers,
  };
}

export function markSlskdCleanupTargetsCleaned() {
  const cutoff = Date.now() - CLEANUP_HISTORY_WINDOW_MS;
  markCleanedStmt.run(Date.now(), cutoff);
}

export function isSlskdFailureStatus(status) {
  return FAILURE_STATUSES.has(normalizeText(status));
}
