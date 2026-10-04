import path from "path";
import fs from "fs/promises";
import { db } from "../config/db-sqlite.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import {
  buildAlbumSearchTiers,
  buildTrackSearchTiers,
  selectRankedMatchAttempts,
} from "./downloadJobs/trackSearchQueries.js";
import {
  buildSourceCandidates,
  buildSoulseekCandidates,
  prefilterCandidates,
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "./trackMatching/index.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildSlskdRankingHistoryOptions,
  recordSlskdTransferOutcome,
} from "./slskdTransferHistory.js";
import {
  albumGrabJobs,
  continueAlbumGrab,
  deniedAlbumSources,
  finishAlbumGrab,
} from "./albumGrab.js";
import { selectSoulseekAlbumFolder } from "./albumReleaseSearch.js";
import { isCompilationJobs, loadAlbumReleases } from "./albumReleases.js";
import {
  buildResolvedJobTrack as buildResolvedTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeAudioMetadata,
} from "./downloadUtils.js";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  blockPipelineJobForReview,
  finalizePipelineJobSuccess,
  SEARCH_RESET,
} from "./pipelineHelpers.js";
import {
  clearDownloadProviderWork,
  isPipelinePayloadActive,
  registerDownloadProviderWork,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.js";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.js";
import {
  cacheSearchResults,
  getCachedSearchResults,
} from "./downloadJobs/searchResultCache.js";
import createCache from "./apiClients/simpleCache.js";

import { getQualityProfile } from "./qualityProfileService.js";
import {
  getAdvertisedQualityRank,
  getQualityTier,
  orderAdvertisedQualityCandidates,
} from "./qualityProfileModel.js";

const slskdClient = getDownloadClient("slskd");

const updateSlskdMetaStmt = db.prepare(`
  UPDATE playlist_download_jobs
  SET slskd_search_id = COALESCE(?, slskd_search_id),
      slskd_batch_id = COALESCE(?, slskd_batch_id),
      remote_username = COALESCE(?, remote_username),
      remote_filename = COALESCE(?, remote_filename)
  WHERE id = ?
`);

const TRANSFER_RESET = Object.freeze({
  batchId: null,
  legacyTransfer: null,
  lastProgress: null,
  lastProgressAt: null,
  tailSince: null,
});
const ALBUM_TRANSFER_RESET = Object.freeze({ ...TRANSFER_RESET, albumTransfers: null });
const STALLED_TRANSFER_MS = 30 * 60 * 1000;
const QUEUED_ALBUM_TRANSFER_MS = 10 * 60 * 1000;
const TAIL_ALBUM_TRANSFER_MS = 20 * 60 * 1000;
const searchMonitors = createCache(10 * 60, 100);
const MIN_SEARCH_CANDIDATES = 3;
const MAX_DOWNLOAD_CANDIDATES = 7;
const MAX_TRANSFER_RETRIES_PER_CANDIDATE = 1;
const POLL_DELAY_SECONDS = 3;
export const SLSKD_NOT_CONFIGURED_MESSAGE =
  "slskd is not configured. Enable slskd and add its Server URL in Settings > Download clients to enable Soulseek downloads for flows and playlists.";

export function buildSlskdSearchTierGroups(resolvedTrack) {
  return buildTrackSearchTiers(resolvedTrack);
}

function isDeniedSoulseekFile(raw, deniedSourceKeys) {
  const user = String(raw?.user || "").trim().toLowerCase();
  const file = String(raw?.file || "").trim().toLowerCase();
  return deniedSourceKeys?.has(`${user}\0${file}`) === true;
}

function selectAlbumFolders(aggregated, searchOptions) {
  return selectSoulseekAlbumFolder(aggregated.filter((raw) =>
    !isDeniedSoulseekFile(raw, searchOptions.deniedSourceKeys)
    && !searchOptions.isUserBlacklisted?.(raw.user)), searchOptions.albumJobs, {
    releases: searchOptions.albumReleases || [],
    profile: searchOptions.qualityProfile || getQualityProfile(),
  });
}

export function hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions) {
  if (searchOptions?.albumJobs) {
    return selectAlbumFolders(aggregated, searchOptions).decision === "selectable";
  }
  // Node-only pre-filter: no matcher process is spawned during searches.
  // Soulseek folder plausibility is source evidence, not a fuzzy identity
  // score; use it here so an early exit cannot be triggered by unrelated
  // same-format files before the shared title and artist matcher runs.
  const built = buildSoulseekCandidates(aggregated, resolvedTrack, searchOptions);
  const prefiltered = prefilterCandidates({
    request: resolvedTrack,
    source: "soulseek",
    candidates: built.candidates,
  })
    .filter((entry, index) => !entry.rejected && built.providerEvidence[index]?.folder?.plausible
      && !isDeniedSoulseekFile(entry.candidate.raw, searchOptions?.deniedSourceKeys))
    .map((entry) => entry.candidate);
  const eligible = orderAdvertisedQualityCandidates(prefiltered, {
    profile: searchOptions?.qualityProfile || getQualityProfile(),
    currentTier: searchOptions?.currentTier || null,
    upgrade: searchOptions?.upgrade === true,
    readName: (entry) => entry?.raw?.file,
    readBitrate: (entry) => entry?.raw?.bitrate ?? entry?.raw?.bitRate,
  });
  return eligible.length >= MIN_SEARCH_CANDIDATES;
}


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
    normalized.includes("timeout") ||
    normalized.includes("timedout")
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
    ...TRANSFER_RESET,
    phase: "download",
    candidate: null,
    pollAttempts: 0,
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
    return depth > 0 || matches !== null ? collected : null;
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
    if (typeof found === "string" && found) return found;
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

