import path from "path";
import fs from "fs/promises";
import { db } from "../config/db-sqlite.js";
import { isSlskdCleanupAfterRunsEnabled, slskdClient } from "./slskdClient.js";
import { logger } from "./logger.js";
import { enqueuePipelineJob } from "./honkerDb.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  buildFlowSearchTiers,
  rankFlowSearchResults,
  selectRankedMatchAttempts,
  validateDownloadedTrack,
} from "./weeklyFlow/weeklyFlowSoulseekMatcher.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildSlskdRankingHistoryOptions,
  recordSlskdTransferOutcome,
} from "./slskdTransferHistory.js";
import { processUsenetPipelinePayload } from "./usenetOrchestrator.js";
import { processYtdlpPipelinePayload } from "./ytdlpOrchestrator.js";
import {
  getDownloadSourceNotConfiguredMessage,
  getEnabledDownloadSources,
  getSourceLabel,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.js";
import {
  buildResolvedPlaylistTrack as buildResolvedTrack,
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
  writeAudioMetadata,
} from "./playlistDownloadUtils.js";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  blockPipelineJobForReview,
  finalizePipelineJobSuccess,
} from "./pipelineHelpers.js";
import { getQualityProfile } from "./qualityProfileService.js";
import { getQualityTier, orderAdvertisedQualityCandidates } from "./qualityProfileModel.js";

export { commitImportToPlaylistLibrary };

const updateSlskdMetaStmt = db.prepare(`
  UPDATE playlist_download_jobs
  SET slskd_search_id = COALESCE(?, slskd_search_id),
      slskd_batch_id = COALESCE(?, slskd_batch_id),
      remote_username = COALESCE(?, remote_username),
      remote_filename = COALESCE(?, remote_filename)
  WHERE id = ?
`);

const MIN_SEARCH_CANDIDATES = 3;
const MAX_DOWNLOAD_CANDIDATES = 7;
const MAX_TRANSFER_RETRIES_PER_CANDIDATE = 1;
const POLL_DELAY_SECONDS = 3;
const SLSKD_NOT_CONFIGURED_MESSAGE =
  "slskd is not configured. Add your slskd URL and API key in Settings > Integrations to enable Soulseek downloads for flows and playlists.";

export function buildSlskdSearchTierGroups(resolvedTrack) {
  return buildFlowSearchTiers(resolvedTrack);
}

export function hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions) {
  const ranked = rankFlowSearchResults(aggregated, resolvedTrack, searchOptions)
    .filter((entry) => entry.preDownloadValid);
  const eligible = orderAdvertisedQualityCandidates(ranked, {
    profile: searchOptions?.qualityProfile || getQualityProfile(),
    currentTier: searchOptions?.currentTier || null,
    upgrade: searchOptions?.upgrade === true,
    readName: (entry) => entry?.raw?.file,
    readBitrate: (entry) => entry?.raw?.bitrate ?? entry?.raw?.bitRate,
  });
  return eligible.length >= MIN_SEARCH_CANDIDATES;
}

const _MAX_EMPTY_POLL_ATTEMPTS = 60;
const MAX_POLL_ATTEMPTS = 600;

async function getWorkerSearchOptions() {
  const profile = getQualityProfile();
  const firstEnabled = profile.order.find((id) => profile.enabled.includes(id));
  return {
    preferredFormat: getQualityTier(firstEnabled)?.family || "flac",
    strictFormat: false,
    ...buildSlskdRankingHistoryOptions(),
  };
}

function classifyTransferState(state) {
  const normalized = String(state || "").toLowerCase();
  if (!normalized) return "pending";
  if (
    normalized.includes("error") ||
    normalized.includes("fail") ||
    normalized.includes("cancel") ||
    normalized.includes("abort") ||
    normalized.includes("reject") ||
    normalized.includes("timeout")
  ) {
    return "failed";
  }
  if (normalized.includes("completed") || normalized.includes("succeeded")) {
    return "success";
  }
  return "pending";
}

function readBatchTransfers(batch) {
  const transfers = batch?.transfers || batch?.Transfers;
  if (Array.isArray(transfers)) return transfers;
  if (Array.isArray(transfers?.$values)) return transfers.$values;
  return [];
}

function readTransferState(transfer) {
  return transfer?.state || transfer?.State || "";
}

function readTransferId(transfer) {
  return String(
    transfer?.id || transfer?.Id || transfer?.transferId || transfer?.TransferId || "",
  ).trim();
}

