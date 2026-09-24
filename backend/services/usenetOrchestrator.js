import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { prowlarrClient } from "./prowlarrClient.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger } from "./logger.js";
import { buildFlowSearchTiers } from "./weeklyFlow/weeklyFlowSoulseekSearch.js";
import {
  isAudioFile,
  rankUsenetReleases,
  selectRankedUsenetCandidates,
} from "./weeklyFlow/weeklyFlowUsenetReleaseSearch.js";
import {
  selectVerifiedDownloadedFile,
  MATCHER_UNAVAILABLE_MESSAGE,
} from "./trackMatching/index.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildResolvedPlaylistTrack as buildResolvedTrack,
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
  writeAudioMetadata,
} from "./playlistDownloadUtils.js";
import { deferForInactiveOwner } from "./weeklyFlow/weeklyFlowOwnerStatus.js";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  blockPipelineJobForReview,
  finalizePipelineJobSuccess,
} from "./pipelineHelpers.js";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "./weeklyFlow/weeklyFlowDownloadCancellation.js";
import { getQualityProfile } from "./qualityProfileService.js";
import { orderAdvertisedQualityCandidates } from "./qualityProfileModel.js";

const MIN_USENET_CANDIDATES = 2;
const MAX_DOWNLOAD_CANDIDATES = 5;
const POLL_DELAY_SECONDS = 5;
const MAX_POLL_ATTEMPTS = 720;

function getUsenetClient() {
  const sabnzbd = getDownloadClient("sabnzbd");
  if (sabnzbd.isConfigured()) return sabnzbd;
  return getDownloadClient("nzbget");
}

function getUsenetClientKey() {
  return getUsenetClient().key;
}

function getSabnzbdClient() {
  return getDownloadClient("sabnzbd");
}

function removeSabnzbdItem(nzbId, jobId) {
  const client = getSabnzbdClient();
  client.deleteQueueItem(nzbId).catch((error) => {
    logger.warn("usenet", "Could not remove SABnzbd queue item", {
      jobId,
      reason: error?.message || String(error),
    });
  });
  client.deleteHistoryItem(nzbId).catch((error) => {
    logger.warn("usenet", "Could not remove SABnzbd history item", {
      jobId,
      reason: error?.message || String(error),
    });
  });
}

function hasEnoughCandidates(aggregated, resolvedTrack, qualityOptions) {
  const ranked = rankUsenetReleases(aggregated, resolvedTrack).filter(
    (entry) => entry.releaseAdmissible,
  );
  return orderAdvertisedQualityCandidates(ranked, {
    ...qualityOptions,
    readName: (entry) => entry?.raw?.release?.title,
  }).length >= MIN_USENET_CANDIDATES;
}

function classifyHistoryStatus(item) {
  const status = String(item?.Status || item?.status || "").toUpperCase();
  if (!status) return "pending";
  if (status.startsWith("SUCCESS") || status.startsWith("WARNING") || status.startsWith("COMPLETED")) {
    return "success";
  }
  if (status.startsWith("FAILED") || status.startsWith("FAILURE") || status.startsWith("DELETED")) {
    return "failed";
  }
  return "pending";
}

function readQueueStatus(item) {
  return String(item?.Status || item?.status || "").toUpperCase();
}

async function findAudioFilesRecursive(root, depth = 0, matches = []) {
  if (depth > 7) return matches;
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && isAudioFile(fullPath)) {
      matches.push(fullPath);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (name === "__macosx" || name === ".sync" || name === ".DS_Store") {
      continue;
    }
    await findAudioFilesRecursive(path.join(root, entry.name), depth + 1, matches);
  }
  return matches;
}

function uniqueResolvedPaths(values, source) {
  const seen = new Set();
  const out = [];
  const mappings = getPathMappings(source);
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(resolveLocalPath(raw, mappings));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export async function collectDownloadedAudioFiles(historyItem) {
  const clientKey = getUsenetClientKey();
  const roots = uniqueResolvedPaths([
    historyItem?.FinalDir,
    historyItem?.DestDir,
    historyItem?.storage,
    historyItem?.path,
    historyItem?.folder,
    historyItem?.dir,
  ], clientKey);
  const files = [];
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isFile() && isAudioFile(root)) {
      files.push(root);
      continue;
    }
    if (stat?.isDirectory()) {
      files.push(...(await findAudioFilesRecursive(root)));
    }
  }
  return uniqueResolvedPaths(files, clientKey);
}

