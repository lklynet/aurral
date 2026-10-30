import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { downloadTracker, type DownloadJob, type JobFields } from "./downloadTracker.ts";
import { parseHonkerPayload } from "../honkerDb.ts";
import type { HonkerLiveRow, PlaylistDownloadJobsRow, SettingsRow } from "../../db/rows.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import {
  beginDownloadAttempt,
  getActiveDownloadAttemptId,
  getPlaylistDownloadGeneration,
  isDownloadJobCancelled,
} from "./downloadCancellation.ts";
import { buildAurralTrackDestination } from "../downloadPaths.ts";
import { sanitizePathPart } from "../downloadUtils.ts";

const settingStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const saveSettingStmt = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);
const ownerStmt = db.prepare<
  [string],
  Pick<PlaylistDownloadJobsRow, "playlist_id" | "playlist_type" | "playlist_generation">
>(
  "SELECT playlist_id, playlist_type, playlist_generation FROM playlist_download_jobs WHERE id = ?",
);
const pruneSettledTransfersStmt = db.prepare(`
  DELETE FROM settings WHERE key LIKE 'downloadJobTransfers:%' AND NOT EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '[]' END) AS transfer
    JOIN playlist_download_jobs AS job
      ON job.id = CASE transfer.type WHEN 'object' THEN json_extract(transfer.value, '$.toJobId') END
    WHERE job.status IN ('pending', 'downloading', 'blocked'))
`);

export type OwnedPayload = {
  jobId?: unknown;
  playlistId?: unknown;
  playlistGeneration?: unknown;
  downloadAttemptId?: unknown;
  albumGroupJobIds?: unknown;
};

const transfersSchema = v.array(
  v.looseObject({
    fromJobId: v.string(),
    fromPlaylistId: v.string(),
    fromGeneration: v.number(),
    fromAttemptId: v.nullable(v.string()),
    toJobId: v.string(),
    toPlaylistId: v.string(),
    toGeneration: v.number(),
    toAttemptId: v.nullable(v.string()),
    destination: v.string(),
    track: v.looseObject({}),
  }),
);

type DownloadTransfer = v.InferOutput<typeof transfersSchema>[number];

function readTransfers(jobId: string) {
  const key = `downloadJobTransfers:${jobId}`;
  return dbHelpers.readJSON(transfersSchema, settingStmt.get(key)?.value, key) ?? [];
}

function currentJob(jobId: string) {
  const job = downloadTracker.getJob(jobId);
  const row = ownerStmt.get(jobId);
  return job && row
    ? {
        ...job,
        playlistId: row.playlist_id,
        playlistType: row.playlist_type,
        playlistGeneration: row.playlist_generation,
      }
    : null;
}

export function downloadDestinationForJob(
  job: Pick<DownloadJob, "artistName" | "albumName"> & JobFields<"playlistId" | "playlistType">,
) {
  return buildAurralTrackDestination(
    job.playlistId || job.playlistType,
    sanitizePathPart(job.artistName, "Unknown Artist"),
    sanitizePathPart(job.albumName, "Unknown Album"),
    { ephemeral: Boolean(flowPlaylistConfig.getFlow(job.playlistId || job.playlistType)) },
  );
}

function payloadJobId(payload: OwnedPayload) {
  const { jobId } = payload;
  if (typeof jobId !== "string") throw new TypeError("Download payload has no job id");
  return jobId;
}

export function resolveTransferredDownloadPayload<Payload extends OwnedPayload>(original: Payload) {
  let payload = original;
  for (let index = 0; index < 64; index++) {
    const jobId = payloadJobId(payload);
    const job = currentJob(jobId);
    const attempt = job ? getActiveDownloadAttemptId(job.id) : null;
    if (
      job &&
      !isDownloadJobCancelled(job.id) &&
      payload.playlistId === job.playlistId &&
      Number(payload.playlistGeneration || 0) === job.playlistGeneration &&
      (payload.downloadAttemptId || null) === attempt
    )
      return payload;
    const transfer = readTransfers(jobId).findLast(
      (entry) =>
        entry.fromPlaylistId === payload.playlistId &&
        entry.fromGeneration === Number(payload.playlistGeneration || 0) &&
        entry.fromAttemptId === (payload.downloadAttemptId || null),
    );
    if (!transfer) {
      if (job || attempt) return { ...payload, downloadAttemptId: "unmatched-download-attempt" };
      return payload;
    }
    payload = applyTransfer(payload, transfer);
  }
  return { ...payload, downloadAttemptId: "invalid-transfer-chain" };
}

function applyTransfer<Payload extends OwnedPayload>(payload: Payload, transfer: DownloadTransfer) {
  return {
    ...payload,
    jobId: transfer.toJobId,
    playlistId: transfer.toPlaylistId,
    playlistGeneration: transfer.toGeneration,
    downloadAttemptId: transfer.toAttemptId,
    destination: transfer.destination,
    track: transfer.track,
    ...(Array.isArray(payload.albumGroupJobIds) && transfer.fromJobId !== transfer.toJobId
      ? {
          albumGroupJobIds: payload.albumGroupJobIds.filter((id) => id !== transfer.fromJobId),
        }
      : {}),
  };
}

type OwnedJob = NonNullable<ReturnType<typeof currentJob>>;