function getPayloadSearchIds(payload) {
  const ids = [];
  if (Array.isArray(payload?.searchIds)) ids.push(...payload.searchIds);
  if (payload?.searchId) ids.push(payload.searchId);
  return [...new Set(ids.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function getCandidateRetryCount(payload, candidateIndex = null) {
  const index =
    candidateIndex == null ? Number(payload?.candidateIndex || 0) : Number(candidateIndex || 0);
  const counts =
    payload?.candidateRetryCounts && typeof payload.candidateRetryCounts === "object"
      ? payload.candidateRetryCounts
      : {};
  return Number(counts[index] || 0);
}

function withCandidateRetryCount(payload, candidateIndex, retryCount) {
  return {
    ...payload,
    candidateRetryCounts: {
      ...(payload?.candidateRetryCounts || {}),
      [Number(candidateIndex || 0)]: Number(retryCount || 0),
    },
  };
}

function buildRetrySameCandidatePayload(payload, delaySeconds = 5) {
  const candidateIndex = Number(payload?.candidateIndex || 0);
  const retryCount = getCandidateRetryCount(payload, candidateIndex) + 1;
  return {
    ...withCandidateRetryCount(payload, candidateIndex, retryCount),
    phase: "download",
    candidate: null,
    pollAttempts: 0,
    batchId: null,
    legacyTransfer: null,
    delaySeconds,
  };
}

function readEventData(record) {
  const data = record?.data ?? record?.Data;
  if (!data) return null;
  if (typeof data === "object") return data;
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function normalizeRemotePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function eventMatchesCandidate(record, candidate) {
  const raw = candidate?.raw || {};
  const expectedUser = String(raw.user || "")
    .trim()
    .toLowerCase();
  const expectedFile = normalizeRemotePath(raw.file);
  if (!expectedUser || !expectedFile) return false;
  const data = readEventData(record);
  const transfer = data?.transfer || data?.Transfer || data;
  const eventUser = String(
    transfer?.username || transfer?.Username || data?.username || data?.Username || "",
  )
    .trim()
    .toLowerCase();
  const eventFile = normalizeRemotePath(
    transfer?.filename ||
      transfer?.Filename ||
      transfer?.file ||
      transfer?.File ||
      data?.filename ||
      data?.Filename ||
      "",
  );
  if (eventUser && eventUser !== expectedUser) return false;
  if (eventFile && eventFile === expectedFile) return true;
  const eventDir = normalizeRemotePath(
    data?.remoteDirectoryName || data?.RemoteDirectoryName || "",
  );
  const expectedParent = normalizeRemotePath(parseSlskdRemoteFile(raw.file).parentDir);
  return !!eventDir && !!expectedParent && eventDir.endsWith(expectedParent);
}

async function pollSlskdEventsForCandidate(payload) {
  const offset = Number(payload?.eventOffset);
  if (!Number.isFinite(offset) || offset < 0) {
    return { eventOffset: payload?.eventOffset ?? null, completionTransfer: null };
  }
  const candidate = getPayloadCandidate(payload);
  if (!candidate) {
    return { eventOffset: offset, completionTransfer: null };
  }
  const result = await slskdClient.getEvents(offset, 50);
  const events = Array.isArray(result?.events) ? result.events : [];
  const nextOffset = Math.max(offset + events.length, Number(result?.totalCount || 0));
  let completionTransfer = null;
  for (const event of events) {
    const type = String(event?.type || event?.Type || "");
    if (!type.includes("DownloadFileComplete") && !type.includes("DownloadDirectoryComplete")) {
      continue;
    }
    if (!eventMatchesCandidate(event, candidate)) continue;
    const data = readEventData(event);
    completionTransfer = data?.transfer || data?.Transfer || data || null;
  }
  return { eventOffset: nextOffset, completionTransfer };
}

async function readCurrentEventOffset() {
  try {
    const result = await slskdClient.getEvents(0, 1);
    return Math.max(
      Number(result?.totalCount || 0),
      Array.isArray(result?.events) ? result.events.length : 0,
    );
  } catch {
    return null;
  }
}

function isPathInside(childPath, rootPath) {
  if (!String(childPath || "").trim() || !String(rootPath || "").trim()) {
    return false;
  }
  const child = path.resolve(String(childPath || ""));
  const root = path.resolve(String(rootPath || ""));
  return child === root || child.startsWith(`${root}${path.sep}`);
}

export function enqueueJobPipeline(jobId) {
  return downloadTracker.enqueueSlskdPipeline(jobId);
}

export function enqueuePendingJobsWithoutBatch() {
  if (!isAnyDownloadSourceConfigured()) return 0;
  let count = 0;
  for (const job of downloadTracker.getByStatus("pending")) {
    if (!job.slskdBatchId && !job.slskdSearchId) continue;
    downloadTracker.clearSlskdPipelineState(job.id);
    if (enqueueJobPipeline(job.id)) count += 1;
  }
  return count;
}

async function failJob(job, message) {
  if (job.upgradeForJobId) {
    const { finalizeQualityUpgradeFailure } = await import("./qualityProfileService.js");
    await finalizeQualityUpgradeFailure(job, message);
    return;
  }
  downloadTracker.setFailed(job.id, message);
  try {
    const { recordTrackJobFailed } = await import("./aurralHistoryService.js");
    recordTrackJobFailed(job, message);
  } catch {}
  try {
    const { weeklyFlowWorker } = await import("./weeklyFlow/weeklyFlowWorker.js");
    weeklyFlowWorker.wake(0);
    await weeklyFlowWorker.checkPlaylistComplete(job.playlistId || job.playlistType);
  } catch (error) {
    logger.warn("slskd", "Failed to run post-failure playlist checks", {
      jobId: job.id,
      error: error?.message || String(error),
    });
  }
}

function isSourceConfigured(sourceId) {
  return getEnabledDownloadSources().some((source) => source.id === sourceId);
}

function buildNextSourcePayload(payload, failedSource = null, reason = null) {
  const allowedSources = Array.isArray(payload?.allowedSources)
    ? new Set(payload.allowedSources)
    : null;
  const sources = getEnabledDownloadSources().filter(
    (source) => !allowedSources || allowedSources.has(source.id),
  );
  if (sources.length === 0) return null;
  const tried = new Set(Array.isArray(payload?.triedSources) ? payload.triedSources : []);
  const sourceErrors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  if (failedSource) {
    tried.add(failedSource);
    if (reason) {
      sourceErrors.push({
        source: failedSource,
        message: String(reason || "").trim(),
      });
    }
  }
  const next = sources.find((source) => !tried.has(source.id));
  if (!next) return null;
  return {
    ...payload,
    source: next.id,
    phase: "search",
    searchId: null,
    searchIds: [],
    candidates: [],
    candidate: null,
    candidateIndex: 0,
    candidateRetryCounts: {},
    pollAttempts: 0,
    batchId: null,
    legacyTransfer: null,
    nzbId: null,
    history: null,
    downloadedPath: null,
    triedSources: [...tried],
    sourceErrors,
  };
}

function summarizeSourceErrors(payload, message) {
  const errors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  const source = String(payload?.source || "").trim();
  if (source && message) {
    errors.push({ source, message: String(message || "").trim() });
  }
  const summary = errors
    .map((entry) => {
      const label = getSourceLabel(entry.source);
      const entryMessage = String(entry.message || "").trim();
      return entryMessage ? `${label}: ${entryMessage}` : label;
    })
    .filter(Boolean)
    .join("; ");
  return summary || message;
}

async function failOrTryNextSource(payload, job, message, logDetails = {}) {
  const nextPayload = buildNextSourcePayload(payload, payload?.source || "slskd", message);
  if (nextPayload) {
    logger.info("slskd", "Trying next download source", {
      jobId: job?.id,
      failedSource: payload?.source || "slskd",
      nextSource: nextPayload.source,
      reason: message,
      ...logDetails,
    });
    downloadTracker.clearSlskdDispatched(job.id);
    return nextPayload;
  }
  await failJob(job, summarizeSourceErrors(payload, message));
  return null;
}

export async function failPipelineJob(payload, message) {
  const jobId = payload?.jobId;
  if (!jobId) return;
  const job = downloadTracker.getJob(jobId);
  if (!job) return;
  if (job.status === "downloading" || job.status === "pending") {
    await failJob(job, message);
  }
}

export function parseSlskdRemoteFile(remoteFile) {
  const normalized = String(remoteFile || "")
    .replace(/\\/g, "/")
    .trim();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { fileName: "", parentDir: "" };
  }
  return {
    fileName: parts[parts.length - 1],
    parentDir: parts.length > 1 ? parts[parts.length - 2] : "",
  };
}

export function predictSlskdLocalPathCandidates(root, remoteFile) {
  const base = String(root || "").trim();
  if (!base) return [];
  const { fileName, parentDir } = parseSlskdRemoteFile(remoteFile);
  if (!fileName) return [];
  const candidates = [];
  if (parentDir) {
    candidates.push(path.join(base, parentDir, fileName));
  }
  candidates.push(path.join(base, fileName));
  const seen = new Set();
  return candidates.filter((candidate) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function readTransferFilename(transfer) {
  return String(
    transfer?.filename || transfer?.Filename || transfer?.file || transfer?.File || "",
  ).trim();
}

function resolveTransferLocalPath(transferFilename, slskdRoot) {
  const raw = String(transferFilename || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, path.sep);
  const slskdMappings = getPathMappings("slskd");
  if (path.isAbsolute(normalized)) {
    return path.resolve(resolveLocalPath(normalized, slskdMappings));
  }
  const slskdBase = String(slskdRoot || "").trim();
  if (!slskdBase) return null;
  const resolvedBase = path.resolve(slskdBase);
  if (normalized === resolvedBase || normalized.startsWith(`${resolvedBase}${path.sep}`)) {
    return path.resolve(normalized);
  }
  return path.resolve(resolvedBase, normalized);
}

async function statMatchingFile(filePath, expectedSizeBytes) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const expected = Number(expectedSizeBytes || 0);
    if (expected > 0 && stat.size !== expected) return null;
    return filePath;
  } catch {
    return null;
  }
}

async function findFileRecursive(dir, fileName, expectedSizeBytes, depth = 0, matches = null) {
  if (depth > 8) return matches;
  const collected = matches || [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat?.isFile()) {
        collected.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await findFileRecursive(
      path.join(dir, entry.name),
      fileName,
      expectedSizeBytes,
      depth + 1,
      collected,
    );
  }
  if (depth > 0 || matches) return collected;
  return pickBestFileMatch(collected, expectedSizeBytes);
}

function pickBestFileMatch(matches, expectedSizeBytes) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const expected = Number(expectedSizeBytes || 0);
  if (expected > 0) {
    const sizeMatches = matches.filter((entry) => entry.size === expected);
    if (sizeMatches.length === 1) return sizeMatches[0].path;
    if (sizeMatches.length > 1) {
      return sizeMatches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0].path;
    }
    return null;
  }
  if (matches.length === 1) return matches[0].path;
  return matches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0].path;
}

