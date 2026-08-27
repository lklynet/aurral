import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger } from "./logger.js";
import { validateDownloadedTrack } from "./weeklyFlow/weeklyFlowSoulseekMatcher.js";
import {
  buildDeemixSearchQueries,
  rankDeemixResults,
} from "./weeklyFlow/weeklyFlowDeemixMatcher.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildResolvedPlaylistTrack as buildResolvedTrack,
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
  writeAudioMetadata,
} from "./playlistDownloadUtils.js";
import { getQualityProfile } from "./qualityProfileService.js";
import { isQualityUpgrade } from "./qualityProfileModel.js";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  blockPipelineJobForReview,
  finalizePipelineJobSuccess,
} from "./pipelineHelpers.js";

const SEARCH_LIMIT = 10;
const POLL_DELAY_SECONDS = 3;
const MAX_POLL_ATTEMPTS = 200;

function getDeemixClient() {
  return getDownloadClient("deemix");
}

function hasEnoughCandidates(aggregated, resolvedTrack) {
  return rankDeemixResults(aggregated, resolvedTrack).some((entry) => entry.preDownloadValid);
}

// The configured bitrate fixes the tier, so an upgrade that deemix cannot
// improve on is refused before the download rather than after validation.
function readUnusableUpgradeTier(upgradeForJobId) {
  if (!upgradeForJobId) return null;
  const tier = getDeemixClient().getQualityTierId();
  const currentTier = downloadTracker.getJob(upgradeForJobId)?.qualityTier || null;
  if (isQualityUpgrade({ tier }, currentTier, getQualityProfile())) return null;
  return `deemix downloads ${tier || "an unknown tier"}, which is not an upgrade over ${
    currentTier || "the current file"
  }`;
}

function readQueuedFilePath(queueItem) {
  const files = Array.isArray(queueItem?.files) ? queueItem.files : [];
  for (const file of files) {
    const remotePath = String(file?.path || "").trim();
    if (remotePath) return resolveLocalPath(remotePath, getPathMappings("deemix"));
  }
  return "";
}

function readQueueError(queueItem) {
  const errors = Array.isArray(queueItem?.errors) ? queueItem.errors : [];
  for (const error of errors) {
    const message = String(error?.error || error?.message || error || "").trim();
    if (message) return message;
  }
  return "";
}

async function handleDeemixSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const unusableUpgrade = readUnusableUpgradeTier(payload.upgradeForJobId);
  if (unusableUpgrade) {
    return helpers.failOrTryNextSource(payload, job, unusableUpgrade);
  }
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "deemix",
    downloadClient: "deemix",
  });
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
    .catch((err) => {
      console.warn(err);
    });

  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const client = getDeemixClient();
  const queries = buildDeemixSearchQueries(resolvedTrack);
  const aggregated = [];
  const seen = new Set();
  let lastError = "";
  for (const query of queries) {
    if (hasEnoughCandidates(aggregated, resolvedTrack)) break;
    try {
      const results = await client.search(query, { limit: SEARCH_LIMIT });
      mergeSearchResults(aggregated, seen, results, (entry) => String(entry.id || "").trim());
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn("deemix", "deemix search failed", {
        jobId: job.id,
        query,
        error: lastError,
      });
    }
  }

  const ranked = rankDeemixResults(aggregated, resolvedTrack);
  const deniedIds = new Set(
    (Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [])
      .filter((entry) => Array.isArray(entry) && entry[0] === "deemix")
      .map((entry) => String(entry[1] || "").trim()),
  );
  const candidates =
    deniedIds.size > 0
      ? ranked.filter((entry) => !deniedIds.has(String(entry?.raw?.id || "").trim()))
      : ranked;
  if (candidates.length === 0) {
    const message =
      lastError && aggregated.length === 0
        ? `deemix search failed: ${lastError}`
        : "No suitable deemix search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
    });
  }
  return {
    ...payload,
    phase: "download",
    source: "deemix",
    candidates,
    candidateIndex: 0,
    resolvedTrack,
  };
}

