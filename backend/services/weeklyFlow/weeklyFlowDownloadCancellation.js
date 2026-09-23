import { db } from "../../config/db-sqlite.js";

const playlistCancellationStmt = db.prepare(
  `SELECT generation, state FROM weekly_flow_download_cancellations WHERE playlist_id = ?`,
);
const insertActivePlaylistStmt = db.prepare(
  `INSERT INTO weekly_flow_download_cancellations (playlist_id, generation, state, changed_at)
   VALUES (?, 0, 'active', ?)`,
);
const activateExistingPlaylistStmt = db.prepare(
  `UPDATE weekly_flow_download_cancellations
   SET generation = generation + 1, state = 'active', changed_at = ?
   WHERE playlist_id = ?`,
);
const touchActivePlaylistStmt = db.prepare(
  `UPDATE weekly_flow_download_cancellations
   SET state = 'active', changed_at = ?
   WHERE playlist_id = ?`,
);
const cancelNewPlaylistStmt = db.prepare(
  `INSERT INTO weekly_flow_download_cancellations (playlist_id, generation, state, changed_at)
   VALUES (?, 0, 'cancelled', ?)`,
);
const cancelExistingPlaylistStmt = db.prepare(
  `UPDATE weekly_flow_download_cancellations
   SET state = 'cancelled', changed_at = ?
   WHERE playlist_id = ?`,
);
const jobCancellationStmt = db.prepare(
  `SELECT 1 FROM weekly_flow_download_job_cancellations WHERE job_id = ?`,
);
const cancelJobStmt = db.prepare(
  `INSERT OR IGNORE INTO weekly_flow_download_job_cancellations (job_id, cancelled_at)
   VALUES (?, ?)`,
);
const restoreJobStmt = db.prepare(
  `DELETE FROM weekly_flow_download_job_cancellations WHERE job_id = ?`,
);

