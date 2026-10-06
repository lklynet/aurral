import { db } from "../../config/db-sqlite.js";
import { downloadTracker } from "./downloadTracker.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import { beginDownloadAttempt, getActiveDownloadAttemptId } from "./downloadCancellation.js";
import { buildAurralTrackDestination } from "../downloadPaths.js";
import { sanitizePathPart } from "../downloadUtils.js";

const settingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const saveSettingStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const ownerStmt = db.prepare("SELECT owner_id, owner_generation FROM download_jobs WHERE id = ?");
const pruneSettledTransfersStmt = db.prepare(`
  DELETE FROM settings WHERE key LIKE 'downloadJobTransfers:%' AND NOT EXISTS (
    SELECT 1 FROM json_each(settings.value) AS transfer
    JOIN download_jobs AS job ON job.id = json_extract(transfer.value, '$.toJobId')
    WHERE job.status IN ('pending', 'downloading', 'blocked'))
`);

function readTransfers(jobId) {
  const row = settingStmt.get(`downloadJobTransfers:${jobId}`);
  return row ? JSON.parse(row.value) : [];
}

function currentJob(jobId) {
  const job = downloadTracker.getJob(jobId);
  const row = ownerStmt.get(jobId);
  return job && row ? { ...job, ownerId: row.owner_id, ownerGeneration: row.owner_generation } : null;
}

export function downloadDestinationForJob(job) {
  return buildAurralTrackDestination(job.ownerId,
    sanitizePathPart(job.artistName, "Unknown Artist"), sanitizePathPart(job.albumName, "Unknown Album"),
    { ephemeral: Boolean(flowPlaylistConfig.getFlow(job.ownerId)) });
}

export function resolveTransferredDownloadPayload(original) {
  let payload = original;
  for (let index = 0; index < 64; index++) {
    const job = currentJob(payload.jobId);
    const attempt = job ? getActiveDownloadAttemptId(job.id) : null;
    if (job && payload.ownerId === job.ownerId && Number(payload.ownerGeneration || 0) === job.ownerGeneration &&
        ((payload.downloadAttemptId || null) === attempt)) return payload;
    const transfer = readTransfers(payload.jobId).findLast((entry) =>
      entry.fromOwnerId === payload.ownerId && entry.fromGeneration === Number(payload.ownerGeneration || 0) &&
      entry.fromAttemptId === (payload.downloadAttemptId || null));
    if (!transfer) {
      if (job || attempt) return { ...payload, downloadAttemptId: "unmatched-download-attempt" };
      return payload;
    }
    payload = applyTransfer(payload, transfer);
  }
  return { ...payload, downloadAttemptId: "invalid-transfer-chain" };
}

function applyTransfer(payload, transfer) {
  return { ...payload, jobId: transfer.toJobId, ownerId: transfer.toOwnerId,
    ownerGeneration: transfer.toGeneration, downloadAttemptId: transfer.toAttemptId,
    destination: transfer.destination, track: transfer.track,
    ...(payload.albumGroupJobIds && transfer.fromJobId !== transfer.toJobId
      ? { albumGroupJobIds: payload.albumGroupJobIds.filter((id) => id !== transfer.fromJobId) } : {}),
  };
}

function recordTransfer(from, to, fromAttemptId, toAttemptId) {
  pruneSettledTransfersStmt.run();
  const transfers = readTransfers(from.id);
  const transfer = {
    fromJobId: from.id, fromOwnerId: from.ownerId, fromGeneration: from.ownerGeneration,
    fromAttemptId, toJobId: to.id, toOwnerId: to.ownerId, toGeneration: to.ownerGeneration,
    toAttemptId, destination: downloadDestinationForJob(to),
    track: {
      artistName: to.artistName, trackName: to.trackName, albumName: to.albumName,
      artistMbid: to.artistMbid, albumMbid: to.albumMbid, trackMbid: to.trackMbid,
      releaseYear: to.releaseYear, durationMs: to.durationMs, trackNumber: to.trackNumber,
      albumTrackCount: to.albumTrackCount, albumTrackTitles: to.albumTrackTitles || [],
      artistAliases: to.artistAliases || [],
    },
  };
  transfers.push(transfer);
  saveSettingStmt.run(`downloadJobTransfers:${from.id}`, JSON.stringify(transfers));
  for (const row of db.prepare("SELECT id, payload FROM _honker_live WHERE queue = 'slskd-pipeline'").all()) {
    const payload = JSON.parse(row.payload);
    if (payload.jobId !== from.id) continue;
    if (payload.ownerId !== from.ownerId || Number(payload.ownerGeneration || 0) !== from.ownerGeneration ||
        (payload.downloadAttemptId || null) !== fromAttemptId) continue;
    const updated = applyTransfer(payload, transfer);
    db.prepare("UPDATE _honker_live SET payload = ? WHERE id = ?").run(JSON.stringify(updated), row.id);
  }
  db.prepare("UPDATE download_provider_work SET job_id = ?, owner_id = ? WHERE job_id = ?").run(to.id, to.ownerId, from.id);
}

export function replaceAlbumDownloadLeaderInTransaction(jobId, peerId) {
  if (!db.inTransaction) throw new Error("Album leadership must change inside the membership transaction");
  const from = currentJob(jobId);
  const peer = currentJob(peerId);
  if (!from || !peer || !from.requestGroupId || from.requestGroupId !== peer.requestGroupId || from.albumMbid !== peer.albumMbid ||
      peer.status !== "downloading" || downloadTracker.isSlskdDispatched(peerId)) throw new Error("No held album peer can take over this download");
  const previousAttempt = getActiveDownloadAttemptId(jobId);
  const attempt = previousAttempt || beginDownloadAttempt(jobId);
  saveSettingStmt.run(`activeDownloadAttempt:${peerId}`, JSON.stringify(attempt));
  const columns = ["download_source", "download_client", "download_client_id", "release_guid", "release_title", "indexer_id", "indexer_name", "slskd_search_id", "slskd_batch_id", "remote_username", "remote_filename"];
  const row = db.prepare("SELECT * FROM download_jobs WHERE id = ?").get(jobId);
  db.prepare(`UPDATE download_jobs SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...columns.map((column) => row[column]), peerId);
  recordTransfer(from, peer, previousAttempt, attempt);
  db.prepare("INSERT OR IGNORE INTO download_job_cancellations (job_id, cancelled_at) VALUES (?, ?)").run(jobId, Date.now());
  db.prepare("DELETE FROM download_jobs WHERE id = ?").run(jobId);
  return { fromJobId: jobId, toJobId: peerId, dispatched: downloadTracker.isSlskdDispatched(jobId) };
}