export async function locateCompletedDownload(slskdRoot, playlistRoot, remoteFile, options = {}) {
  const expectedSizeBytes = Number(options.expectedSizeBytes || 0);
  const transferFilename = readTransferFilename(options.transfer);
  const transferPath = resolveTransferLocalPath(transferFilename, slskdRoot);
  if (transferPath) {
    const directTransfer = await statMatchingFile(transferPath, expectedSizeBytes);
    if (directTransfer) return directTransfer;
  }

  const searchRoots = [];
  if (slskdRoot) searchRoots.push(slskdRoot);
  if (playlistRoot) {
    const resolvedPlaylist = path.resolve(playlistRoot);
    const resolvedSlskd = String(slskdRoot || "").trim()
      ? path.resolve(String(slskdRoot || "").trim())
      : "";
    if (!resolvedSlskd || resolvedPlaylist !== resolvedSlskd) {
      searchRoots.push(playlistRoot);
    }
  }

  for (const root of searchRoots) {
    for (const candidate of predictSlskdLocalPathCandidates(root, remoteFile)) {
      const matched = await statMatchingFile(candidate, expectedSizeBytes);
      if (matched) return matched;
    }
  }

  for (const root of searchRoots) {
    const found = await findFileRecursive(
      root,
      parseSlskdRemoteFile(remoteFile).fileName,
      expectedSizeBytes,
    );
    if (found) return found;
  }
  return null;
}