async function validateDownloadedRelease(audioFilePaths, candidate, resolvedTrack) {
  // Post-download identity is decided by the shared engine: downloaded files
  // are assigned to the expected tracklist with beets when one is available
  // and validated individually against the requested track.
  return selectVerifiedDownloadedFile({
    request: resolvedTrack,
    filePaths: audioFilePaths,
    candidate,
    source: "usenet",
  });
}

async function handleUsenetSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "usenet",
  });
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
    .catch((err) => { console.warn(err); });

  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const qualityOptions = {
    profile: getQualityProfile(),
    currentTier: payload.upgradeForJobId
      ? downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier
      : null,
    upgrade: payload.upgrade === true,
  };
  const searchTiers = buildFlowSearchTiers(resolvedTrack);
  const aggregated = [];
  const seen = new Set();
  const queries = [];
  let lastError = "";
  for (const tier of searchTiers) {
    if (hasEnoughCandidates(aggregated, resolvedTrack, qualityOptions)) break;
    for (const query of tier.queries) {
      if (hasEnoughCandidates(aggregated, resolvedTrack, qualityOptions)) break;
      queries.push(query);
      try {
        const releases = await prowlarrClient.search(query);
        mergeSearchResults(aggregated, seen, releases, (release) =>
          [release.guid, release.downloadUrl, release.indexerId, release.title]
            .map((entry) => String(entry || "").trim().toLowerCase())
            .join("\0"),
        );
      } catch (error) {
        lastError = error?.message || String(error);
        logger.warn("slskd", "Prowlarr search failed", {
          jobId: job.id,
          query,
          error: lastError,
        });
      }
    }
  }
  const ranked = rankUsenetReleases(aggregated, resolvedTrack);
  const deniedSources = Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [];
  const deniedSourceGuidSet = new Set(
    deniedSources
      .filter((entry) => Array.isArray(entry) && entry[0] === "usenet")
      .map((entry) => String(entry[1] || "").trim()),
  );
  const filteredRanked = deniedSourceGuidSet.size > 0
    ? ranked.filter((entry) => !deniedSourceGuidSet.has(String(entry?.raw?.guid || "").trim()))
    : ranked;
  const qualityRanked = orderAdvertisedQualityCandidates(
    filteredRanked.filter((entry) => entry.releaseAdmissible),
    {
    ...qualityOptions,
    readName: (entry) => entry?.raw?.release?.title,
    },
  );
  const candidates = selectRankedUsenetCandidates(qualityRanked, MAX_DOWNLOAD_CANDIDATES).map((entry) => ({
    raw: entry.raw,
    score: entry.score,
    scores: entry.scores,
    resolvedAlbumName: entry.resolvedAlbumName,
    releaseAdmissible: entry.releaseAdmissible === true,
  }));
  if (candidates.length === 0) {
    const message =
      lastError && aggregated.length === 0
        ? `Prowlarr search failed: ${lastError}`
        : "No suitable Usenet search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
    });
  }
  return {
    ...payload,
    phase: "download",
    source: "usenet",
    candidates,
    candidateIndex: 0,
    resolvedTrack,
  };
}

async function handleUsenetDownload(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  const release = candidate?.raw?.release;
  if (!release?.downloadUrl) {
    return helpers.failOrTryNextSource(payload, job, "No Usenet release URL available");
  }
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => { console.warn(err); });

  const client = getUsenetClient();
  const clientKey = getUsenetClientKey();
  let submission;
  try {
    submission = await withPipelineCommitLock(payload, async () => {
      const appended = await client.appendUrl({
        name: release.title,
        url: release.downloadUrl,
        dupeKey: `aurral-${job.id}`,
        dupeScore: Number(candidate.score || 0),
      });
      downloadTracker.updateDownloadMetadata(job.id, {
        downloadSource: "usenet",
        downloadClient: clientKey,
        downloadClientId: appended.nzbId,
        releaseGuid: release.guid,
        releaseTitle: release.title,
        indexerId: release.indexerId,
        indexerName: release.indexer,
        remoteUsername: release.indexer,
        remoteFilename: release.title,
      });
      return appended;
    });
  } catch (error) {
    const message = error?.message || String(error);
    logger.warn("slskd", "Usenet client append failed for release", {
      jobId: job.id,
      client: clientKey,
      releaseTitle: release.title,
      error: message,
    });
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, { nzbId: null, history: null });
    return helpers.failOrTryNextSource(payload, job, message);
  }
  if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
  const appended = submission.result;
  return {
    ...payload,
    phase: "poll",
    source: "usenet",
    downloadClient: clientKey,
    nzbId: appended.nzbId,
    candidate,
    candidateIndex: index,
    pollAttempts: 0,
  };
}

