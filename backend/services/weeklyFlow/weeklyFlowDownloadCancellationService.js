import { getDownloadClient } from "../download/downloadClientSettings.js";
import {
  getHonkerQueueByName,
  listHonkerJobs,
  withHonkerLock,
} from "../honkerDb.js";
import { logger } from "../logger.js";
import {
  cancelDownloadJobs,
  cancelPlaylistDownloadGeneration,
} from "./weeklyFlowDownloadCancellation.js";

const PIPELINE_QUEUE = "slskd-pipeline";

function normalizeId(value) {
  return String(value || "").trim();
}

function payloadBelongsToPlaylist(payload, playlistId, jobIds) {
  const safeJobId = normalizeId(payload?.jobId);
  return (
    normalizeId(payload?.playlistId) === playlistId ||
    (safeJobId && jobIds.has(safeJobId))
  );
}

function readTransferEntries(payload) {
  const entries = [];
  if (payload?.legacyTransfer) entries.push(payload.legacyTransfer);
  const batchTransfers = payload?.batch?.transfers || payload?.batch?.Transfers;
  if (Array.isArray(batchTransfers)) entries.push(...batchTransfers);
  if (payload?.transfer) entries.push(payload.transfer);
  return entries;
}

function readTransferId(transfer) {
  return normalizeId(
    transfer?.id || transfer?.Id || transfer?.transferId || transfer?.TransferId,
  );
}

function readTransferUsername(transfer, payload, job) {
  return normalizeId(
    transfer?.username ||
      transfer?.Username ||
      payload?.candidate?.raw?.user ||
      payload?.candidates?.[Number(payload?.candidateIndex || 0)]?.raw?.user ||
      job?.remoteUsername,
  );
}

function readSearchIds(payload, job) {
  return [
    ...(Array.isArray(payload?.searchIds) ? payload.searchIds : []),
    payload?.searchId,
    job?.slskdSearchId,
  ]
    .map(normalizeId)
    .filter(Boolean);
}

function getJobById(jobs, jobId) {
  const safeJobId = normalizeId(jobId);
  return jobs.find((job) => normalizeId(job?.id) === safeJobId) || null;
}

async function cancelSlskdWork(payloads, jobs) {
  const client = getDownloadClient("slskd");
  const searchIds = new Set();
  const transfers = new Map();
  for (const payload of payloads) {
    const job = getJobById(jobs, payload?.jobId);
    for (const searchId of readSearchIds(payload, job)) searchIds.add(searchId);
    for (const transfer of readTransferEntries(payload)) {
      const id = readTransferId(transfer);
      const username = readTransferUsername(transfer, payload, job);
      if (id && username) transfers.set(`${username}\0${id}`, { id, username });
    }
  }
  for (const job of jobs) {
    if (job?.downloadSource !== "slskd") continue;
    for (const searchId of readSearchIds({}, job)) searchIds.add(searchId);
    const transferId = normalizeId(job.downloadClientId);
    const username = normalizeId(job.remoteUsername);
    if (transferId && username) {
      transfers.set(`${username}\0${transferId}`, { id: transferId, username });
    }
  }
  for (const searchId of searchIds) {
    await client.deleteSearch(searchId).catch((error) => {
      logger.warn("slskd", "Could not cancel a removed playlist search", {
        searchId,
        reason: error?.message || String(error),
      });
    });
  }
  for (const transfer of transfers.values()) {
    await client.deleteTransfer(transfer.username, transfer.id, { remove: true }).catch((error) => {
      logger.warn("slskd", "Could not cancel a removed playlist transfer", {
        transferId: transfer.id,
        reason: error?.message || String(error),
      });
    });
  }
  return { searches: searchIds.size, transfers: transfers.size };
}

async function cancelDeemixWork(payloads, jobs) {
  const client = getDownloadClient("deemix");
  const queueIds = new Set();
  for (const payload of payloads) {
    if (payload?.source === "deemix" && payload?.queueUuid) {
      queueIds.add(normalizeId(payload.queueUuid));
    }
  }
  for (const job of jobs) {
    if (job?.downloadSource === "deemix" || job?.downloadClient === "deemix") {
      queueIds.add(normalizeId(job.downloadClientId));
    }
  }
  for (const queueId of queueIds) {
    if (!queueId) continue;
    await client.removeFromQueue(queueId).catch((error) => {
      logger.warn("deemix", "Could not cancel a removed playlist queue item", {
        queueId,
        reason: error?.message || String(error),
      });
    });
  }
  return { queueItems: queueIds.size };
}

async function cancelSabnzbdWork(payloads, jobs) {
  const client = getDownloadClient("sabnzbd");
  const ids = new Set(
    jobs
      .filter((job) => job?.downloadClient === "sabnzbd")
      .map((job) => normalizeId(job.downloadClientId))
      .filter(Boolean),
  );
  for (const payload of payloads) {
    if (payload?.source === "usenet" && payload?.downloadClient === "sabnzbd") {
      const id = normalizeId(payload.nzbId);
      if (id) ids.add(id);
    }
  }
  for (const id of ids) {
    await client.deleteHistoryItem(id).catch((error) => {
      logger.warn("sabnzbd", "Could not remove a deleted playlist history item", {
        id,
        reason: error?.message || String(error),
      });
    });
  }
  return { historyItems: ids.size };
}