async function cleanupRejectedDownload({
  sourcePath,
  slskdRoot,
  playlistRoot,
  transfer,
  username,
} = {}) {
  const transferId = readTransferId(transfer);
  const transferUser = String(username || transfer?.username || transfer?.Username || "").trim();
  if (transferUser && transferId) {
    await slskdClient
      .deleteTransfer(transferUser, transferId, { remove: true })
      .catch((err) => { logger.warn("slskd", "Failed to clean up transfer", { transferId, error: err?.message || String(err) }); });  }
  const safeSource = String(sourcePath || "").trim();
  const safeSlskdRoot = String(slskdRoot || "").trim();
  const safePlaylistRoot = String(playlistRoot || "").trim();
  if (
    safeSource &&
    safeSlskdRoot &&
    isPathInside(safeSource, safeSlskdRoot) &&
    (!safePlaylistRoot || !isPathInside(safeSource, safePlaylistRoot))
  ) {
    await fs.rm(safeSource, { force: true }).catch((err) => { logger.warn("slskd", "Failed to remove rejected download file", { sourcePath: safeSource, error: err?.message || String(err) }); });
    await cleanupEmptyAncestors(path.dirname(safeSource), safeSlskdRoot).catch(
      () => {},
    );  }
}

async function cleanupTransferForPayload(payload, transfer) {
  const transferId = readTransferId(transfer);
  if (!transferId) return;
  const candidate = getPayloadCandidate(payload);
  const username = String(
    transfer?.username || transfer?.Username || candidate?.raw?.user || "",
  ).trim();
  if (!username) return;
  await slskdClient
    .deleteTransfer(username, transferId, { remove: true })
    .catch((err) => { logger.warn("slskd", "Failed to clean up transfer for payload", { transferId, error: err?.message || String(err) }); });}