const providerWorkInsertStmt = db.prepare(
  `INSERT OR IGNORE INTO weekly_flow_download_provider_work
   (job_id, playlist_id, provider, work_id, username, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const providerWorkDeleteStmt = db.prepare(
  `DELETE FROM weekly_flow_download_provider_work
   WHERE provider = ? AND work_id = ?`,
);

function normalizeId(value) {
  return String(value || "").trim();
}

function readPlaylistCancellation(playlistId) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return null;
  return playlistCancellationStmt.get(safePlaylistId) || null;
}

export function getPlaylistDownloadGeneration(playlistId) {
  return Number(readPlaylistCancellation(playlistId)?.generation || 0);
}

export function activatePlaylistDownloadGeneration(playlistId) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return 0;
  const now = Date.now();
  const activate = db.transaction(() => {
    const current = readPlaylistCancellation(safePlaylistId);
    if (!current) {
      insertActivePlaylistStmt.run(safePlaylistId, now);
      return 0;
    }
    if (current.state === "cancelled") {
      activateExistingPlaylistStmt.run(now, safePlaylistId);
    } else {
      touchActivePlaylistStmt.run(now, safePlaylistId);
    }
    return getPlaylistDownloadGeneration(safePlaylistId);
  });
  return activate();
}

export function cancelPlaylistDownloadGeneration(playlistId) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return 0;
  const now = Date.now();
  const cancel = db.transaction(() => {
    const current = readPlaylistCancellation(safePlaylistId);
    if (!current) {
      cancelNewPlaylistStmt.run(safePlaylistId, now);
      return 0;
    }
    if (current.state !== "cancelled") {
      cancelExistingPlaylistStmt.run(now, safePlaylistId);
    }
    return getPlaylistDownloadGeneration(safePlaylistId);
  });
  return cancel();
}

export function cancelDownloadJob(jobId) {
  const safeJobId = normalizeId(jobId);
  if (!safeJobId) return false;
  return cancelDownloadJobs([safeJobId]) > 0;
}

export function cancelDownloadJobs(jobIds = []) {
  const safeJobIds = [
    ...new Set((Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean)),
  ];
  if (safeJobIds.length === 0) return 0;
  const now = Date.now();
  const cancel = db.transaction(() => {
    let changes = 0;
    for (const jobId of safeJobIds) {
      changes += cancelJobStmt.run(jobId, now).changes;
    }
    return changes;
  });
  return cancel();
}

export function restorePlaylistDownloadWork(playlistId, jobIds = []) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return false;
  const safeJobIds = [...new Set(jobIds.map(normalizeId).filter(Boolean))];
  db.transaction(() => {
    touchActivePlaylistStmt.run(Date.now(), safePlaylistId);
    for (const jobId of safeJobIds) restoreJobStmt.run(jobId);
  })();
  return true;
}

export function registerDownloadProviderWork({
  jobId,
  playlistId,
  provider,
  workId,
  username = "",
} = {}) {
  const safeJobId = normalizeId(jobId);
  const safePlaylistId = normalizeId(playlistId);
  const safeProvider = normalizeId(provider);
  const safeWorkId = normalizeId(workId);
  const safeUsername = normalizeId(username);
  if (!safeJobId || !safeProvider || !safeWorkId) return false;
  providerWorkInsertStmt.run(
    safeJobId,
    safePlaylistId,
    safeProvider,
    safeWorkId,
    safeUsername,
    Date.now(),
  );
  return true;
}

export function listDownloadProviderWork({
  jobIds = [],
  playlistId = null,
  provider = null,
} = {}) {
  const safeJobIds = [...new Set(
    (Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean),
  )];
  const safePlaylistId = normalizeId(playlistId);
  const safeProvider = normalizeId(provider);
  const clauses = [];
  const params = [];
  if (safeProvider) {
    clauses.push("provider = ?");
    params.push(safeProvider);
  }
  const scope = [];
  if (safePlaylistId) {
    scope.push("playlist_id = ?");
    params.push(safePlaylistId);
  }
  if (safeJobIds.length > 0) {
    scope.push(`job_id IN (${safeJobIds.map(() => "?").join(", ")})`);
    params.push(...safeJobIds);
  }
  if (scope.length === 0) return [];
  clauses.push(`(${scope.join(" OR ")})`);
  return db.prepare(
    `SELECT job_id, playlist_id, provider, work_id, username, created_at
     FROM weekly_flow_download_provider_work
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at, work_id`,
  ).all(...params);
}

export function clearDownloadProviderWork({ provider, workId } = {}) {
  const safeProvider = normalizeId(provider);
  const safeWorkId = normalizeId(workId);
  if (!safeProvider || !safeWorkId) return 0;
  return providerWorkDeleteStmt.run(safeProvider, safeWorkId).changes;
}

export function isDownloadJobCancelled(jobId) {
  const safeJobId = normalizeId(jobId);
  return Boolean(safeJobId && jobCancellationStmt.get(safeJobId));
}

export function isPipelinePayloadActive(payload = {}) {
  const jobId = normalizeId(payload.jobId);
  if (jobId && isDownloadJobCancelled(jobId)) return false;

  const playlistId = normalizeId(payload.playlistId);
  if (!playlistId) return true;
  const current = readPlaylistCancellation(playlistId);
  if (!current) {
    return Number(payload.playlistGeneration || 0) === 0;
  }
  if (current.state === "cancelled") return false;
  return Number(payload.playlistGeneration || 0) === Number(current.generation || 0);
}

export async function withPipelineCommitLock(payload, operation) {
  if (!isPipelinePayloadActive(payload)) return { cancelled: true, result: null };
  const playlistId = normalizeId(payload.playlistId);
  if (!playlistId) {
    return { cancelled: false, result: await operation() };
  }
  const { withHonkerLock } = await import("../honkerDb.js");
  return withHonkerLock(
    `playlist-mutation:${playlistId}`,
    async () => {
      if (!isPipelinePayloadActive(payload)) {
        return { cancelled: true, result: null };
      }
      return { cancelled: false, result: await operation() };
    },
    {
      ttlSeconds: 180,
      waitTimeoutMs: 15 * 60 * 1000,
      retryDelayMs: 250,
    },
  );
}