async function handleUsenetPoll(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  if (pollAttempts > MAX_POLL_ATTEMPTS) {
    if (getUsenetClientKey() === "sabnzbd") {
      removeSabnzbdItem(payload.nzbId, job.id);
    }
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, { nzbId: null, history: null });
    return helpers.failOrTryNextSource(payload, job, "Usenet polling timed out");
  }
  const client = getUsenetClient();
  const historyItem = await client.getHistoryItem(payload.nzbId);
  if (historyItem) {
    const state = classifyHistoryStatus(historyItem);
    logger.debug("slskd", "usenet poll history status", { state, raw: historyItem?.Status || historyItem?.status, nzbId: payload.nzbId });
    if (state === "success") {
      return {
        ...payload,
        phase: "finalize",
        history: historyItem,
        pollAttempts,
      };
    }
    if (state === "failed") {
      if (getUsenetClientKey() === "sabnzbd") {
        removeSabnzbdItem(payload.nzbId, job.id);
      }
      if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, { nzbId: null, history: null });
      return helpers.failOrTryNextSource(
        payload,
        job,
        `Usenet download failed: ${historyItem.Status || historyItem.status || "failed"}`,
      );
    }
  }
  const queueItem = await client.getQueueItem(payload.nzbId);
  const queueStatus = readQueueStatus(queueItem);
  if (queueStatus && queueStatus.includes("PAUSED")) {
    return {
      ...payload,
      phase: "poll",
      delaySeconds: POLL_DELAY_SECONDS,
      pollAttempts,
    };
  }
  return {
    ...payload,
    phase: "poll",
    delaySeconds: POLL_DELAY_SECONDS,
    pollAttempts,
  };
}

async function handleUsenetFinalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidate = getPayloadCandidate(payload);
  const client = getUsenetClient();
  const historyItem = payload.history || (await client.getHistoryItem(payload.nzbId));
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const found = await validateDownloadedRelease(
    await collectDownloadedAudioFiles(historyItem),
    candidate,
    resolvedTrack,
  );
  if (!isPipelinePayloadActive(payload)) {
    if (job.downloadClient === "sabnzbd") removeSabnzbdItem(payload.nzbId, job.id);
    return null;
  }
  if (
    blockPipelineJobForReview({
      downloadTracker,
      job,
      validation: found.validation,
      sourcePath: found.filePath,
    })
  ) {
    return null;
  }
  if (!found.filePath) {
    const reason =
      found.validation?.reason ||
      (found.validation?.error
        ? MATCHER_UNAVAILABLE_MESSAGE
        : "Usenet download completed, but no matching audio file was found");
    if (getUsenetClientKey() === "sabnzbd") {
      removeSabnzbdItem(payload.nzbId, job.id);
    }
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, { nzbId: null, history: null });
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const playlistRoot = resolvePlaylistRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(found.filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".mp3"}`;
  const finalPath = path.join(finalDir, finalName);
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const committed = await withPipelineCommitLock(payload, async () => {
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => { console.warn(err); });
    await writeAudioMetadata(found.filePath, resolvedTrack);
    const committedFinalPath = await commitImportToPlaylistLibrary(
      found.filePath,
      finalPath,
    );
    if (getUsenetClientKey() === "sabnzbd") {
      removeSabnzbdItem(payload.nzbId, job.id);
    }
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      album: candidate?.resolvedAlbumName || job.albumName,
      quality: found.validation?.quality,
    });
  });
  if (committed.cancelled) {
    return null;
  }
  return committed.result;
}

export async function processUsenetPipelinePayload(payload, helpers = {}) {
  logger.debug("slskd", "usenet pipeline phase", { phase: payload.phase, jobId: payload.jobId, source: payload.source });
  if (!isPipelinePayloadActive(payload)) return null;
  switch (payload.phase) {
    case "search":
      return handleUsenetSearch(payload, helpers);
    case "download":
      return handleUsenetDownload(payload, helpers);
    case "poll":
      return handleUsenetPoll(payload, helpers);
    case "finalize":
      return handleUsenetFinalize(payload, helpers);
    default:
      throw new Error(`Unknown Usenet pipeline phase: ${payload.phase}`);
  }
}