async function cleanupSuccessfulRunArtifacts(payload, transfer) {
  if (!isSlskdCleanupAfterRunsEnabled()) return;
  const searchIds = getPayloadSearchIds(payload);
  const transferId = readTransferId(transfer);
  const candidate = getPayloadCandidate(payload);
  const username = String(
    transfer?.username || transfer?.Username || candidate?.raw?.user || "",
  ).trim();
  const transfers =
    username && transferId
      ? [
          {
            username,
            transferId,
          },
        ]
      : [];
  if (searchIds.length === 0 && transfers.length === 0) return;
  await slskdClient.cleanupAfterRun({ searchIds, transfers }).catch((error) =>
    logger.warn("slskd", "Failed to clean up successful slskd run", {
      error: error?.message || String(error),
      searchIds,
      transferCount: transfers.length,
    }),
  );
}

async function cleanupEmptyAncestors(dir, rootBoundary) {
  const root = path.resolve(String(rootBoundary || "").trim());
  if (!root) return;
  let current = path.resolve(String(dir || "").trim());
  if (!current || current === root) return;
  while (current.startsWith(`${root}${path.sep}`)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) break;
      await fs.rmdir(current);
      current = path.dirname(current);
      if (current === root) break;
    } catch {
      break;
    }
  }
}

function recordPayloadOutcome(job, payload, status, reason, details = {}) {
  recordSlskdTransferOutcome({
    job,
    candidate: details.candidate || getPayloadCandidate(payload),
    status,
    reason,
    transfer: details.transfer || null,
    transferId: details.transferId || null,
    searchIds: getPayloadSearchIds(payload),
    batchId: details.batchId || payload?.batchId || job?.slskdBatchId || null,
    sourcePath: details.sourcePath || null,
    finalPath: details.finalPath || null,
    validation: details.validation || null,
  });
}

function retrySameCandidateAllowed(payload) {
  return (
    getCandidateRetryCount(payload, Number(payload?.candidateIndex || 0)) <
    MAX_TRANSFER_RETRIES_PER_CANDIDATE
  );
}

function retrySameCandidateOrNext(payload, job, status, reason, details = {}) {
  recordPayloadOutcome(job, payload, status, reason, details);
  if (retrySameCandidateAllowed(payload)) {
    return buildRetrySameCandidatePayload(payload, 5);
  }
  if (hasNextCandidate(payload)) {
    return buildNextCandidatePayload(payload, { batchId: null, legacyTransfer: null });
  }
  return null;
}

function probeAggregatedResults(aggregated, queryResults, seen) {
  const probe = aggregated.slice();
  const probeSeen = new Set(seen);
  for (const result of queryResults) {
    const key = `${result.user}\0${result.file}`;
    if (probeSeen.has(key)) continue;
    probeSeen.add(key);
    probe.push(result);
  }
  return probe;
}

async function runSearchQuery(
  query,
  searchIdRef,
  searchIds,
  resolvedTrack,
  searchOptions,
  aggregated,
  seen,
) {
  const created = await slskdClient.createSearch(query);
  if (Array.isArray(searchIds)) {
    searchIds.push(created.id);
  }
  if (!searchIdRef.value) {
    searchIdRef.value = created.id;
  }
  const completed = await slskdClient.waitForSearch(created.id, undefined, {
    earlyExitWhen: (data) =>
      hasSlskdSearchCandidates(
        probeAggregatedResults(aggregated, slskdClient.flattenSearchResults(data), seen),
        resolvedTrack,
        searchOptions,
      ),
  });
  const results = slskdClient.flattenSearchResults(completed);
  const shouldCancel = hasSlskdSearchCandidates(
    probeAggregatedResults(aggregated, results, seen),
    resolvedTrack,
    searchOptions,
  );
  await slskdClient.settleSearch(created.id, { cancel: shouldCancel });
  return results;
}