function recordTransfer(
  from: OwnedJob,
  to: OwnedJob,
  fromAttemptId: string | null,
  toAttemptId: string | null,
) {
  pruneSettledTransfersStmt.run();
  const transfers = readTransfers(from.id);
  const transfer = {
    fromJobId: from.id,
    fromPlaylistId: from.playlistId,
    fromGeneration: from.playlistGeneration,
    fromAttemptId,
    toJobId: to.id,
    toPlaylistId: to.playlistId,
    toGeneration: to.playlistGeneration,
    toAttemptId,
    destination: downloadDestinationForJob(to),
    track: {
      artistName: to.artistName,
      trackName: to.trackName,
      albumName: to.albumName,
      artistMbid: to.artistMbid,
      albumMbid: to.albumMbid,
      trackMbid: to.trackMbid,
      releaseYear: to.releaseYear,
      durationMs: to.durationMs,
      trackNumber: to.trackNumber,
      discNumber: to.discNumber,
      albumTrackCount: to.albumTrackCount,
      albumTrackTitles: to.albumTrackTitles || [],
      artistAliases: to.artistAliases || [],
    },
  };
  transfers.push(transfer);
  saveSettingStmt.run(`downloadJobTransfers:${from.id}`, JSON.stringify(transfers));
  for (const row of db
    .prepare<[], Pick<HonkerLiveRow, "id" | "payload">>(
      "SELECT id, payload FROM _honker_live WHERE queue = 'slskd-pipeline'",
    )
    .all()) {
    const payload = parseHonkerPayload(row.payload);
    if (payload?.jobId !== from.id) continue;
    if (
      payload.playlistId !== from.playlistId ||
      Number(payload.playlistGeneration || 0) !== from.playlistGeneration ||
      (payload.downloadAttemptId || null) !== fromAttemptId
    )
      continue;
    const updated = applyTransfer(payload, transfer);
    db.prepare("UPDATE _honker_live SET payload = ? WHERE id = ?").run(
      JSON.stringify(updated),
      row.id,
    );
  }
  db.prepare(
    "UPDATE weekly_flow_download_provider_work SET job_id = ?, playlist_id = ? WHERE job_id = ?",
  ).run(to.id, to.playlistId, from.id);
}

export function transferDownloadOwnershipInTransaction(jobId: string, targetPlaylistId: string) {
  if (!db.inTransaction)
    throw new Error("Download ownership must change inside the membership transaction");
  const from = currentJob(jobId);
  if (!from) throw new Error("Download job is no longer available");
  const fromAttemptId = getActiveDownloadAttemptId(jobId);
  const toAttemptId =
    fromAttemptId || (from.status === "done" ? null : beginDownloadAttempt(jobId));
  const generation = getPlaylistDownloadGeneration(targetPlaylistId);
  db.prepare(
    "UPDATE playlist_download_jobs SET playlist_id = ?, playlist_type = ?, playlist_generation = ? WHERE id = ?",
  ).run(targetPlaylistId, targetPlaylistId, generation, jobId);
  const to = {
    ...from,
    playlistId: targetPlaylistId,
    playlistType: targetPlaylistId,
    playlistGeneration: generation,
  };
  recordTransfer(from, to, fromAttemptId, toAttemptId);
  return { fromJobId: jobId, toJobId: jobId, dispatched: downloadTracker.isSlskdDispatched(jobId) };
}

export function replaceAlbumDownloadLeaderInTransaction(
  jobId: string,
  peerId: string,
  { retainCancelled = false }: { retainCancelled?: boolean } = {},
) {
  if (!db.inTransaction)
    throw new Error("Album leadership must change inside the membership transaction");
  const from = currentJob(jobId);
  const peer = currentJob(peerId);
  if (
    !from ||
    !peer ||
    !from.requestGroupId ||
    from.requestGroupId !== peer.requestGroupId ||
    from.albumMbid !== peer.albumMbid ||
    peer.status !== "downloading" ||
    downloadTracker.isSlskdDispatched(peerId)
  )
    throw new Error("No held album peer can take over this download");
  const previousAttempt = getActiveDownloadAttemptId(jobId);
  const attempt = previousAttempt || beginDownloadAttempt(jobId);
  saveSettingStmt.run(`activeDownloadAttempt:${peerId}`, JSON.stringify(attempt));
  const columns: (keyof PlaylistDownloadJobsRow)[] = [
    "download_source",
    "download_client",
    "download_client_id",
    "release_guid",
    "release_title",
    "indexer_id",
    "indexer_name",
    "slskd_search_id",
    "slskd_batch_id",
    "remote_username",
    "remote_filename",
  ];
  const row = db
    .prepare<[string], PlaylistDownloadJobsRow>("SELECT * FROM playlist_download_jobs WHERE id = ?")
    .get(jobId)!;
  db.prepare(
    `UPDATE playlist_download_jobs SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
  ).run(...columns.map((column) => row[column]), peerId);
  recordTransfer(from, peer, previousAttempt, attempt);
  db.prepare(
    "INSERT OR IGNORE INTO weekly_flow_download_job_cancellations (job_id, cancelled_at) VALUES (?, ?)",
  ).run(jobId, Date.now());
  if (!retainCancelled) db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(jobId);
  return {
    fromJobId: jobId,
    toJobId: peerId,
    dispatched: downloadTracker.isSlskdDispatched(jobId),
  };
}
