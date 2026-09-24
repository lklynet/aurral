import { getDownloadClient } from "../download/downloadClientSettings.js";
import {
  getHonkerQueueByName,
  listHonkerJobs,
  withHonkerLock,
} from "../honkerDb.js";
import { logger } from "../logger.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import {
  cancelDownloadJobs,
  cancelPlaylistDownloadGeneration,
  clearDownloadProviderWork,
  getPlaylistDownloadGeneration,
  isDownloadJobCancelled,
  isPipelinePayloadActive,
  listDownloadProviderWork,
  restoreDownloadJobCancellations,
  restorePlaylistDownloadWork,
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

async function attemptProviderCleanup(failures, provider, message, details, cleanup) {
  try {
    return await cleanup();
  } catch (error) {
    logger.warn(provider, message, {
      ...details,
      reason: error?.message || String(error),
    });
    failures.push(error);
    return null;
  }
}

function throwProviderCleanupFailures(provider, failures) {
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not cancel ${provider} work`);
  }
}

async function cancelSlskdWork(payloads, jobs, providerWork = []) {
  const client = getDownloadClient("slskd");
  const searchIds = new Set();
  const transfers = new Map();
  const failures = [];
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
  for (const work of providerWork) {
    if (work?.provider !== "slskd-search") continue;
    const searchId = normalizeId(work.work_id);
    if (searchId) searchIds.add(searchId);
  }
  if ((searchIds.size > 0 || transfers.size > 0) && !client?.isConfigured?.()) {
    logger.warn("slskd", "Cannot cancel tracked slskd work while slskd is not configured", {
      searches: searchIds.size,
      transfers: transfers.size,
    });
    throw new Error("slskd is not configured; tracked work cannot be cancelled");
  }
  for (const searchId of searchIds) {
    const deleted = await attemptProviderCleanup(
      failures,
      "slskd",
      "Could not cancel a removed playlist search",
      { searchId },
      async () => {
        const result = await client.deleteSearch(searchId);
        if (!result) throw new Error("slskd did not confirm search cancellation");
        return result;
      },
    );
    if (deleted) clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
  }
  for (const transfer of transfers.values()) {
    await attemptProviderCleanup(
      failures,
      "slskd",
      "Could not cancel a removed playlist transfer",
      { transferId: transfer.id },
      async () => {
        const result = await client.deleteTransfer(transfer.username, transfer.id, {
          remove: true,
        });
        if (!result) throw new Error("slskd did not confirm transfer cancellation");
      },
    );
  }
  throwProviderCleanupFailures("slskd", failures);
  return { searches: searchIds.size, transfers: transfers.size };
}

async function cancelDeemixWork(payloads, jobs) {
  const client = getDownloadClient("deemix");
  const queueIds = new Set();
  const failures = [];
  for (const payload of payloads) {
    if (payload?.source === "deemix" && payload?.queueUuid) {
      queueIds.add(normalizeId(payload.queueUuid));
    }
  }
  for (const job of jobs) {
    if (job?.downloadSource === "deemix" || job?.downloadClient === "deemix") {
      const queueId = normalizeId(job.downloadClientId);
      if (queueId) queueIds.add(queueId);
    }
  }
  if (queueIds.size > 0 && !client?.isConfigured?.()) {
    logger.warn("deemix", "Cannot cancel tracked deemix work while deemix is not configured", {
      queueItems: queueIds.size,
    });
    throw new Error("deemix is not configured; tracked work cannot be cancelled");
  }
  for (const queueId of queueIds) {
    if (!queueId) continue;
    await attemptProviderCleanup(
      failures,
      "deemix",
      "Could not cancel a removed playlist queue item",
      { queueId },
      async () => {
        const removed = await client.removeFromQueue(queueId);
        if (!removed) throw new Error("deemix did not confirm queue removal");
      },
    );
  }
  throwProviderCleanupFailures("deemix", failures);
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
  const failures = [];
  for (const payload of payloads) {
    if (payload?.source === "usenet" && payload?.downloadClient === "sabnzbd") {
      const id = normalizeId(payload.nzbId);
      if (id) ids.add(id);
    }
  }
  if (ids.size > 0 && !client?.isConfigured?.()) {
    logger.warn("sabnzbd", "Cannot cancel tracked SABnzbd work while SABnzbd is not configured", {
      items: ids.size,
    });
    throw new Error("SABnzbd is not configured; tracked work cannot be cancelled");
  }
  for (const id of ids) {
    for (const [message, cleanup, lookup] of [
      ["Could not cancel a removed playlist queue item", () => client.deleteQueueItem(id), () => client.getQueueItem(id)],
      ["Could not remove a deleted playlist history item", () => client.deleteHistoryItem(id), () => client.getHistoryItem(id)],
    ]) {
      await attemptProviderCleanup(
        failures,
        "sabnzbd",
        message,
        { id },
        async () => {
          const removed = await cleanup();
          if (!removed && await lookup()) {
            throw new Error("SABnzbd did not confirm item removal");
          }
        },
      );
    }
  }
  throwProviderCleanupFailures("sabnzbd", failures);
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
  const failures = [];
  for (const payload of payloads) {
    if (payload?.source === "ytdlp") {
      const jobId = normalizeId(payload.jobId);
      if (jobId) ids.add(jobId);
    }
  }
  for (const jobId of ids) {
    await attemptProviderCleanup(
      failures,
      "ytdlp",
      "Could not clean removed playlist staging",
      { jobId },
      () => client.cleanupStaging(jobId),
    );
  }
  throwProviderCleanupFailures("ytdlp", failures);
  return { stagingJobs: ids.size };
}

async function cancelProviderWork(payloads, jobs, providerWork = []) {
  const results = await Promise.allSettled([
    cancelSlskdWork(payloads, jobs, providerWork),
    cancelDeemixWork(payloads, jobs),
    cancelSabnzbdWork(payloads, jobs),
    cancelYtdlpWork(payloads, jobs),
  ]);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not cancel download provider work");
  }
  const [slskd, deemix, sabnzbd, ytdlp] = results.map((result) => result.value);
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

function refreshJobs(jobs) {
  return jobs.map((job) => {
    const current = downloadTracker.getJob(job.id);
    return current ? { ...job, ...current } : job;
  });
}

export function markDownloadWorkCancelledForJobs(jobs = []) {
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.id) : [];
  cancelDownloadJobs(normalizedJobs.map((job) => job.id));
  return normalizedJobs;
}

export function markPlaylistDownloadWorkCancelled(playlistId, jobs = []) {
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) {
    return { generation: 0, jobs: [], wasActive: false, jobsToRestore: [] };
  }
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.id) : [];
  const generationBeforeCancellation = getPlaylistDownloadGeneration(safePlaylistId);
  const wasActive = isPipelinePayloadActive({
    playlistId: safePlaylistId,
    playlistGeneration: generationBeforeCancellation,
  });
  const jobsToRestore = normalizedJobs
    .filter((job) => !isDownloadJobCancelled(job.id))
    .map((job) => job.id);
  const generation = cancelPlaylistDownloadGeneration(safePlaylistId);
  cancelDownloadJobs(normalizedJobs.map((job) => job.id));
  return { generation, jobs: normalizedJobs, wasActive, jobsToRestore };
}

export function restoreMarkedPlaylistDownloadWork(playlistId, cancellation) {
  if (cancellation?.wasActive) {
    return restorePlaylistDownloadWork(playlistId, cancellation.jobsToRestore);
  }
  return restoreDownloadJobCancellations(cancellation?.jobsToRestore) > 0;
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
  const cancel = () => {
    const currentJobs = refreshJobs(normalizedJobs);
    const providerWork = listDownloadProviderWork({
      jobIds: currentJobs.map((job) => job.id),
      provider: "slskd-search",
    });
    return cancelProviderWork(pipeline.payloads, currentJobs, providerWork);
  };
  const providers = lock
    ? await withPlaylistCancellationLocks(playlistIds, cancel)
    : await cancel();
  return {
    cancelled: pipeline.cancelled,
    provider: providers,
  };
}

export async function clearAllDownloadJobs(downloadTracker) {
  const jobs = downloadTracker.getAll();
  if (jobs.length === 0) return 0;
  const playlistIds = jobs.map((job) => normalizeId(job?.playlistId || job?.playlistType));
  try {
    await cancelDownloadWorkForJobs(jobs);
  } catch (error) {
    await withPlaylistCancellationLocks(playlistIds, () => {
      for (const job of jobs) {
        downloadTracker.setFailed(
          job.id,
          `Provider cancellation pending: ${error?.message || String(error)}`,
        );
      }
    });
    throw error;
  }
  return withPlaylistCancellationLocks(playlistIds, () => {
    let cleared = 0;
    for (const job of jobs) {
      if (downloadTracker.removeJob(job.id)) cleared += 1;
    }
    return cleared;
  });
}

export async function cancelPlaylistDownloadWork(playlistId, jobs = [], { lock = true } = {}) {
  const cancellation = markPlaylistDownloadWorkCancelled(playlistId, jobs);
  const safePlaylistId = normalizeId(playlistId);
  if (!safePlaylistId) return { cancelled: 0, generation: 0 };
  const { generation, jobs: normalizedJobs } = cancellation;
  const activePipeline = cancelPipelineRows(safePlaylistId, normalizedJobs);
  const cancel = () => {
    const currentJobs = refreshJobs(normalizedJobs);
    const providerWork = listDownloadProviderWork({
      playlistId: safePlaylistId,
      provider: "slskd-search",
    });
    return cancelProviderWork(activePipeline.payloads, currentJobs, providerWork);
  };
  const providers = lock
    ? await withPlaylistCancellationLocks([safePlaylistId], cancel)
    : await cancel();
  return {
    generation,
    cancelled: activePipeline.cancelled,
    provider: providers,
  };
}
