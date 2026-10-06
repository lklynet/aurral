import { db } from "../../config/db-sqlite.js";
import { randomUUID } from "node:crypto";

const attemptStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const saveAttemptStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

export function getActiveDownloadAttemptId(jobId) {
  const row = attemptStmt.get(`activeDownloadAttempt:${jobId}`);
  return row ? JSON.parse(row.value) : null;
}

export function beginDownloadAttempt(jobId) {
  const id = randomUUID();
  setActiveDownloadAttemptId(jobId, id);
  return id;
}

export function setActiveDownloadAttemptId(jobId, id) {
  saveAttemptStmt.run(`activeDownloadAttempt:${jobId}`, JSON.stringify(id));
}

const ownerCancellationStmt = db.prepare(
  `SELECT generation, state FROM download_owner_cancellations WHERE owner_id = ?`,
);
const insertActiveOwnerStmt = db.prepare(
  `INSERT INTO download_owner_cancellations (owner_id, generation, state, changed_at)
   VALUES (?, 0, 'active', ?)`,
);
const activateExistingOwnerStmt = db.prepare(
  `UPDATE download_owner_cancellations
   SET generation = generation + 1, state = 'active', changed_at = ?
   WHERE owner_id = ?`,
);
const touchActiveOwnerStmt = db.prepare(
  `UPDATE download_owner_cancellations
   SET state = 'active', changed_at = ?
   WHERE owner_id = ?`,
);
const cancelNewOwnerStmt = db.prepare(
  `INSERT INTO download_owner_cancellations (owner_id, generation, state, changed_at)
   VALUES (?, 0, 'cancelled', ?)`,
);
const cancelExistingOwnerStmt = db.prepare(
  `UPDATE download_owner_cancellations
   SET state = 'cancelled', changed_at = ?
   WHERE owner_id = ?`,
);
const jobCancellationStmt = db.prepare(
  `SELECT 1 FROM download_job_cancellations WHERE job_id = ?`,
);
const cancelJobStmt = db.prepare(
  `INSERT OR IGNORE INTO download_job_cancellations (job_id, cancelled_at)
   VALUES (?, ?)`,
);
const restoreJobStmt = db.prepare(
  `DELETE FROM download_job_cancellations WHERE job_id = ?`,
);