async function handleSearch(payload) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "slskd",
  });
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
    .catch((err) => { logger.warn("slskd", "Failed to record track job searching", { jobId: job.id, error: err?.message || String(err) }); });
  const resolvedTrack = buildResolvedTrack(job, payload.track);
  const searchTiers = buildSlskdSearchTierGroups(resolvedTrack);
  const currentTier = payload.upgradeForJobId
    ? downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier
    : null;
  const searchOptions = {
    ...(await getWorkerSearchOptions()),
    qualityProfile: getQualityProfile(),
    currentTier,
    upgrade: payload.upgrade === true,
  };
  const aggregated = [];
  const seen = new Set();
  const searchIdRef = { value: null };
  const searchIds = [];
  const queries = [];
  for (const tier of searchTiers) {
    if (hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions)) {
      break;
    }
    for (const query of tier.queries) {
      if (hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions)) {
        break;
      }
      queries.push(query);
      const results = await runSearchQuery(
        query,
        searchIdRef,
        searchIds,
        resolvedTrack,
        searchOptions,
        aggregated,
        seen,
      );
      mergeSearchResults(aggregated, seen, results, (result) => `${result.user}\0${result.file}`);
      if (hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions)) {
        break;
      }
    }
  }
  if (searchIdRef.value) {
    updateSlskdMetaStmt.run(searchIdRef.value, null, null, null, job.id);
    job.slskdSearchId = searchIdRef.value;
  }
  const ranked = rankFlowSearchResults(aggregated, resolvedTrack, searchOptions);
  const orderForQuality = (entries) => orderAdvertisedQualityCandidates(entries, {
    profile: getQualityProfile(),
    currentTier,
    upgrade: payload.upgrade === true,
    readName: (entry) => entry?.raw?.file,
    readBitrate: (entry) => entry?.raw?.bitrate ?? entry?.raw?.bitRate,
  });
  const eligible = orderForQuality(ranked.filter((entry) => entry.preDownloadValid));
  const deniedSources = Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [];
  const deniedSourceKeys = new Set(
    deniedSources
      .filter((entry) => Array.isArray(entry) && entry[0] === "slskd")
      .map((entry) => String(entry[1] || "").trim().toLowerCase()),
  );
  const filteredPool = deniedSourceKeys.size > 0
    ? eligible.filter((entry) => {
        const user = String(entry?.raw?.user || "").trim().toLowerCase();
        const file = String(entry?.raw?.file || "").trim().toLowerCase();
        return !deniedSourceKeys.has(`${user}\0${file}`);
      })
    : eligible;
  const candidates = selectRankedMatchAttempts(filteredPool, MAX_DOWNLOAD_CANDIDATES).map(
    (entry) => ({
      raw: entry.raw,
      score: entry.score,
      resolvedAlbumName: entry.resolvedAlbumName,
      preDownloadValid: entry.preDownloadValid === true,
    }),
  );
  if (candidates.length === 0) {
    logger.warn("slskd", "No slskd download candidates after search", {
      jobId: job.id,
      artistName: job.artistName,
      trackName: job.trackName,
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
      eligibleCount: eligible.length,
    });
    if (searchIds.length > 0) {
      await slskdClient
        .cleanupAfterRun({ searchIds, transfers: [] })
        .catch((err) => { logger.warn("slskd", "Failed to clean up slskd run after empty search", { error: err?.message || String(err) }); });    }
    return failOrTryNextSource(payload, job, "No suitable slskd search results", {
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
      eligibleCount: eligible.length,
    });
  }
  return {
    ...payload,
    phase: "download",
    searchId: searchIdRef.value,
    searchIds: [...new Set(searchIds)],
    candidates,
    candidateIndex: 0,
    candidateRetryCounts: {},
  };
}

async function handleDownload(payload) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => { logger.warn("slskd", "Failed to record track job downloading", { jobId: job.id, error: err?.message || String(err) }); });
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  if (!candidate?.raw?.user || !candidate?.raw?.file) {
    return failOrTryNextSource(payload, job, "No download candidate available");
  }
  const searchId = payload.searchId || null;
  updateSlskdMetaStmt.run(searchId, null, candidate.raw.user, candidate.raw.file, job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "slskd",
    downloadClient: "slskd",
    remoteUsername: candidate.raw.user,
    remoteFilename: candidate.raw.file,
  });
  let result;
  try {
    result = await slskdClient.enqueueBatch({
      username: candidate.raw.user,
      files: [
        {
          filename: candidate.raw.file,
          size: Number(candidate.raw.size || 0),
        },
      ],
      options: {
        externalId: job.id,
        searchId,
      },
    });
  } catch (error) {
    const message = error?.message || String(error);
    recordPayloadOutcome(job, { ...payload, candidate }, "enqueue_failed", message, { candidate });
    logger.warn("slskd", "slskd batch enqueue failed for candidate", {
      jobId: job.id,
      username: candidate.raw.user,
      file: candidate.raw.file,
      candidateIndex: index,
      error: message,
    });
    const nextIndex = index + 1;
    if (nextIndex < candidates.length) {
      return {
        ...payload,
        phase: "download",
        candidateIndex: nextIndex,
        pollAttempts: 0,
      };
    }
    return failOrTryNextSource(payload, job, message);
  }
  updateSlskdMetaStmt.run(null, result.batchId || null, null, null, job.id);
  job.slskdBatchId = result.batchId || null;
  const eventOffset =
    payload.eventOffset != null ? payload.eventOffset : await readCurrentEventOffset();
  return {
    ...payload,
    phase: "poll",
    batchId: result.batchId,
    legacyTransfer: result.legacy
      ? {
          id: result.transferId,
          username: result.username || candidate.raw.user,
        }
      : null,
    candidate,
    candidateIndex: index,
    eventOffset,
    pollAttempts: 0,
  };
}

