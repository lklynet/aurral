import path from "path";
import fs from "fs/promises";
import { db } from "../config/db-sqlite.js";
import { slskdClient } from "./slskdClient.js";
import { logger } from "./logger.js";
import { enqueuePipelineJob } from "./honkerDb.js";
import { downloadTracker } from "./playlistDownloadTracker.js";
import {
  buildFlowSearchTiers,
  rankFlowSearchResults,
  selectRankedMatchAttempts,
  validateDownloadedTrack,
} from "./weeklyFlowSoulseekMatcher.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { resolveLocalPath } from "./pathMappings.js";
import {
  buildSlskdRankingHistoryOptions,
  recordSlskdTransferOutcome,
} from "./slskdTransferHistory.js";

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

export function buildSlskdSearchTierGroups(resolvedTrack) {
  return buildFlowSearchTiers(resolvedTrack);
}

export function hasSlskdSearchCandidates(
  aggregated,
  resolvedTrack,
  searchOptions,
) {
  return (
    countPreDownloadValidCandidates(aggregated, resolvedTrack, searchOptions) >=
    MIN_SEARCH_CANDIDATES
  );
}

export function shouldStopSlskdSearching(
  aggregated,
  resolvedTrack,
  searchOptions,
) {
  return hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions);
}

const MAX_EMPTY_POLL_ATTEMPTS = 60;
const MAX_POLL_ATTEMPTS = 600;