const providerWorkInsertStmt = db.prepare(
  `INSERT OR IGNORE INTO download_provider_work
   (job_id, owner_id, provider, work_id, username, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const providerWorkDeleteStmt = db.prepare(
  `DELETE FROM download_provider_work
   WHERE provider = ? AND work_id = ?`,
);

const jobOwnerStmt = db.prepare("SELECT owner_id, owner_generation FROM download_jobs WHERE id = ?");

function normalizeId(value) {
  return String(value || "").trim();
}

function readOwnerCancellation(ownerId) {
  const safeOwnerId = normalizeId(ownerId);
  if (!safeOwnerId) return null;
  return ownerCancellationStmt.get(safeOwnerId) || null;
}

export function getOwnerDownloadGeneration(ownerId) {
  return Number(readOwnerCancellation(ownerId)?.generation || 0);
}

export function activateOwnerDownloadGeneration(ownerId) {
  const safeOwnerId = normalizeId(ownerId);
  if (!safeOwnerId) return 0;
  const now = Date.now();
  const activate = db.transaction(() => {
    const current = readOwnerCancellation(safeOwnerId);
    if (!current) {
      insertActiveOwnerStmt.run(safeOwnerId, now);
      return 0;
    }
    if (current.state === "cancelled") {
      activateExistingOwnerStmt.run(now, safeOwnerId);
    } else {
      touchActiveOwnerStmt.run(now, safeOwnerId);
    }
    return getOwnerDownloadGeneration(safeOwnerId);
  });
  return activate();
}

export function cancelOwnerDownloadGeneration(ownerId) {
  const safeOwnerId = normalizeId(ownerId);
  if (!safeOwnerId) return 0;
  const now = Date.now();
  const cancel = db.transaction(() => {
    const current = readOwnerCancellation(safeOwnerId);
    if (!current) {
      cancelNewOwnerStmt.run(safeOwnerId, now);
      return 0;
    }
    if (current.state !== "cancelled") {
      cancelExistingOwnerStmt.run(now, safeOwnerId);
    }
    return getOwnerDownloadGeneration(safeOwnerId);
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

export function restoreOwnerDownloadWork(ownerId, jobIds = []) {
  const safeOwnerId = normalizeId(ownerId);
  if (!safeOwnerId) return false;
  const safeJobIds = [...new Set(jobIds.map(normalizeId).filter(Boolean))];
  db.transaction(() => {
    const now = Date.now();
    if (!readOwnerCancellation(safeOwnerId)) {
      insertActiveOwnerStmt.run(safeOwnerId, now);
    } else {
      touchActiveOwnerStmt.run(now, safeOwnerId);
    }
    for (const jobId of safeJobIds) restoreJobStmt.run(jobId);
  })();
  return true;
}

export function restoreDownloadJobCancellations(jobIds = []) {
  const safeJobIds = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean))];
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
  ownerId,
  provider,
  workId,
  username = "",
} = {}) {
  const safeJobId = normalizeId(jobId);
  const safeOwnerId = normalizeId(ownerId);
  const safeProvider = normalizeId(provider);
  const safeWorkId = normalizeId(workId);
  const safeUsername = normalizeId(username);
  if (!safeJobId || !safeProvider || !safeWorkId) return false;
  providerWorkInsertStmt.run(
    safeJobId,
    safeOwnerId,
    safeProvider,
    safeWorkId,
    safeUsername,
    Date.now(),
  );
  return true;
}

export function listDownloadProviderWork({
  jobIds = [],
  ownerId = null,
  provider = null,
} = {}) {
  const safeJobIds = [...new Set(
    (Array.isArray(jobIds) ? jobIds : []).map(normalizeId).filter(Boolean),
  )];
  const safeOwnerId = normalizeId(ownerId);
  const safeProvider = normalizeId(provider);
  const clauses = [];
  const params = [];
  if (safeProvider) {
    clauses.push("provider = ?");
    params.push(safeProvider);
  }
  const scope = [];
  if (safeOwnerId) {
    scope.push("owner_id = ?");
    params.push(safeOwnerId);
  }
  if (safeJobIds.length > 0) {
    scope.push(`job_id IN (${safeJobIds.map(() => "?").join(", ")})`);
    params.push(...safeJobIds);
  }
  if (scope.length === 0) return [];
  clauses.push(`(${scope.join(" OR ")})`);
  return db.prepare(
    `SELECT job_id, owner_id, provider, work_id, username, created_at
     FROM download_provider_work
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
  if (payload.downloadAttemptId !== undefined && getActiveDownloadAttemptId(jobId) !== (payload.downloadAttemptId || null)) return false;
  if (jobId) {
    const owner = jobOwnerStmt.get(jobId);
    if (owner && payload.ownerId && (owner.owner_id !== payload.ownerId ||
        Number(owner.owner_generation || 0) !== Number(payload.ownerGeneration || 0))) return false;
  }

  const ownerId = normalizeId(payload.ownerId);
  if (!ownerId) return true;
  const current = readOwnerCancellation(ownerId);
  if (!current) {
    return Number(payload.ownerGeneration || 0) === 0;
  }
  if (current.state === "cancelled") return false;
  return Number(payload.ownerGeneration || 0) === Number(current.generation || 0);
}

export async function withPipelineCommitLock(payload, operation) {
  if (!isPipelinePayloadActive(payload)) return { cancelled: true, result: null };
  const ownerId = normalizeId(payload.ownerId);
  if (!ownerId) {
    return { cancelled: false, result: await operation() };
  }
  const { withDownloadImportLock } = await import("./mutationGuards.js");
  return withDownloadImportLock(
    ownerId,
    async () => {
      if (!isPipelinePayloadActive(payload)) {
        return { cancelled: true, result: null };
      }
      return { cancelled: false, result: await operation() };
    },
  );
}
