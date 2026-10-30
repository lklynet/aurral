import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { randomUUID } from "node:crypto";
import type {
  PlaylistDownloadJobsRow,
  SettingsRow,
  WeeklyFlowDownloadCancellationsRow,
  WeeklyFlowDownloadProviderWorkRow,
} from "../../db/rows.ts";

const attemptStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const saveAttemptStmt = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

const UNREADABLE_ATTEMPT = "unreadable-download-attempt";

export function getActiveDownloadAttemptId(jobId: string) {
  const key = `activeDownloadAttempt:${jobId}`;
  const value = attemptStmt.get(key)?.value;
  if (value === undefined || value === "null") return null;
  return dbHelpers.readJSON(v.string(), value, key) ?? UNREADABLE_ATTEMPT;
}

export function beginDownloadAttempt(jobId: string) {
  const id = randomUUID();
  setActiveDownloadAttemptId(jobId, id);
  return id;
}

export function setActiveDownloadAttemptId(jobId: string, id: string | null | undefined) {
  saveAttemptStmt.run(`activeDownloadAttempt:${jobId}`, JSON.stringify(id));
}

const playlistCancellationStmt = db.prepare<
  [string],
  Pick<WeeklyFlowDownloadCancellationsRow, "generation" | "state">
>(`SELECT generation, state FROM weekly_flow_download_cancellations WHERE playlist_id = ?`);
const insertActivePlaylistStmt = db.prepare<[string, number]>(
  `INSERT INTO weekly_flow_download_cancellations (playlist_id, generation, state, changed_at)
   VALUES (?, 0, 'active', ?)`,
);
const activateExistingPlaylistStmt = db.prepare<[number, string]>(
  `UPDATE weekly_flow_download_cancellations
   SET generation = generation + 1, state = 'active', changed_at = ?
   WHERE playlist_id = ?`,
);
const touchActivePlaylistStmt = db.prepare<[number, string]>(
  `UPDATE weekly_flow_download_cancellations
   SET state = 'active', changed_at = ?
   WHERE playlist_id = ?`,
);
const cancelNewPlaylistStmt = db.prepare<[string, number]>(
  `INSERT INTO weekly_flow_download_cancellations (playlist_id, generation, state, changed_at)
   VALUES (?, 0, 'cancelled', ?)`,
);
const cancelExistingPlaylistStmt = db.prepare<[number, string]>(
  `UPDATE weekly_flow_download_cancellations
   SET state = 'cancelled', changed_at = ?
   WHERE playlist_id = ?`,
);
const jobCancellationStmt = db.prepare<[string], { 1: number }>(
  `SELECT 1 FROM weekly_flow_download_job_cancellations WHERE job_id = ?`,
);
const cancelJobStmt = db.prepare<[string, number]>(
  `INSERT OR IGNORE INTO weekly_flow_download_job_cancellations (job_id, cancelled_at)
   VALUES (?, ?)`,
);
const restoreJobStmt = db.prepare<[string]>(
  `DELETE FROM weekly_flow_download_job_cancellations WHERE job_id = ?`,
);