async function handleDeemixDownload(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  const url = candidate?.raw?.url;
  if (!url) {
    return helpers.failOrTryNextSource(payload, job, "No deemix track URL available");
  }
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => {
      console.warn(err);
    });

  const client = getDeemixClient();
  let queueUuid;
  try {
    queueUuid = await client.addToQueue(url, candidate.raw.id);
  } catch (error) {
    const message = error?.message || String(error);
    logger.warn("deemix", "deemix queue submission failed", {
      jobId: job.id,
      url,
      error: message,
    });
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, message);
  }

  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "deemix",
    downloadClient: "deemix",
    downloadClientId: queueUuid,
    releaseGuid: candidate.raw.id,
    releaseTitle: candidate.raw.title,
    remoteUsername: candidate.raw.artist,
    remoteFilename: candidate.raw.file,
  });

  return {
    ...payload,
    phase: "poll",
    source: "deemix",
    candidate,
    candidateIndex: index,
    queueUuid,
    pollAttempts: 0,
  };
}

async function handleDeemixPoll(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const client = getDeemixClient();
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  if (pollAttempts > MAX_POLL_ATTEMPTS) {
    await client.removeFromQueue(payload.queueUuid).catch(() => {});
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, "deemix polling timed out");
  }

  let queueItem;
  try {
    queueItem = await client.getQueueItem(payload.queueUuid);
  } catch (error) {
    logger.warn("deemix", "deemix queue poll failed", {
      jobId: job.id,
      uuid: payload.queueUuid,
      error: error?.message || String(error),
    });
    return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
  }

  const status = String(queueItem?.status || "").trim();
  if (!queueItem || status === "inQueue" || status === "downloading") {
    return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
  }
  const downloadedPath = readQueuedFilePath(queueItem);
  if (!downloadedPath) {
    await client.removeFromQueue(payload.queueUuid).catch(() => {});
    const reason = readQueueError(queueItem) || `deemix download ${status || "failed"}`;
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }
  return { ...payload, phase: "finalize", downloadedPath, pollAttempts };
}

async function handleDeemixFinalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const client = getDeemixClient();
  const candidate = getPayloadCandidate(payload);
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const filePath = String(payload.downloadedPath || "").trim();
  const exists = filePath ? await fs.stat(filePath).catch(() => null) : null;
  if (!exists?.isFile()) {
    await client.removeFromQueue(payload.queueUuid).catch(() => {});
    const reason = filePath
      ? `deemix download is not readable at ${filePath}. Add a path mapping for deemix in Settings.`
      : "deemix finished without an audio file";
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null, downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const validation = await validateDownloadedTrack(
    filePath,
    {
      ...candidate,
      raw: { ...(candidate?.raw || {}), file: candidate?.raw?.file || filePath },
    },
    resolvedTrack,
  );
  if (!validation.valid) {
    if (
      blockPipelineJobForReview({
        downloadTracker,
        job,
        validation,
        sourcePath: filePath,
      })
    ) {
      return null;
    }
    await client.removeFromQueue(payload.queueUuid).catch(() => {});
    const reason = validation.reason || "deemix download failed track validation";
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null, downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  await writeAudioMetadata(filePath, resolvedTrack);
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
    .catch((err) => {
      console.warn(err);
    });
  const playlistRoot = resolvePlaylistRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".flac"}`;
  const finalPath = path.join(finalDir, finalName);
  const committedFinalPath = await commitImportToPlaylistLibrary(filePath, finalPath);
  await client.removeFromQueue(payload.queueUuid).catch(() => {});
  return finalizePipelineJobSuccess({
    downloadTracker,
    job,
    committedFinalPath,
    album: candidate?.resolvedAlbumName || job.albumName,
    quality: validation.quality,
  });
}

export async function processDeemixPipelinePayload(payload, helpers = {}) {
  logger.debug("deemix", "deemix pipeline phase", {
    phase: payload.phase,
    jobId: payload.jobId,
    source: payload.source,
  });
  switch (payload.phase) {
    case "search":
      return handleDeemixSearch(payload, helpers);
    case "download":
      return handleDeemixDownload(payload, helpers);
    case "poll":
      return handleDeemixPoll(payload, helpers);
    case "finalize":
      return handleDeemixFinalize(payload, helpers);
    default:
      throw new Error(`Unknown deemix pipeline phase: ${payload.phase}`);
  }
}