function sanitizePathPart(value, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

function normalizePositiveInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

function normalizeTrackTitles(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function buildResolvedTrack(job, payloadTrack = {}) {
  const track =
    payloadTrack && typeof payloadTrack === "object" ? payloadTrack : {};
  return {
    artistName: job.artistName || track.artistName,
    trackName: job.trackName || track.trackName,
    albumName: job.albumName || track.albumName,
    artistMbid: job.artistMbid || track.artistMbid,
    albumMbid: job.albumMbid || track.albumMbid,
    trackMbid: job.trackMbid || track.trackMbid,
    releaseYear: job.releaseYear || track.releaseYear,
    durationMs: job.durationMs ?? track.durationMs ?? null,
    trackNumber: normalizePositiveInteger(job.trackNumber ?? track.trackNumber),
    albumTrackCount: normalizePositiveInteger(
      job.albumTrackCount ?? track.albumTrackCount,
    ),
    albumTrackTitles: normalizeTrackTitles(
      (job.albumTrackTitles?.length ? job.albumTrackTitles : null) ||
        track.albumTrackTitles,
    ),
    artistAliases:
      Array.isArray(job.artistAliases) && job.artistAliases.length
        ? job.artistAliases
        : normalizeTrackTitles(track.artistAliases),
  };
}

async function getWorkerSearchOptions() {
  const { getSlskdSearchFormatOptions } = await import("./slskdClient.js");
  return {
    ...getSlskdSearchFormatOptions(),
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
    transfer?.id ||
      transfer?.Id ||
      transfer?.transferId ||
      transfer?.TransferId ||
      "",
  ).trim();
}

function getPayloadCandidate(payload) {
  const candidateIndex = Number(payload?.candidateIndex || 0);
  return (
    payload?.candidate ||
    (Array.isArray(payload?.candidates)
      ? payload.candidates[candidateIndex]
      : null)
  );
}

function getPayloadSearchIds(payload) {
  const ids = [];
  if (Array.isArray(payload?.searchIds)) ids.push(...payload.searchIds);
  if (payload?.searchId) ids.push(payload.searchId);
  return [...new Set(ids.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function getCandidateRetryCount(payload, candidateIndex = null) {
  const index =
    candidateIndex == null
      ? Number(payload?.candidateIndex || 0)
      : Number(candidateIndex || 0);
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

function buildNextCandidatePayload(payload) {
  return {
    ...payload,
    phase: "download",
    candidate: null,
    candidateIndex: Number(payload?.candidateIndex || 0) + 1,
    pollAttempts: 0,
    batchId: null,
    legacyTransfer: null,
  };
}

function hasNextCandidate(payload) {
  return (
    Number(payload?.candidateIndex || 0) + 1 <
    (Array.isArray(payload?.candidates) ? payload.candidates.length : 0)
  );
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
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function eventMatchesCandidate(record, candidate) {
  const raw = candidate?.raw || {};
  const expectedUser = String(raw.user || "").trim().toLowerCase();
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
  const nextOffset = Math.max(
    offset + events.length,
    Number(result?.totalCount || 0),
  );
  let completionTransfer = null;
  for (const event of events) {
    const type = String(event?.type || event?.Type || "");
    if (
      !type.includes("DownloadFileComplete") &&
      !type.includes("DownloadDirectoryComplete")
    ) {
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
  if (!slskdClient.isConfigured()) return 0;
  let count = 0;
  for (const job of downloadTracker.getByStatus("pending")) {
    if (job.slskdBatchId || job.slskdSearchId) {
      downloadTracker.clearSlskdPipelineState(job.id);
    }
    if (enqueueJobPipeline(job.id)) count += 1;
  }
  return count;
}

async function failJob(job, message) {
  downloadTracker.setFailed(job.id, message);
  try {
    const { recordTrackJobFailed } = await import("./aurralHistoryService.js");
    recordTrackJobFailed(job, message);
  } catch {}
  try {
    const { weeklyFlowWorker } = await import("./weeklyFlowWorker.js");
    weeklyFlowWorker.wake(0);
    await weeklyFlowWorker.checkPlaylistComplete(
      job.playlistId || job.playlistType,
    );
  } catch (error) {
    logger.slskd("warn", "Failed to run post-failure playlist checks", {
      jobId: job.id,
      error: error?.message || String(error),
    });
  }
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

function joinUnderRoot(root, relativePath, fileName = null) {
  const parts = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (fileName) {
    parts.push(fileName);
  }
  return path.join(root, ...parts);
}

export function parseSlskdRemoteFile(remoteFile) {
  const normalized = String(remoteFile || "").replace(/\\/g, "/").trim();
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
    transfer?.filename ||
      transfer?.Filename ||
      transfer?.file ||
      transfer?.File ||
      "",
  ).trim();
}

function resolveTransferLocalPath(transferFilename, slskdRoot) {
  const raw = String(transferFilename || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, path.sep);
  if (path.isAbsolute(normalized)) {
    return path.resolve(resolveLocalPath(normalized));
  }
  const slskdBase = String(slskdRoot || "").trim();
  if (!slskdBase) return null;
  const resolvedBase = path.resolve(slskdBase);
  if (
    normalized === resolvedBase ||
    normalized.startsWith(`${resolvedBase}${path.sep}`)
  ) {
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

async function findFileRecursive(
  dir,
  fileName,
  expectedSizeBytes,
  depth = 0,
  matches = null,
) {
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
      return sizeMatches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
        .path;
    }
    return null;
  }
  if (matches.length === 1) return matches[0].path;
  return matches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0].path;
}

export async function locateCompletedDownload(
  slskdRoot,
  playlistRoot,
  remoteFile,
  options = {},
) {
  const expectedSizeBytes = Number(options.expectedSizeBytes || 0);
  const transferFilename = readTransferFilename(options.transfer);
  const transferPath = resolveTransferLocalPath(transferFilename, slskdRoot);
  if (transferPath) {
    const directTransfer = await statMatchingFile(
      transferPath,
      expectedSizeBytes,
    );
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
    const found = await findFileRecursive(root, parseSlskdRemoteFile(remoteFile).fileName, expectedSizeBytes);
    if (found) return found;
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableTargetPath(targetPath) {
  if (!(await fileExists(targetPath))) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

export async function commitImportToPlaylistLibrary(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }
  const resolvedTarget = await resolveAvailableTargetPath(targetPath);
  try {
    await fs.rename(sourcePath, resolvedTarget);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    const tempTarget = path.join(
      path.dirname(resolvedTarget),
      `.aurral-import-${process.pid}-${Date.now()}-${path.basename(resolvedTarget)}.tmp`,
    );
    await fs.copyFile(sourcePath, tempTarget);
    const [sourceStat, tempStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(tempTarget),
    ]);
    if (sourceStat.size !== tempStat.size) {
      await fs.rm(tempTarget, { force: true }).catch(() => {});
      throw new Error("Imported file copy did not match source size");
    }
    await fs.rename(tempTarget, resolvedTarget);
    await fs.rm(sourcePath, { force: true });
  }
  return resolvedTarget;
}

async function cleanupRejectedDownload({
  sourcePath,
  slskdRoot,
  playlistRoot,
  transfer,
  username,
} = {}) {
  const transferId = readTransferId(transfer);
  const transferUser = String(
    username || transfer?.username || transfer?.Username || "",
  ).trim();
  if (transferUser && transferId) {
    await slskdClient
      .deleteTransfer(transferUser, transferId, { remove: true })
      .catch(() => {});
  }
  const safeSource = String(sourcePath || "").trim();
  const safeSlskdRoot = String(slskdRoot || "").trim();
  const safePlaylistRoot = String(playlistRoot || "").trim();
  if (
    safeSource &&
    safeSlskdRoot &&
    isPathInside(safeSource, safeSlskdRoot) &&
    (!safePlaylistRoot || !isPathInside(safeSource, safePlaylistRoot))
  ) {
    await fs.rm(safeSource, { force: true }).catch(() => {});
    await cleanupEmptyAncestors(path.dirname(safeSource), safeSlskdRoot).catch(
      () => {},
    );
  }
}

async function cleanupTransferForPayload(payload, transfer) {
  const transferId = readTransferId(transfer);
  if (!transferId) return;
  const candidate = getPayloadCandidate(payload);
  const username = String(
    transfer?.username ||
      transfer?.Username ||
      candidate?.raw?.user ||
      "",
  ).trim();
  if (!username) return;
  await slskdClient
    .deleteTransfer(username, transferId, { remove: true })
    .catch(() => {});
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

function countPreDownloadValidCandidates(results, resolvedTrack, searchOptions) {
  const ranked = rankFlowSearchResults(results, resolvedTrack, searchOptions);
  return ranked.filter((entry) => entry.preDownloadValid).length;
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
    return buildNextCandidatePayload(payload);
  }
  return null;
}

function mergeSearchResults(aggregated, seen, results) {
  for (const result of results) {
    const key = `${result.user}\0${result.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    aggregated.push(result);
  }
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
      shouldStopSlskdSearching(
        probeAggregatedResults(
          aggregated,
          slskdClient.flattenSearchResults(data),
          seen,
        ),
        resolvedTrack,
        searchOptions,
      ),
  });
  const results = slskdClient.flattenSearchResults(completed);
  const shouldCancel = shouldStopSlskdSearching(
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
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
    .catch(() => {});
  const resolvedTrack = buildResolvedTrack(job, payload.track);
  const searchTiers = buildSlskdSearchTierGroups(resolvedTrack);
  const searchOptions = await getWorkerSearchOptions();
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
      mergeSearchResults(aggregated, seen, results);
      if (hasSlskdSearchCandidates(aggregated, resolvedTrack, searchOptions)) {
        break;
      }
    }
  }
  if (searchIdRef.value) {
    updateSlskdMetaStmt.run(searchIdRef.value, null, null, null, job.id);
    job.slskdSearchId = searchIdRef.value;
  }
  const ranked = rankFlowSearchResults(
    aggregated,
    resolvedTrack,
    searchOptions,
  );
  const eligible = ranked.filter((entry) => entry.preDownloadValid);
  const eligibleKeys = new Set(
    eligible.map((entry) => `${entry.raw?.user || ""}\0${entry.raw?.file || ""}`),
  );
  const candidatePool = [
    ...eligible,
    ...ranked.filter(
      (entry) => !eligibleKeys.has(`${entry.raw?.user || ""}\0${entry.raw?.file || ""}`),
    ),
  ];
  const candidates = selectRankedMatchAttempts(candidatePool, MAX_DOWNLOAD_CANDIDATES).map((entry) => ({
    raw: entry.raw,
    score: entry.score,
    resolvedAlbumName: entry.resolvedAlbumName,
    preDownloadValid: entry.preDownloadValid === true,
  }));
  if (candidates.length === 0) {
    logger.slskd("warn", "No slskd download candidates after search", {
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
        .catch(() => {});
    }
    await failJob(job, "No suitable slskd search results");
    return null;
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
    .catch(() => {});
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  if (!candidate?.raw?.user || !candidate?.raw?.file) {
    await failJob(job, "No download candidate available");
    return null;
  }
  const searchId = payload.searchId || null;
  updateSlskdMetaStmt.run(
    searchId,
    null,
    candidate.raw.user,
    candidate.raw.file,
    job.id,
  );
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
    recordPayloadOutcome(
      job,
      { ...payload, candidate },
      "enqueue_failed",
      message,
      { candidate },
    );
    logger.slskd("warn", "slskd batch enqueue failed for candidate", {
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
    await failJob(job, message);
    return null;
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
    await failJob(job, "slskd transfer polling timed out");
    return null;
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
      await failJob(job, "slskd transfer failed");
      return null;
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
  const batch = await slskdClient.getBatch(payload.batchId);
  if (!batch) {
    return {
      ...basePayload,
      phase: "poll",
      delaySeconds: POLL_DELAY_SECONDS,
      pollAttempts,
    };
  }
  const transfers = readBatchTransfers(batch);
  if (transfers.length === 0) {
    if (pollAttempts >= 3) {
      logger.slskd("warn", "slskd batch has no transfers; trying next candidate", {
        jobId: job.id,
        batchId: payload.batchId,
        candidateIndex: Number(payload.candidateIndex || 0),
      });
      const nextPayload = retrySameCandidateOrNext(
        basePayload,
        job,
        "batch_empty",
        "slskd batch returned no transfers",
        { batchId: payload.batchId },
      );
      if (nextPayload) return nextPayload;
      await failJob(job, "slskd batch returned no transfers");
      return null;
    }
    if (pollAttempts >= MAX_EMPTY_POLL_ATTEMPTS) {
      recordPayloadOutcome(job, basePayload, "batch_empty", "slskd batch returned no transfers");
      await failJob(job, "slskd batch returned no transfers");
      return null;
    }
    return {
      ...basePayload,
      phase: "poll",
      delaySeconds: POLL_DELAY_SECONDS,
      pollAttempts,
    };
  }
  const states = transfers.map((transfer) =>
    classifyTransferState(readTransferState(transfer)),
  );
  const anyFailed = states.some((state) => state === "failed");
  const allSuccess = states.every((state) => state === "success");
  if (anyFailed) {
    const failedTransfer =
      transfers.find(
        (transfer) => classifyTransferState(readTransferState(transfer)) === "failed",
      ) || transfers[0];
    await cleanupTransferForPayload(basePayload, failedTransfer);
    const nextPayload = retrySameCandidateOrNext(
      basePayload,
      job,
      "transfer_failed",
      "slskd transfer failed",
      { transfer: failedTransfer },
    );
    if (nextPayload) return nextPayload;
    await failJob(job, "slskd transfer failed");
    return null;
  }
  if (!allSuccess) {
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
    batch,
    pollAttempts,
    candidate,
  };
}

async function handleFinalize(payload) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const playlistRoot = resolvePlaylistRoot();
  const slskdRoot = resolveLocalPath(await slskdClient.getDownloadDirectory());
  const destination = String(payload.destination || "").trim();
  const candidateIndex = Number(payload.candidateIndex || 0);
  const candidate =
    payload.candidate ||
    (Array.isArray(payload.candidates)
      ? payload.candidates[candidateIndex]
      : null);
  const remoteFile = String(candidate?.raw?.file || "");
  const { fileName } = parseSlskdRemoteFile(remoteFile);
  const transfers = readBatchTransfers(payload.batch);
  const transfer = transfers[0] || null;
  const sourcePath = await locateCompletedDownload(
    slskdRoot,
    playlistRoot,
    remoteFile,
    {
      expectedSizeBytes: Number(candidate?.raw?.size || 0),
      transfer,
    },
  );
  if (!sourcePath) {
    const searchRoot = slskdRoot || playlistRoot;
    const [predictedPath] = predictSlskdLocalPathCandidates(
      searchRoot,
      remoteFile,
    );
    const expectedPath = predictedPath || fileName;
    const nextPayload = retrySameCandidateOrNext(
      payload,
      job,
      "missing_file",
      `Downloaded file missing: ${expectedPath}`,
      { transfer },
    );
    if (nextPayload) return nextPayload;
    await failJob(job, `Downloaded file missing: ${expectedPath}`);
    return null;
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".mp3"}`;
  const finalPath = path.join(finalDir, finalName);
  const validation = await validateDownloadedTrack(
    sourcePath,
    candidate,
    buildResolvedTrack(job, payload.track),
  );
  if (!validation.valid) {
    logger.slskd("warn", "slskd download validation failed", {
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
      ? buildNextCandidatePayload(payload)
      : null;
    if (nextPayload) return nextPayload;
    await failJob(job, validation.reason || "Download validation failed");
    return null;
  }
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
    .catch(() => {});
  const committedFinalPath = await commitImportToPlaylistLibrary(
    sourcePath,
    finalPath,
  );
  if (slskdRoot) {
    await cleanupEmptyAncestors(path.dirname(sourcePath), slskdRoot).catch(
      () => {},
    );
  }
  downloadTracker.setDone(
    job.id,
    committedFinalPath,
    candidate?.resolvedAlbumName || job.albumName,
  );
  recordPayloadOutcome(job, payload, "success", null, {
    transfer,
    sourcePath,
    finalPath: committedFinalPath,
    validation,
  });
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobCompleted }) => recordTrackJobCompleted(job))
    .catch(() => {});
  const playlistType = job.playlistId || job.playlistType;
  const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
  await playlistManager.refreshPlaylist(playlistType);
  playlistManager.scheduleScanLibrary();
  const { weeklyFlowWorker } = await import("./weeklyFlowWorker.js");
  weeklyFlowWorker.wake(0);
  await weeklyFlowWorker.checkPlaylistComplete(playlistType);
  return null;
}

export async function processPipelinePayload(payload) {
  if (!payload || !payload.phase || !payload.jobId) {
    throw new Error("Invalid pipeline payload");
  }
  if (!slskdClient.isConfigured()) {
    const job = downloadTracker.getJob(payload.jobId);
    if (job) {
      await failJob(job, "slskd not configured");
    }
    return null;
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