function clearTrackedSearches(searchIds = []) {
  const ids = Array.isArray(searchIds) ? searchIds : [];
  for (const searchId of new Set(ids.map((entry) => String(entry || "").trim()).filter(Boolean))) {
    clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
  }
}

async function cleanupSuccessfulRunArtifacts(payload, transfer) {
  if (!slskdClient.isCleanupAfterRunsEnabled()) return;
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
  try {
    const result = await slskdClient.cleanupAfterRun({ searchIds, transfers });
    clearTrackedSearches(result?.cleanedSearchIds);
  } catch (error) {
    logger.warn("slskd", "Failed to clean up successful slskd run", {
      error: error?.message || String(error),
      searchIds,
      transferCount: transfers.length,
    });
  }
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
  if (payload?.manualSelection === true) return false;
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
    return buildNextCandidatePayload(payload, TRANSFER_RESET);
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

function trackSearchWork(payload) {
  return {
    onSearchCreated: (id) => registerDownloadProviderWork({
      jobId: payload.jobId, playlistId: payload.playlistId,
      provider: "slskd-search", workId: id,
    }),
    onSearchSettled: (id) => clearDownloadProviderWork({ provider: "slskd-search", workId: id }),
  };
}

function searchMonitorFor(payload, activeSearch) {
  let monitor = searchMonitors.get(activeSearch.id);
  if (!monitor) {
    monitor = slskdClient.monitorSearch(activeSearch.id, {
      startedAt: activeSearch.startedAt,
      onSearchSettled: trackSearchWork(payload).onSearchSettled,
    });
    searchMonitors.set(activeSearch.id, monitor);
  }
  return monitor;
}

async function stopSearch(searchId) {
  const deleted = await slskdClient.deleteSearch(searchId, { timeout: 20000 }).catch(() => false);
  if (deleted) clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
}

const searchResultKey = (result) => `${result.user}\0${result.file}`;

// One step of a search: either one poll of the running slskd search, or the
// start of the next query. Results of finished queries live in the shared
// search cache, so a restart only repeats the queries it lost.
async function advanceSlskdSearch(payload, job, queries, resolvedTrack, searchOptions) {
  const aggregated = [];
  const seen = new Set();
  let index = Number(payload.searchQueryIndex || 0);
  for (let queryIndex = 0; queryIndex < index; queryIndex += 1) {
    const cached = getCachedSearchResults("slskd", queries[queryIndex]);
    if (!cached) {
      index = queryIndex;
      break;
    }
    mergeSearchResults(aggregated, seen, cached, searchResultKey);
  }
  const isCancelled = () => !isPipelinePayloadActive(payload);
  const enough = (results) => hasSlskdSearchCandidates(results, resolvedTrack, searchOptions);
  const activeSearch = payload.activeSearch?.query === queries[index] ? payload.activeSearch : null;
  if (payload.activeSearch && !activeSearch) await stopSearch(payload.activeSearch.id);
  if (activeSearch) {
    let result;
    try {
      result = await searchMonitorFor(payload, activeSearch).poll({
        shouldCancel: isCancelled,
        earlyExitWhen: (data) =>
          enough(probeAggregatedResults(aggregated, slskdClient.flattenSearchResults(data), seen)),
      });
    } catch (error) {
      logger.warn("slskd", "slskd search poll failed; moving to the next query", {
        jobId: payload.jobId,
        searchId: activeSearch.id,
        reason: safeLogDiagnostic(error),
      });
      result = { done: true, data: null };
    }
    if (isCancelled()) return { cancelled: true };
    if (!result.done) {
      return { payload: { ...payload, searchQueryIndex: index,
        delaySeconds: Math.max(1, Math.ceil(result.waitMs / 1000)) } };
    }
    searchMonitors.delete(activeSearch.id);
    const results = slskdClient.flattenSearchResults(result.data);
    cacheSearchResults("slskd", activeSearch.query, results);
    mergeSearchResults(aggregated, seen, results, searchResultKey);
    index += 1;
  }
  const searchIds = [...(payload.searchIds || [])];
  while (index < queries.length && !enough(aggregated)) {
    const cached = getCachedSearchResults("slskd", queries[index]);
    if (cached) {
      mergeSearchResults(aggregated, seen, cached, searchResultKey);
      index += 1;
      continue;
    }
    const created = await slskdClient.createSearch(queries[index], {
      shouldCancel: isCancelled,
      ...trackSearchWork(payload),
    });
    searchIds.push(created.id);
    if (!job.slskdSearchId) {
      updateSlskdMetaStmt.run(created.id, null, null, null, job.id);
      job.slskdSearchId = created.id;
    }
    if (isCancelled()) {
      await stopSearch(created.id);
      return { cancelled: true };
    }
    return { payload: {
      ...payload,
      searchQueryIndex: index,
      searchIds,
      searchId: payload.searchId || created.id,
      activeSearch: { id: created.id, query: queries[index], startedAt: Date.now() },
      delaySeconds: 1,
    } };
  }
  return { aggregated, searchIds, queryCount: index };
}

async function handleSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (!payload.searchQueries) {
    downloadTracker.setDownloading(job.id);
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: "slskd",
    });
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
      .catch((err) => { logger.warn("slskd", "Failed to record track job searching", { jobId: job.id, error: err?.message || String(err) }); });
  }
  const resolvedTrack = buildResolvedTrack(job, payload.track);
  const albumJobs = payload.albumGrab === true ? albumGrabJobs(payload) : null;
  const queries = payload.searchQueries || (albumJobs
    ? buildAlbumSearchTiers({ ...resolvedTrack, compilation: isCompilationJobs(albumJobs) })
    : buildSlskdSearchTierGroups(resolvedTrack)).flatMap((tier) => tier.queries);
  const currentTier = payload.upgradeForJobId
    ? downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier
    : null;
  const deniedSources = Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [];
  const deniedSourceKeys = albumJobs
    ? deniedAlbumSources([job, ...albumJobs], "slskd")
    : new Set(deniedSources
      .filter((entry) => Array.isArray(entry) && entry[0] === "slskd")
      .map((entry) => String(entry[1] || "").trim().toLowerCase()));
  const searchOptions = {
    deniedSourceKeys,
    ...(await getWorkerSearchOptions()),
    qualityProfile: getQualityProfile(),
    currentTier,
    upgrade: payload.upgrade === true,
    albumJobs,
    albumReleases: albumJobs ? await loadAlbumReleases(job.albumMbid) : [],
  };
  const step = await advanceSlskdSearch(
    { ...payload, searchQueries: queries },
    job,
    queries,
    resolvedTrack,
    searchOptions,
  );
  if (step.cancelled || !isPipelinePayloadActive(payload)) return null;
  if (step.payload) return step.payload;
  const { aggregated, searchIds, queryCount } = step;
  const searchId = payload.searchId || searchIds[0] || null;
  if (albumJobs) {
    const selection = selectAlbumFolders(aggregated, searchOptions);
    if (selection.decision !== "selectable") {
      return helpers.failOrTryNextSource(payload, job, "No selectable Soulseek album folder");
    }
    return {
      ...payload, ...SEARCH_RESET, phase: "download", source: "slskd", searchId,
      searchIds: [...new Set(searchIds)], candidateIndex: 0,
      candidates: selection.candidates.map((candidate) => ({
        raw: { user: candidate.group.user, files: candidate.files },
        resolvedAlbumName: job.albumName,
        score: candidate.fit,
      })),
      policyVersion: selection.policyVersion,
    };
  }
  const rankingOptions = { ...searchOptions };
  const historyOptions = buildSlskdRankingHistoryOptions();
  const evaluation = await buildSourceCandidates({
    source: "soulseek",
    results: aggregated,
    request: resolvedTrack,
    options: {
      ...rankingOptions,
      isUserBlacklisted: historyOptions.isUserBlacklisted,
      getUserQueuePenalty: historyOptions.getUserQueuePenalty,
    },
  });
  // Quality profile preference is primary here. Preserve the matcher decision
  // and distance order within each quality tier; queue history only breaks a
  // true identity tie and must never move review candidates ahead of accepts.
  const qualityOrdered = orderAdvertisedQualityCandidates(usableEvaluationEntries(evaluation), {
    profile: getQualityProfile(),
    currentTier,
    upgrade: payload.upgrade === true,
    readName: (entry) => entry.candidate?.raw?.file,
    readBitrate: (entry) => entry.candidate?.raw?.bitrate ?? entry.candidate?.raw?.bitRate,
  });
  const profile = getQualityProfile();
  const ordered = qualityOrdered
    .map((entry, index) => ({
      entry,
      originalOrder: index,
      tierRank: getAdvertisedQualityRank(
        entry.candidate?.raw?.file,
        entry.candidate?.raw?.bitrate ?? entry.candidate?.raw?.bitRate,
        profile,
      ),
      decisionRank: { accept: 0, verify: 1, review: 2 }[entry.decision] ?? 3,
      distance: Number.isFinite(entry.distance) ? entry.distance : Number.POSITIVE_INFINITY,
      variantScore: Number(entry.variantScore || 0),
      queuePenalty: Number(historyOptions.getUserQueuePenalty?.(entry.candidate?.raw?.user) || 0),
    }))
    .sort(
      (left, right) =>
        left.tierRank - right.tierRank ||
        left.decisionRank - right.decisionRank ||
        left.distance - right.distance ||
        right.variantScore - left.variantScore ||
        left.queuePenalty - right.queuePenalty ||
        left.originalOrder - right.originalOrder,
    )
    .map(({ entry }) => entry);
  const filteredPool = deniedSourceKeys.size > 0
    ? ordered.filter((entry) => !isDeniedSoulseekFile(entry.candidate.raw, deniedSourceKeys))
    : ordered;
  const candidates = selectRankedMatchAttempts(
    filteredPool.map(toPipelineCandidate),
    MAX_DOWNLOAD_CANDIDATES,
  );
  if (candidates.length === 0) {
    logger.warn("slskd", "No slskd download candidates after search", {
      jobId: job.id,
      artistName: job.artistName,
      trackName: job.trackName,
      queryCount,
      rawResultCount: aggregated.length,
      rankedCount: evaluation.evaluations.length,
      eligibleCount: ordered.length,
    });
    return helpers.failOrTryNextSource(payload, job, "No suitable slskd search results", {
      queryCount,
      rawResultCount: aggregated.length,
      rankedCount: evaluation.evaluations.length,
      eligibleCount: ordered.length,
    });
  }
  return {
    ...payload,
    ...SEARCH_RESET,
    phase: "download",
    searchId,
    searchIds: [...new Set(searchIds)],
    candidates,
    candidateIndex: 0,
    candidateRetryCounts: {},
  };
}