async function handlePoll(payload) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  if (pollAttempts > MAX_POLL_ATTEMPTS) {
    recordPayloadOutcome(job, payload, "transfer_timeout", "slskd transfer polling timed out");
    return failOrTryNextSource(payload, job, "slskd transfer polling timed out");
  }
  const eventSignal = await pollSlskdEventsForCandidate(payload).catch(() => ({
    eventOffset: payload.eventOffset ?? null,
    completionTransfer: null,
  }));
  const basePayload = {
    ...payload,
    eventOffset: eventSignal.eventOffset ?? payload.eventOffset,
  };
  if (eventSignal.completionTransfer) {
    const candidate = getPayloadCandidate(basePayload);
    return {
      ...basePayload,
      phase: "finalize",
      batch: { transfers: [eventSignal.completionTransfer] },
      pollAttempts,
      candidate,
    };
  }
  if (payload.legacyTransfer?.id && payload.legacyTransfer?.username) {
    const transfer = await slskdClient.getTransfer(
      payload.legacyTransfer.username,
      payload.legacyTransfer.id,
    );
    if (!transfer) {
      return {
        ...basePayload,
        phase: "poll",
        delaySeconds: POLL_DELAY_SECONDS,
        pollAttempts,
      };
    }
    const state = classifyTransferState(readTransferState(transfer));
    if (state === "failed") {
      await cleanupTransferForPayload(basePayload, transfer);
      const nextPayload = retrySameCandidateOrNext(
        basePayload,
        job,
        "transfer_failed",
        "slskd transfer failed",
        { transfer },
      );
      if (nextPayload) return nextPayload;
      return failOrTryNextSource(basePayload, job, "slskd transfer failed");
    }
    if (state !== "success") {
      return {
        ...basePayload,
        phase: "poll",
        delaySeconds: POLL_DELAY_SECONDS,
        pollAttempts,
      };
    }
    const candidate = getPayloadCandidate(basePayload);
    return {
      ...basePayload,
      phase: "finalize",
      batch: { transfers: [transfer] },
      pollAttempts,
      candidate,
    };
  }
  return {
    ...basePayload,
    phase: "poll",
    delaySeconds: POLL_DELAY_SECONDS,
    pollAttempts,
  };
}