async function cancelYtdlpWork(payloads, jobs) {
  const client = getDownloadClient("ytdlp");
  const ids = new Set(
    jobs
      .filter((job) => job?.downloadClient === "ytdlp" || job?.downloadSource === "ytdlp")
      .map((job) => normalizeId(job.id))
      .filter(Boolean),
  );
  for (const payload of payloads) {
    if (payload?.source === "ytdlp") {
      const jobId = normalizeId(payload.jobId);
      if (jobId) ids.add(jobId);
    }
  }
  for (const id of ids) {
    await client.cleanupStaging(id).catch((error) => {
      logger.warn("ytdlp", "Could not clean removed playlist staging", {
        jobId: id,
        reason: error?.message || String(error),
      });
    });
  }
  return { stagingJobs: ids.size };
}

async function cancelProviderWork(payloads, jobs) {
  const [slskd, deemix, sabnzbd, ytdlp] = await Promise.all([
    cancelSlskdWork(payloads, jobs),
    cancelDeemixWork(payloads, jobs),
    cancelSabnzbdWork(payloads, jobs),
    cancelYtdlpWork(payloads, jobs),
  ]);
  return { slskd, deemix, sabnzbd, ytdlp };
}

function cancelPipelineRows(playlistId, jobs) {
  const jobIds = new Set(jobs.map((job) => normalizeId(job?.id)).filter(Boolean));
  const rows = listHonkerJobs(PIPELINE_QUEUE).filter(({ payload }) =>
    payloadBelongsToPlaylist(payload, playlistId, jobIds),
  );
  const queue = getHonkerQueueByName(PIPELINE_QUEUE);
  const payloads = [];
  let cancelled = 0;
  for (const row of rows) {
    payloads.push(row.payload || {});
    try {
      if (queue?.cancel(row.id)) cancelled += 1;
    } catch (error) {
      logger.warn("playlists", "Could not cancel a removed playlist pipeline job", {
        queueJobId: row.id,
        reason: error?.message || String(error),
      });
    }
  }
  return { rows, payloads, cancelled };
}

function cancelPipelineRowsForJobs(jobs) {
  const jobIds = new Set(jobs.map((job) => normalizeId(job?.id)).filter(Boolean));
  const rows = listHonkerJobs(PIPELINE_QUEUE).filter(({ payload }) =>
    jobIds.has(normalizeId(payload?.jobId)),
  );
  const queue = getHonkerQueueByName(PIPELINE_QUEUE);
  const payloads = [];
  let cancelled = 0;
  for (const row of rows) {
    payloads.push(row.payload || {});
    try {
      if (queue?.cancel(row.id)) cancelled += 1;
    } catch (error) {
      logger.warn("playlists", "Could not cancel a removed track pipeline job", {
        queueJobId: row.id,
        reason: error?.message || String(error),
      });
    }
  }
  return { rows, payloads, cancelled };
}

async function withPlaylistCancellationLocks(playlistIds, operation) {
  const sortedIds = [...new Set(playlistIds)].sort();
  const runAtIndex = async (index) => {
    if (index >= sortedIds.length) return operation();
    return withHonkerLock(
      `playlist-mutation:${sortedIds[index]}`,
      () => runAtIndex(index + 1),
      {
        ttlSeconds: 180,
        waitTimeoutMs: 15 * 60 * 1000,
        retryDelayMs: 250,
      },
    );
  };
  return runAtIndex(0);
}

export function markDownloadWorkCancelledForJobs(jobs = []) {
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.id) : [];
  cancelDownloadJobs(normalizedJobs.map((job) => job.id));
  return normalizedJobs;
}

export function markPlaylistDownloadWorkCancelled(playlistId, jobs = []) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) {
    return { generation: 0, jobs: [] };
  }
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.id) : [];
  const generation = cancelPlaylistDownloadGeneration(safePlaylistId);
  cancelDownloadJobs(normalizedJobs.map((job) => job.id));
  return { generation, jobs: normalizedJobs };
}

export async function cancelDownloadWorkForJobs(jobs = [], { lock = true } = {}) {
  const normalizedInput = Array.isArray(jobs)
    ? jobs.filter((job) => job?.id).map((job) => ({ ...job }))
    : [];
  const normalizedJobs = markDownloadWorkCancelledForJobs(normalizedInput);
  const pipeline = cancelPipelineRowsForJobs(normalizedJobs);
  const playlistIds = normalizedJobs
    .map((job) => normalizeId(job?.playlistId || job?.playlistType))
    .filter(Boolean);
  const providers = lock
    ? await withPlaylistCancellationLocks(playlistIds, () =>
        cancelProviderWork(pipeline.payloads, normalizedJobs),
      )
    : await cancelProviderWork(pipeline.payloads, normalizedJobs);
  return {
    cancelled: pipeline.cancelled,
    provider: providers,
  };
}

export async function cancelPlaylistDownloadWork(playlistId, jobs = []) {
  const cancellation = markPlaylistDownloadWorkCancelled(playlistId, jobs);
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return { cancelled: 0, generation: 0 };
  const { generation, jobs: normalizedJobs } = cancellation;
  const activePipeline = cancelPipelineRows(safePlaylistId, normalizedJobs);
  const providers = await withPlaylistCancellationLocks([safePlaylistId], () =>
    cancelProviderWork(activePipeline.payloads, normalizedJobs),
  );
  return {
    generation,
    cancelled: activePipeline.cancelled,
    provider: providers,
  };
}