async function handleDownload(payload, helpers) {
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
  if (payload.albumGrab === true) {
    const activeJobIds = new Set(albumGrabJobs(payload).map((entry) => entry.id));
    const files = (candidate?.raw?.files || [])
      .filter((file) => !file.jobId || activeJobIds.has(file.jobId));
    if (!candidate?.raw?.user || files.length === 0) {
      return continueAlbumGrab(payload, ALBUM_TRANSFER_RESET)
        || helpers.failOrTryNextSource(payload, job, "No Soulseek album files available");
    }
    let submission;
    try {
      submission = await withPipelineCommitLock(payload, async () => {
        const result = await slskdClient.enqueueBatch({
          username: candidate.raw.user,
          files: files.map((file) => ({ filename: file.file, size: Number(file.size || 0) })),
        });
        const transfers = Array.isArray(result.transfers) ? result.transfers : [];
        if (transfers.length !== files.length || transfers.some((transfer) => !readTransferId(transfer))) {
          for (const transfer of transfers) {
            const id = readTransferId(transfer);
            if (id) await slskdClient.deleteTransfer(candidate.raw.user, id, { remove: true }).catch(() => {});
          }
          throw new Error("slskd did not return a transfer ID for every album file");
        }
        downloadTracker.updateDownloadMetadata(job.id, {
          downloadSource: "slskd", downloadClient: "slskd",
          downloadClientId: readTransferId(transfers[0]),
          remoteUsername: candidate.raw.user,
          remoteFilename: files[0].file,
        });
        return transfers;
      });
    } catch (error) {
      return continueAlbumGrab(payload, ALBUM_TRANSFER_RESET)
        || helpers.failOrTryNextSource(payload, job, safeLogDiagnostic(error));
    }
    if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
    return { ...payload, phase: "poll", candidate: { ...candidate, raw: { ...candidate.raw, files } },
      albumTransfers: submission.result, pollAttempts: 0 };
  }
  if (!candidate?.raw?.user || !candidate?.raw?.file) {
    return helpers.failOrTryNextSource(payload, job, "No download candidate available");
  }
  const searchId = payload.searchId || null;
  updateSlskdMetaStmt.run(searchId, null, candidate.raw.user, candidate.raw.file, job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "slskd",
    downloadClient: "slskd",
    remoteUsername: candidate.raw.user,
    remoteFilename: candidate.raw.file,
  });
  let submission;
  try {
    submission = await withPipelineCommitLock(payload, async () => {
      const result = await slskdClient.enqueueBatch({
        username: candidate.raw.user,
        files: [
          {
            filename: candidate.raw.file,
            size: Number(candidate.raw.size || 0),
          },
        ],
      });
      const transfer = result?.transfers?.[0] || null;
      const transferId = readTransferId(transfer) || String(result?.transferId || "").trim();
      const transferUsername = String(result?.username || transfer?.username || candidate.raw.user).trim();
      if (transferId) {
        downloadTracker.updateDownloadMetadata(job.id, {
          downloadClient: "slskd",
          downloadClientId: transferId,
          remoteUsername: transferUsername,
        });
      }
      return { transferId, username: transferUsername };
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
    return helpers.failOrTryNextSource(payload, job, message);
  }
  if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
  const result = submission.result;
  const eventOffset =
    payload.eventOffset != null ? payload.eventOffset : await readCurrentEventOffset();
  return {
    ...payload,
    phase: "poll",
    legacyTransfer: result.transferId ? { id: result.transferId, username: result.username } : null,
    candidate,
    candidateIndex: index,
    eventOffset,
    pollAttempts: 0,
  };
}

function readTransferProgress(transfer) {
  if (!transfer) return "missing";
  return [
    readTransferState(transfer),
    transfer.bytesTransferred ?? transfer.BytesTransferred ?? "",
    transfer.placeInQueue ?? transfer.PlaceInQueue ?? "",
  ].join("|");
}

// A transfer times out only when nothing about it changes for a while, so a
// slow upload or a moving remote queue keeps going.
function trackTransferProgress(payload, progress, now = Date.now()) {
  const changed = progress !== payload.lastProgress;
  const lastProgressAt = changed || !Number(payload.lastProgressAt)
    ? now : Number(payload.lastProgressAt);
  return {
    lastProgress: progress,
    lastProgressAt,
    stalled: now - lastProgressAt > STALLED_TRANSFER_MS,
  };
}

// Once every other file of the album finished or failed, the rest get a
// limited window: files still in the uploader's queue 10 minutes, a file
// still transferring 20. Then the album imports what finished and moves on.
function albumTailWindow(transfers) {
  const queued = (transfer) => /queued/i.test(readTransferState(transfer))
    && !Number(transfer.bytesTransferred ?? transfer.BytesTransferred);
  const pending = transfers.filter((transfer) => !transfer
    || classifyTransferState(readTransferState(transfer)) === "pending");
  if (pending.length === 0 || pending.length === transfers.length || pending.some((transfer) => !transfer)) {
    return null;
  }
  return pending.every(queued) ? QUEUED_ALBUM_TRANSFER_MS : TAIL_ALBUM_TRANSFER_MS;
}

async function handlePoll(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  if (payload.albumGrab === true) {
    const username = payload.candidate?.raw?.user;
    const transfers = await Promise.all((payload.albumTransfers || []).map(async (transfer) =>
      slskdClient.getTransfer(username, readTransferId(transfer)).catch(() => null)));
    if (!transfers.some((transfer) => !transfer || classifyTransferState(readTransferState(transfer)) === "pending")) {
      return { ...payload, phase: "finalize", pollAttempts, albumTransfers: transfers };
    }
    const progress = trackTransferProgress(payload, transfers.map(readTransferProgress).join(","));
    const tailWindow = albumTailWindow(transfers);
    const tailSince = tailWindow ? Number(payload.tailSince) || Date.now() : null;
    if (!progress.stalled && !(tailSince && Date.now() - tailSince > tailWindow)) {
      return { ...payload, phase: "poll", pollAttempts, delaySeconds: POLL_DELAY_SECONDS,
        lastProgress: progress.lastProgress, lastProgressAt: progress.lastProgressAt, tailSince };
    }
    // Keep the files that finished. The album attempt continues for the rest.
    const settled = transfers.map((transfer, index) => transfer || payload.albumTransfers[index]);
    for (const transfer of settled) {
      if (classifyTransferState(readTransferState(transfer)) !== "pending") continue;
      const id = readTransferId(transfer);
      if (id) await slskdClient.deleteTransfer(username, id, { remove: true })
        .catch((error) => logger.warn("slskd", "Stalled album transfer cleanup failed", {
          jobId: job.id, transferId: id, reason: safeLogDiagnostic(error),
        }));
    }
    return { ...payload, phase: "finalize", pollAttempts, albumTransfers: settled };
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
  let transfer = null;
  if (payload.legacyTransfer?.id && payload.legacyTransfer?.username) {
    transfer = await slskdClient.getTransfer(
      payload.legacyTransfer.username,
      payload.legacyTransfer.id,
    );
    const state = transfer ? classifyTransferState(readTransferState(transfer)) : "pending";
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
      return helpers.failOrTryNextSource(basePayload, job, "slskd transfer failed");
    }
    if (state === "success") {
      const candidate = getPayloadCandidate(basePayload);
      return {
        ...basePayload,
        phase: "finalize",
        batch: { transfers: [transfer] },
        pollAttempts,
        candidate,
      };
    }
  }
  const progress = trackTransferProgress(basePayload, readTransferProgress(transfer));
  if (!progress.stalled) {
    return {
      ...basePayload,
      phase: "poll",
      delaySeconds: POLL_DELAY_SECONDS,
      pollAttempts,
      lastProgress: progress.lastProgress,
      lastProgressAt: progress.lastProgressAt,
    };
  }
  if (transfer) await cleanupTransferForPayload(basePayload, transfer);
  else if (payload.legacyTransfer?.id) {
    await slskdClient.deleteTransfer(payload.legacyTransfer.username, payload.legacyTransfer.id,
      { remove: true }).catch(() => false);
  }
  recordPayloadOutcome(job, basePayload, "transfer_timeout", "slskd transfer stalled", { transfer });
  if (hasNextCandidate(basePayload)) {
    return buildNextCandidatePayload(basePayload, TRANSFER_RESET);
  }
  return helpers.failOrTryNextSource(basePayload, job, "slskd transfer stalled");
}

async function handleFinalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (payload.albumGrab === true) {
    const slskdRoot = resolveLocalPath(
      await slskdClient.getDownloadDirectory(), getPathMappings("slskd"));
    const playlistRoot = resolveDownloadRoot();
    const remoteFiles = payload.candidate?.raw?.files || [];
    const paths = [];
    for (const [index, transfer] of (payload.albumTransfers || []).entries()) {
      if (classifyTransferState(readTransferState(transfer)) !== "success") continue;
      const remote = remoteFiles[index];
      const local = await locateCompletedDownload(slskdRoot, playlistRoot, remote?.file, {
        expectedSizeBytes: Number(remote?.size || 0), transfer,
      });
      if (local) paths.push(local);
    }
    const next = await finishAlbumGrab(payload, {
      filePaths: paths, source: "soulseek", album: job.albumName,
      resetFields: ALBUM_TRANSFER_RESET,
    });
    if (slskdClient.isCleanupAfterRunsEnabled()) {
      const transfers = (payload.albumTransfers || []).map((transfer) => ({
        username: payload.candidate?.raw?.user,
        transferId: readTransferId(transfer),
      })).filter((entry) => entry.username && entry.transferId);
      await slskdClient.cleanupAfterRun({ searchIds: getPayloadSearchIds(payload), transfers })
        .catch((error) => logger.warn("slskd", "Album transfer cleanup failed", {
          jobId: job.id, reason: safeLogDiagnostic(error),
        }));
    }
    return next;
  }
  const playlistRoot = resolveDownloadRoot();
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
  if (typeof sourcePath !== "string" || !sourcePath.trim()) {
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
    return helpers.failOrTryNextSource(payload, job, `Downloaded file missing: ${expectedPath}`);
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const finalPath = path.join(finalDir, finalName);
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const validation = await validateDownloadedTrackFile({
    request: resolvedTrack,
    candidate: candidate?.candidate || candidate,
    filePath: sourcePath,
    source: "soulseek",
    options: {
      strict: candidate?.evaluation?.decision !== "accept",
      manualSelection: payload.manualSelection === true,
    },
  });
  if (!isPipelinePayloadActive(payload)) {
    await cleanupRejectedDownload({
      sourcePath,
      slskdRoot,
      playlistRoot,
      transfer,
      username: candidate?.raw?.user,
    });
    return null;
  }
  if (!validation.valid) {
    logger.warn("slskd", "slskd download validation failed", {
      jobId: job.id,
      artistName: job.artistName,
      trackName: job.trackName,
      candidateIndex,
      decision: candidate?.evaluation?.decision || null,
      expectedDurationMs: buildResolvedTrack(job, payload.track).durationMs,
      actualDurationMs: validation.actualDurationMs ?? null,
      reason: validation.reason,
      remoteFile,
      sourcePath,
    });
    if (validation.blocked && !payload.heldForReview && hasNextCandidate(payload)) {
      recordPayloadOutcome(job, payload, "held_for_review", validation.reason || "Held for review",
        { transfer, sourcePath, validation });
      return buildNextCandidatePayload({
        ...payload,
        heldForReview: {
          sourcePath,
          reason: validation.reason || "Blocked for review",
          username: candidate?.raw?.user || null,
          transferId: readTransferId(transfer) || null,
        },
      }, TRANSFER_RESET);
    }
    if (
      !payload.heldForReview &&
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
    downloadTracker.recordDeniedSource(job.id, "slskd", `${candidate?.raw?.user}\0${remoteFile}`);
    await cleanupRejectedDownload({
      sourcePath,
      slskdRoot,
      playlistRoot,
      transfer,
      username: candidate?.raw?.user,
    });
    const nextPayload = hasNextCandidate(payload)
      ? buildNextCandidatePayload(payload, TRANSFER_RESET)
      : null;    if (nextPayload) return nextPayload;
    return helpers.failOrTryNextSource(payload, job, validation.reason || "Download validation failed");
  }
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const committed = await withPipelineCommitLock(payload, async () => {
    await writeAudioMetadata(sourcePath, resolvedTrack);
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => { logger.warn("slskd", "Failed to record track job moving", { jobId: job.id, error: err?.message || String(err) }); });
    const committedFinalPath = await commitDownloadedFile(
      sourcePath,
      finalPath,
    );
    if (slskdRoot) {
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
  });
  if (committed.cancelled) {
    await cleanupRejectedDownload({
      sourcePath,
      slskdRoot,
      playlistRoot,
      transfer,
      username: candidate?.raw?.user,
    });
    return null;
  }
  return committed.result;
}

// A file that needs review waits while the remaining candidates are tried.
// It goes to review only when none of them verifies, and is removed when
// another file is imported or the job ends.
async function parkHeldForReview(payload, job) {
  const held = payload.heldForReview;
  if (!job || !(await fs.stat(held.sourcePath).catch(() => null))?.isFile()) return false;
  const parked = blockPipelineJobForReview({
    downloadTracker,
    job,
    validation: { blocked: true, reason: held.reason },
    sourcePath: held.sourcePath,
  });
  if (parked) recordPayloadOutcome(job, payload, "blocked", held.reason, { sourcePath: held.sourcePath });
  return parked;
}

async function discardHeldForReview(held) {
  await cleanupRejectedDownload({
    sourcePath: held.sourcePath,
    slskdRoot: resolveLocalPath(await slskdClient.getDownloadDirectory(), getPathMappings("slskd")),
    playlistRoot: resolveDownloadRoot(),
    transfer: held.transferId ? { id: held.transferId } : null,
    username: held.username,
  });
}

export async function processSlskdPipelinePayload(payload, helpers) {
  const held = payload.heldForReview;
  if (!held?.sourcePath) return processSlskdPhase(payload, helpers);
  const result = await processSlskdPhase(payload, {
    ...helpers,
    failOrTryNextSource: async (failed, job, ...rest) => ((await parkHeldForReview(failed, job))
      ? null
      : helpers.failOrTryNextSource(failed, job, ...rest)),
  });
  if (result == null && downloadTracker.getJob(payload.jobId)?.status !== "blocked") {
    await discardHeldForReview(held);
  }
  return result;
}

function processSlskdPhase(payload, helpers) {
  switch (payload.phase) {
    case "search":
      return handleSearch(payload, helpers);
    case "download":
      return handleDownload(payload, helpers);
    case "poll":
      return handlePoll(payload, helpers);
    case "finalize":
      return handleFinalize(payload, helpers);
    default:
      throw new Error(`Unknown pipeline phase: ${payload.phase}`);
  }
}