const providerWorkInsertStmt = db.prepare<[string, string, string, string, string, number]>(
  `INSERT OR IGNORE INTO weekly_flow_download_provider_work
   (job_id, playlist_id, provider, work_id, username, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const providerWorkDeleteStmt = db.prepare<[string, string]>(
  `DELETE FROM weekly_flow_download_provider_work
   WHERE provider = ? AND work_id = ?`,
);

function normalizeId(value: unknown) {
  return String(value || "").trim();
}

function readPlaylistCancellation(playlistId: unknown) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return null;
  return playlistCancellationStmt.get(safePlaylistId) || null;
}

export function getPlaylistDownloadGeneration(playlistId: unknown) {
  return Number(readPlaylistCancellation(playlistId)?.generation || 0);
}

export function activatePlaylistDownloadGeneration(playlistId: unknown) {
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

export function cancelPlaylistDownloadGeneration(playlistId: unknown) {
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

export function cancelDownloadJob(jobId: unknown) {
  const safeJobId = normalizeId(jobId);
  if (!safeJobId) return false;
  return cancelDownloadJobs([safeJobId]) > 0;
}

export function cancelDownloadJobs(jobIds: string[] = []) {
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

export function restorePlaylistDownloadWork(playlistId: unknown, jobIds: string[] = []) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return false;
  const safeJobIds = [...new Set(jobIds.map(normalizeId).filter(Boolean))];
  db.transaction(() => {
    const now = Date.now();
    if (!readPlaylistCancellation(safePlaylistId)) {
      insertActivePlaylistStmt.run(safePlaylistId, now);
    } else {
      touchActivePlaylistStmt.run(now, safePlaylistId);
    }
    for (const jobId of safeJobIds) restoreJobStmt.run(jobId);
  })();
  return true;
}

export function restoreDownloadJobCancellations(jobIds: string[] = []) {
  const safeJobIds = [
    ...new Set((Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean)),
  ];
  if (safeJobIds.length === 0) return 0;
  const restore = db.transaction(() => {
    let restored = 0;
    for (const jobId of safeJobIds) restored += restoreJobStmt.run(jobId).changes;
    return restored;
  });
  return restore();
}

export function registerDownloadProviderWork({
  jobId,
  playlistId,
  provider,
  workId,
  username = "",
}: {
  jobId?: string | null;
  playlistId?: string | null;
  provider?: string;
  workId?: string;
  username?: string;
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
}: { jobIds?: string[]; playlistId?: string | null; provider?: string | null } = {}) {
  const safeJobIds = [
    ...new Set((Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean)),
  ];
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
  return db
    .prepare<string[], WeeklyFlowDownloadProviderWorkRow>(
      `SELECT job_id, playlist_id, provider, work_id, username, created_at
     FROM weekly_flow_download_provider_work
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at, work_id`,
    )
    .all(...params);
}

const orphanedProviderWorkStmt = db.prepare<[string], WeeklyFlowDownloadProviderWorkRow>(
  `SELECT job_id, playlist_id, provider, work_id, username, created_at
   FROM weekly_flow_download_provider_work AS work
   WHERE provider = ? AND NOT EXISTS (SELECT 1 FROM playlist_download_jobs AS job WHERE job.id = work.job_id)
   ORDER BY created_at, work_id`,
);

export function listOrphanedDownloadProviderWork(provider: unknown) {
  return orphanedProviderWorkStmt.all(normalizeId(provider));
}

export function clearDownloadProviderWork({
  provider,
  workId,
}: { provider?: string; workId?: string } = {}) {
  const safeProvider = normalizeId(provider);
  const safeWorkId = normalizeId(workId);
  if (!safeProvider || !safeWorkId) return 0;
  return providerWorkDeleteStmt.run(safeProvider, safeWorkId).changes;
}

export function isDownloadJobCancelled(jobId: unknown) {
  const safeJobId = normalizeId(jobId);
  return Boolean(safeJobId && jobCancellationStmt.get(safeJobId));
}

type PipelinePayloadFields = {
  jobId?: unknown;
  playlistId?: unknown;
  playlistGeneration?: unknown;
  downloadAttemptId?: unknown;
};

export function isPipelinePayloadActive(payload: PipelinePayloadFields = {}) {
  const jobId = normalizeId(payload.jobId);
  if (jobId && isDownloadJobCancelled(jobId)) return false;
  if (
    payload.downloadAttemptId !== undefined &&
    getActiveDownloadAttemptId(jobId) !== (payload.downloadAttemptId || null)
  )
    return false;
  if (jobId) {
    const owner = db
      .prepare<
        [string],
        Pick<PlaylistDownloadJobsRow, "playlist_id" | "playlist_type" | "playlist_generation">
      >(
        "SELECT playlist_id, playlist_type, playlist_generation FROM playlist_download_jobs WHERE id = ?",
      )
      .get(jobId);
    if (
      owner &&
      payload.playlistId &&
      ((owner.playlist_id || owner.playlist_type) !== payload.playlistId ||
        Number(owner.playlist_generation || 0) !== Number(payload.playlistGeneration || 0))
    )
      return false;
  }

  const playlistId = normalizeId(payload.playlistId);
  if (!playlistId) return true;
  const current = readPlaylistCancellation(playlistId);
  if (!current) {
    return Number(payload.playlistGeneration || 0) === 0;
  }
  if (current.state === "cancelled") return false;
  return Number(payload.playlistGeneration || 0) === Number(current.generation || 0);
}

export async function withPipelineCommitLock<T>(
  payload: PipelinePayloadFields,
  operation: () => T | Promise<T>,
): Promise<{ cancelled: true; result: null } | { cancelled: false; result: Awaited<T> }> {
  if (!isPipelinePayloadActive(payload)) return { cancelled: true, result: null };
  const playlistId = normalizeId(payload.playlistId);
  if (!playlistId) {
    return { cancelled: false, result: await operation() };
  }
  const { withDownloadImportLock } = await import("./mutationGuards.ts");
  return withDownloadImportLock(playlistId, async () => {
    if (!isPipelinePayloadActive(payload)) {
      return { cancelled: true, result: null };
    }
    return { cancelled: false, result: await operation() };
  });
}