async function handleFinalize(payload) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const playlistRoot = resolvePlaylistRoot();
  const slskdRoot = resolveLocalPath(
    await slskdClient.getDownloadDirectory(),
    getPathMappings("slskd"),
  );
  const destination = String(payload.destination || "").trim();
  const candidateIndex = Number(payload.candidateIndex || 0);
  const candidate =
    payload.candidate ||
    (Array.isArray(payload.candidates) ? payload.candidates[candidateIndex] : null);
  const remoteFile = String(candidate?.raw?.file || "");
  const { fileName } = parseSlskdRemoteFile(remoteFile);
  const transfers = readBatchTransfers(payload.batch);
  const transfer = transfers[0] || null;
  const sourcePath = await locateCompletedDownload(slskdRoot, playlistRoot, remoteFile, {
    expectedSizeBytes: Number(candidate?.raw?.size || 0),
    transfer,
  });
  if (!sourcePath) {
    const searchRoot = slskdRoot || playlistRoot;
    const [predictedPath] = predictSlskdLocalPathCandidates(searchRoot, remoteFile);
    const expectedPath = predictedPath || fileName;
    const nextPayload = retrySameCandidateOrNext(
      payload,
      job,
      "missing_file",
      `Downloaded file missing: ${expectedPath}`,
      { transfer },
    );
    if (nextPayload) return nextPayload;
    return failOrTryNextSource(payload, job, `Downloaded file missing: ${expectedPath}`);
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".mp3"}`;
  const finalPath = path.join(finalDir, finalName);
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const validation = await validateDownloadedTrack(
    sourcePath,
    candidate,
    resolvedTrack,
  );
  if (!validation.valid) {
    logger.warn("slskd", "slskd download validation failed", {
      jobId: job.id,
      artistName: job.artistName,
      trackName: job.trackName,
      candidateIndex,
      preDownloadValid: candidate?.preDownloadValid === true,
      expectedDurationMs: buildResolvedTrack(job, payload.track).durationMs,
      actualDurationMs: validation.actualDurationMs ?? null,
      reason: validation.reason,
      remoteFile,
      sourcePath,
    });
    if (
      blockPipelineJobForReview({
        downloadTracker,
        job,
        validation,
        sourcePath,
      })
    ) {
      recordPayloadOutcome(
        job,
        payload,
        "blocked",
        validation.reason || "Blocked for review",
        { transfer, sourcePath, validation },
      );
      return null;
    }
    recordPayloadOutcome(
      job,
      payload,
      "validation_failed",
      validation.reason || "Download validation failed",
      { transfer, sourcePath, validation },
    );
    await cleanupRejectedDownload({
      sourcePath,
      slskdRoot,
      playlistRoot,
      transfer,
      username: candidate?.raw?.user,
    });
    const nextPayload = hasNextCandidate(payload)
      ? buildNextCandidatePayload(payload, { batchId: null, legacyTransfer: null })
      : null;    if (nextPayload) return nextPayload;
    return failOrTryNextSource(payload, job, validation.reason || "Download validation failed");
  }
  await writeAudioMetadata(sourcePath, resolvedTrack);
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
    .catch((err) => { logger.warn("slskd", "Failed to record track job moving", { jobId: job.id, error: err?.message || String(err) }); });
  const committedFinalPath = await commitImportToPlaylistLibrary(
    sourcePath,
    finalPath,
  );  if (slskdRoot) {
    await cleanupEmptyAncestors(path.dirname(sourcePath), slskdRoot).catch(() => {});
  }
  recordPayloadOutcome(job, payload, "success", null, {
    transfer,
    sourcePath,
    finalPath: committedFinalPath,
    validation,
  });
  return finalizePipelineJobSuccess({
    downloadTracker,
    job,
    committedFinalPath,
    album: candidate?.resolvedAlbumName || job.albumName,
    quality: validation.quality,
    onSuccess: () => cleanupSuccessfulRunArtifacts(payload, transfer),
  });
}

export async function processPipelinePayload(payload) {
  if (!payload || !payload.phase || !payload.jobId) {
    throw new Error("Invalid pipeline payload");
  }
  if (!isAnyDownloadSourceConfigured()) {
    const job = downloadTracker.getJob(payload.jobId);
    if (job) {
      await failJob(job, getDownloadSourceNotConfiguredMessage());
    }
    return null;
  }
  if (!payload.source) {
    const nextPayload = buildNextSourcePayload(payload, null, null);
    if (!nextPayload) {
      const job = downloadTracker.getJob(payload.jobId);
      if (job) await failJob(job, getDownloadSourceNotConfiguredMessage());
      return null;
    }
    return processPipelinePayload(nextPayload);
  }
  if (payload.source === "usenet") {
    if (!isSourceConfigured("usenet")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "Usenet is not configured") : null;
    }
    return processUsenetPipelinePayload(payload, { failOrTryNextSource });
  }
  if (payload.source === "ytdlp") {
    if (!isSourceConfigured("ytdlp")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "yt-dlp is not configured") : null;
    }
    return processYtdlpPipelinePayload(payload, { failOrTryNextSource });
  }
  if (payload.source !== "slskd") {
    const job = downloadTracker.getJob(payload.jobId);
    return job
      ? failOrTryNextSource(payload, job, `Unknown download source: ${payload.source}`)
      : null;
  }
  if (!slskdClient.isConfigured() || !isSourceConfigured("slskd")) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? failOrTryNextSource(payload, job, SLSKD_NOT_CONFIGURED_MESSAGE) : null;
  }
  switch (payload.phase) {
    case "search":
      return handleSearch(payload);
    case "download":
      return handleDownload(payload);
    case "poll":
      return handlePoll(payload);
    case "finalize":
      return handleFinalize(payload);
    default:
      throw new Error(`Unknown pipeline phase: ${payload.phase}`);
  }
}

export async function continuePipeline(payload) {
  if (!payload) return;
  if (payload.delaySeconds) {
    enqueuePipelineJob(payload, {
      delaySeconds: Number(payload.delaySeconds),
    });
    return;
  }
  enqueuePipelineJob(payload, {});
}
