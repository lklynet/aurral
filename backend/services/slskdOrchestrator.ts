import path from "path";
import { asAppError } from "../../lib/errors.ts";
import fs from "fs/promises";
import type { Dirent } from "fs";
import { db } from "../config/db-sqlite.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import {
  downloadTracker,
  type HeldForReviewDraft,
  type JobFields,
} from "./downloadJobs/downloadTracker.ts";
import {
  buildAlbumSearchTiers,
  buildTrackSearchTiers,
  selectRankedMatchAttempts,
} from "./downloadJobs/trackSearchQueries.ts";
import {
  buildSourceCandidates,
  buildSoulseekCandidates,
  prefilterCandidates,
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "./trackMatching/index.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import {
  buildSlskdRankingHistoryOptions,
  recordSlskdTransferOutcome,
} from "./slskdTransferHistory.ts";
import {
  isSoulseekLoggedOutError,
  SOULSEEK_LOGGED_OUT_MESSAGE,
  type SlskdTransfer,
} from "./slskdClient.ts";
import {
  albumGrabJobs,
  continueAlbumGrab,
  deniedAlbumSources,
  finishAlbumGrab,
} from "./albumGrab.ts";
import { selectSoulseekAlbumFolder, soulseekReleaseCopies } from "./albumReleaseSearch.ts";
import { attemptTrackRequest } from "./releaseManifest.ts";
import { attemptRelease } from "./releaseResolver.ts";
import {
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeImportedFileMetadata,
} from "./downloadUtils.ts";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  holdForReview,
  finalizePipelineJobSuccess,
  type PipelineSuccessJob,
  SEARCH_RESET,
} from "./pipelineHelpers.ts";
import {
  clearDownloadProviderWork,
  isPipelinePayloadActive,
  registerDownloadProviderWork,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.ts";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.ts";
import { cacheSearchResults, getCachedSearchResults } from "./downloadJobs/searchResultCache.ts";
import createCache from "./apiClients/simpleCache.ts";
import type { DownloadTrackFields } from "./downloadUtils.ts";
import type { SoulseekSearchItem, TrackSearchContext } from "./downloadJobs/trackSearchQueries.ts";
import type { SearchTrackRequest } from "./trackMatching/trackIdentity.ts";
import type { HistoryJob } from "./aurralHistoryService.ts";

type SlskdValues = { $values?: SlskdTransfer[] };
type SlskdBatch = {
  transfers?: SlskdTransfer[] | SlskdValues;
  Transfers?: SlskdTransfer[] | SlskdValues;
};

type SlskdAlbumFile = { file?: string | null; size?: number | null; jobId?: string | null };

type SlskdCandidate = {
  raw: {
    user?: string | null;
    file?: string | null;
    size?: number | null;
    files?: SlskdAlbumFile[];
  };
  resolvedAlbumName?: string | null;
  evaluation?: { decision?: string | null };
  candidate?: unknown;
};

type SlskdPayload = {
  jobId: string;
  playlistId?: string | null;
  phase: string;
  track?: DownloadTrackFields;
  albumGrab?: boolean;
  albumTransfers?: (SlskdTransfer | null)[] | null;
  searchQueries?: string[];
  searchQueryIndex?: number;
  searchIds?: string[];
  searchId?: string | null;
  activeSearch?: { id: string; query: string; startedAt: number; queued?: boolean } | null;
  soulseekLoggedOutSince?: number | null;
  candidates?: SlskdCandidate[];
  candidate?: SlskdCandidate | null;
  candidateIndex?: number;
  candidateRetryCounts?: Record<number, number>;
  pollAttempts?: number;
  delaySeconds?: number;
  eventOffset?: number | null;
  legacyTransfer?: { id?: string; username?: string } | null;
  lastProgress?: string | null;
  lastProgressAt?: number | null;
  tailSince?: number | null;
  batch?: SlskdBatch | null;
  batchId?: string | null;
  destination?: string | null;
  heldForReview?: HeldForReviewDraft;
  upgradeForJobId?: string | null;
  upgrade?: boolean;
  manualSelection?: boolean;
};

type SlskdJob = HistoryJob &
  JobFields<
    "remoteUsername" | "slskdSearchId" | "slskdBatchId" | "deniedRemoteSources" | "qualityTier"
  > &
  PipelineSuccessJob;

type SlskdHelpers = {
  failOrTryNextSource: (
    payload: SlskdPayload,
    job: SlskdJob,
    message: string,
    logDetails?: object,
  ) => Promise<SlskdPayload | null>;
};

type SearchStepFields = {
  cancelled?: undefined;
  loggedOut?: undefined;
  payload?: undefined;
  aggregated?: undefined;
  searchIds?: undefined;
  queryCount?: undefined;
};
type SearchStep<T> = T & Omit<SearchStepFields, keyof T>;
type SlskdSearchStep =
  | SearchStep<{ cancelled: true }>
  | SearchStep<{ payload: SlskdPayload }>
  | SearchStep<{ loggedOut: unknown; payload: SlskdPayload }>
  | SearchStep<{ aggregated: SoulseekSearchItem[]; searchIds: string[]; queryCount: number }>;
type FileMatch = { path: string; size: number; mtimeMs: number };

type SlskdSearchOptions = Awaited<ReturnType<typeof getWorkerSearchOptions>> & {
  deniedSourceKeys: Set<string>;
  qualityProfile: ReturnType<typeof getQualityProfile>;
  currentTier: string | null | undefined;
  upgrade: boolean;
  albumJobs: SlskdJob[] | null;
  manifest: Awaited<ReturnType<typeof attemptRelease>>;
};

type PayloadOutcomeDetails = {
  candidate?: SlskdCandidate | { raw: { user?: string | null; file?: string | null } } | null;
  transfer?: SlskdTransfer | null;
  transferId?: string | null;
  batchId?: string | null;
  sourcePath?: string | null;
  finalPath?: string | null;
  validation?: unknown;
};

import { getQualityProfile } from "./qualityProfileService.ts";
import {
  getAdvertisedQualityRank,
  getQualityTier,
  orderAdvertisedQualityCandidates,
} from "./qualityProfileModel.ts";

const slskdClient = getDownloadClient("slskd");

const updateSlskdMetaStmt = db.prepare(`
  UPDATE playlist_download_jobs
  SET slskd_search_id = COALESCE(?, slskd_search_id),
      slskd_batch_id = COALESCE(?, slskd_batch_id),
      remote_username = COALESCE(?, remote_username),
      remote_filename = COALESCE(?, remote_filename)
  WHERE id = ?
`);

const DECISION_RANKS: Partial<
  Record<ReturnType<typeof usableEvaluationEntries>[number]["decision"], number>
> = { accept: 0, verify: 1, review: 2 };

const TRANSFER_RESET = Object.freeze({
  batchId: null,
  legacyTransfer: null,
  lastProgress: null,
  lastProgressAt: null,
  tailSince: null,
});
const ALBUM_TRANSFER_RESET = Object.freeze({ ...TRANSFER_RESET, albumTransfers: null });
const STALLED_TRANSFER_MS = 30 * 60 * 1000;
const QUEUED_TRANSFER_MS = 10 * 60 * 1000;
const TAIL_ALBUM_TRANSFER_MS = 20 * 60 * 1000;
const searchMonitors = createCache(10 * 60, 100);
const MIN_SEARCH_CANDIDATES = 3;
const MAX_DOWNLOAD_CANDIDATES = 7;
const MAX_TRANSFER_RETRIES_PER_CANDIDATE = 1;
const POLL_DELAY_SECONDS = 3;
const SOULSEEK_LOGIN_RECHECK_SECONDS = 60;
const SOULSEEK_LOGIN_WAIT_LIMIT_MS = 45 * 60 * 1000;
export const SLSKD_NOT_CONFIGURED_MESSAGE =
  "slskd is not configured. Enable slskd and add its Server URL in Settings → Downloads to enable Soulseek downloads for flows and playlists.";

export function buildSlskdSearchTierGroups(resolvedTrack: TrackSearchContext) {
  return buildTrackSearchTiers(resolvedTrack);
}

function isDeniedSoulseekFile(
  raw: { user?: unknown; file?: unknown } | null | undefined,
  deniedSourceKeys: ReadonlySet<string> | null | undefined,
) {
  const user = String(raw?.user || "")
    .trim()
    .toLowerCase();
  const file = String(raw?.file || "")
    .trim()
    .toLowerCase();
  return deniedSourceKeys?.has(`${user}\0${file}`) === true;
}

function selectAlbumFolders(
  aggregated: SoulseekSearchItem[],
  searchOptions: Partial<SlskdSearchOptions> & Pick<SlskdSearchOptions, "albumJobs">,
) {
  return selectSoulseekAlbumFolder(
    aggregated.filter(
      (raw) =>
        !isDeniedSoulseekFile(raw, searchOptions.deniedSourceKeys) &&
        !searchOptions.isUserBlacklisted?.(raw.user),
    ),
    searchOptions.albumJobs,
    {
      manifest: searchOptions.manifest,
      profile: searchOptions.qualityProfile || getQualityProfile(),
    },
  );
}

export function hasSlskdSearchCandidates(
  aggregated: SoulseekSearchItem[],
  resolvedTrack: SearchTrackRequest,
  searchOptions: Partial<SlskdSearchOptions> | undefined,
) {
  if (searchOptions?.albumJobs) {
    return (
      selectAlbumFolders(aggregated, { ...searchOptions, albumJobs: searchOptions.albumJobs })
        .decision === "selectable"
    );
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
    .filter(
      (entry, index) =>
        !entry.rejected &&
        built.providerEvidence[index]?.folder?.plausible &&
        !isDeniedSoulseekFile(entry.candidate.raw, searchOptions?.deniedSourceKeys),
    )
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

function classifyTransferState(state: string | null | undefined) {
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

function readBatchTransfers(batch: SlskdBatch | null | undefined): SlskdTransfer[] {
  const transfers = batch?.transfers || batch?.Transfers;
  if (Array.isArray(transfers)) return transfers;
  if (Array.isArray(transfers?.$values)) return transfers.$values;
  return [];
}

function readTransferState(transfer: SlskdTransfer | null | undefined) {
  return transfer?.state || transfer?.State || "";
}

function describeTransferFailure(transfer: SlskdTransfer | null | undefined) {
  const exception = String(transfer?.exception || transfer?.Exception || "").trim();
  return exception ? `slskd transfer failed: ${exception}` : "slskd transfer failed";
}

function readTransferId(transfer: SlskdTransfer | null | undefined) {
  return String(
    transfer?.id || transfer?.Id || transfer?.transferId || transfer?.TransferId || "",
  ).trim();
}

function getPayloadSearchIds(payload: SlskdPayload) {
  const ids: string[] = [];
  if (Array.isArray(payload?.searchIds)) ids.push(...payload.searchIds);
  if (payload?.searchId) ids.push(payload.searchId);
  return [...new Set(ids.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function getCandidateRetryCount(payload: SlskdPayload, candidateIndex: number | null = null) {
  const index =
    candidateIndex == null ? Number(payload?.candidateIndex || 0) : Number(candidateIndex || 0);
  const counts: Record<number, number> =
    payload?.candidateRetryCounts && typeof payload.candidateRetryCounts === "object"
      ? payload.candidateRetryCounts
      : {};
  return Number(counts[index] || 0);
}

function withCandidateRetryCount(
  payload: SlskdPayload,
  candidateIndex: number,
  retryCount: number,
) {
  return {
    ...payload,
    candidateRetryCounts: {
      ...(payload?.candidateRetryCounts || {}),
      [Number(candidateIndex || 0)]: Number(retryCount || 0),
    },
  };
}

function buildRetrySameCandidatePayload(payload: SlskdPayload, delaySeconds = 5) {
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

function readEventData(record: { data?: unknown; Data?: unknown } | null | undefined) {
  const data = record?.data ?? record?.Data;
  if (!data) return null;
  if (typeof data === "object") return data;
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRemotePath(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function eventMatchesCandidate(
  record: { data?: unknown; Data?: unknown } | null | undefined,
  candidate: SlskdCandidate | null | undefined,
) {
  const raw: SlskdCandidate["raw"] = candidate?.raw || {};
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

async function pollSlskdEventsForCandidate(payload: SlskdPayload) {
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
    if (!isRecord(event)) continue;
    const type = String(event.type || event.Type || "");
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

function isPathInside(childPath: unknown, rootPath: unknown) {
  if (!String(childPath || "").trim() || !String(rootPath || "").trim()) {
    return false;
  }
  const child = path.resolve(String(childPath || ""));
  const root = path.resolve(String(rootPath || ""));
  return child === root || child.startsWith(`${root}${path.sep}`);
}

export function parseSlskdRemoteFile(remoteFile: unknown) {
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

export function predictSlskdLocalPathCandidates(
  root: string | null | undefined,
  remoteFile: string | null | undefined,
) {
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

function readTransferFilename(transfer: SlskdTransfer | null | undefined) {
  return String(
    transfer?.filename || transfer?.Filename || transfer?.file || transfer?.File || "",
  ).trim();
}

function resolveTransferLocalPath(
  transferFilename: string | null | undefined,
  slskdRoot: string | null | undefined,
) {
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

async function statMatchingFile(filePath: string, expectedSizeBytes: number | null | undefined) {
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
  dir: string,
  fileName: string,
  expectedSizeBytes: number | null | undefined,
  depth = 0,
  matches: FileMatch[] | null = null,
): Promise<string | FileMatch[] | null> {
  if (depth > 8) return matches;
  const collected = matches || [];
  let entries: Dirent[] = [];
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

function pickBestFileMatch(matches: FileMatch[], expectedSizeBytes: number | null | undefined) {
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

export async function locateCompletedDownload(
  slskdRoot: string | null | undefined,
  playlistRoot: string | null | undefined,
  remoteFile: string | null | undefined,
  options: { expectedSizeBytes?: number | null; transfer?: SlskdTransfer | null } = {},
) {
  const expectedSizeBytes = Number(options.expectedSizeBytes || 0);
  const transferFilename = readTransferFilename(options.transfer);
  const transferPath = resolveTransferLocalPath(transferFilename, slskdRoot);
  if (transferPath) {
    const directTransfer = await statMatchingFile(transferPath, expectedSizeBytes);
    if (directTransfer) return directTransfer;
  }

  const searchRoots: string[] = [];
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
}: {
  sourcePath?: string | null;
  slskdRoot?: string | null;
  playlistRoot?: string | null;
  transfer?: SlskdTransfer | null;
  username?: string | null;
} = {}) {
  const transferId = readTransferId(transfer);
  const transferUser = String(username || transfer?.username || transfer?.Username || "").trim();
  if (transferUser && transferId) {
    await slskdClient
      .deleteTransfer(transferUser, transferId, { remove: true })
      .catch((err: unknown) => {
        logger.warn("slskd", "Failed to clean up transfer", {
          transferId,
          error: asAppError(err)?.message || String(err),
        });
      });
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
    await fs.rm(safeSource, { force: true }).catch((err: unknown) => {
      logger.warn("slskd", "Failed to remove rejected download file", {
        sourcePath: safeSource,
        error: asAppError(err)?.message || String(err),
      });
    });
    await cleanupEmptyAncestors(path.dirname(safeSource), safeSlskdRoot).catch(() => {});
  }
}

async function cleanupTransferForPayload(
  payload: SlskdPayload,
  transfer: SlskdTransfer | null | undefined,
) {
  const transferId = readTransferId(transfer);
  if (!transferId) return;
  const candidate = getPayloadCandidate(payload);
  const username = String(
    transfer?.username || transfer?.Username || candidate?.raw?.user || "",
  ).trim();
  if (!username) return;
  await slskdClient.deleteTransfer(username, transferId, { remove: true }).catch((err: unknown) => {
    logger.warn("slskd", "Failed to clean up transfer for payload", {
      transferId,
      error: asAppError(err)?.message || String(err),
    });
  });
}

function clearTrackedSearches(searchIds: string[] | null | undefined = []) {
  const ids = Array.isArray(searchIds) ? searchIds : [];
  for (const searchId of new Set(ids.map((entry) => String(entry || "").trim()).filter(Boolean))) {
    clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
  }
}

async function cleanupSuccessfulRunArtifacts(
  payload: SlskdPayload,
  transfer: SlskdTransfer | null | undefined,
) {
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
    clearTrackedSearches(
      result && "cleanedSearchIds" in result ? result.cleanedSearchIds : undefined,
    );
  } catch (error) {
    logger.warn("slskd", "Failed to clean up successful slskd run", {
      error: asAppError(error)?.message || String(error),
      searchIds,
      transferCount: transfers.length,
    });
  }
}

async function cleanupEmptyAncestors(dir: string, rootBoundary: string | null | undefined) {
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

function recordPayloadOutcome(
  job: SlskdJob | null | undefined,
  payload: SlskdPayload,
  status: string,
  reason: string | null,
  details: PayloadOutcomeDetails = {},
) {
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

function retrySameCandidateAllowed(payload: SlskdPayload) {
  if (payload?.manualSelection === true) return false;
  return (
    getCandidateRetryCount(payload, Number(payload?.candidateIndex || 0)) <
    MAX_TRANSFER_RETRIES_PER_CANDIDATE
  );
}

function retrySameCandidateOrNext(
  payload: SlskdPayload,
  job: SlskdJob,
  status: string,
  reason: string,
  details: PayloadOutcomeDetails = {},
) {
  recordPayloadOutcome(job, payload, status, reason, details);
  if (retrySameCandidateAllowed(payload)) {
    return buildRetrySameCandidatePayload(payload, 5);
  }
  if (hasNextCandidate(payload)) {
    return buildNextCandidatePayload(payload, TRANSFER_RESET);
  }
  return null;
}

function recordTrackJobHistory(
  job: SlskdJob,
  record: (history: typeof import("./aurralHistoryService.ts")) => unknown,
) {
  import("./aurralHistoryService.ts").then(record).catch((err: unknown) => {
    logger.warn("slskd", "Failed to record track job activity", {
      jobId: job.id,
      error: asAppError(err)?.message || String(err),
    });
  });
}

async function isLoggedOut(options?: { force?: boolean }) {
  const status = await slskdClient.testConnection(options);
  return status?.ok === true && status.connected !== true;
}

async function isStillLoggedOut(payload: SlskdPayload) {
  return Boolean(payload.soulseekLoggedOutSince) && isLoggedOut();
}

async function waitToRetryAfterLogin(
  payload: SlskdPayload,
  job: SlskdJob,
  helpers: SlskdHelpers,
  reason: string,
) {
  if (!(await isLoggedOut({ force: true }))) return null;
  return waitForSoulseekLogin(
    { ...payload, ...TRANSFER_RESET, phase: "download", candidate: null, pollAttempts: 0 },
    job,
    helpers,
    reason,
  );
}

function waitForSoulseekLogin(
  payload: SlskdPayload,
  job: SlskdJob,
  helpers: SlskdHelpers,
  detail?: string,
) {
  const since = Number(payload.soulseekLoggedOutSince) || Date.now();
  if (Date.now() - since >= SOULSEEK_LOGIN_WAIT_LIMIT_MS) {
    return helpers.failOrTryNextSource(
      { ...payload, soulseekLoggedOutSince: null },
      job,
      `${SOULSEEK_LOGGED_OUT_MESSAGE} after waiting ${SOULSEEK_LOGIN_WAIT_LIMIT_MS / 60000} minutes`,
    );
  }
  if (!payload.soulseekLoggedOutSince) {
    logger.warn("slskd", "Soulseek is not logged in; waiting for slskd to log in", {
      jobId: job.id,
      phase: payload.phase,
      reason: detail,
    });
    recordTrackJobHistory(job, (history) =>
      history.recordTrackJobWaiting(
        job,
        `${SOULSEEK_LOGGED_OUT_MESSAGE}. Aurral continues when it logs in.`,
      ),
    );
  }
  return {
    ...payload,
    soulseekLoggedOutSince: since,
    delaySeconds: SOULSEEK_LOGIN_RECHECK_SECONDS,
  };
}

function probeAggregatedResults(
  aggregated: SoulseekSearchItem[],
  queryResults: SoulseekSearchItem[],
  seen: Set<string>,
) {
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

function trackSearchWork(payload: SlskdPayload) {
  return {
    onSearchCreated: (id: string) =>
      registerDownloadProviderWork({
        jobId: payload.jobId,
        playlistId: payload.playlistId,
        provider: "slskd-search",
        workId: id,
      }),
    onSearchSettled: (id: string) =>
      clearDownloadProviderWork({ provider: "slskd-search", workId: id }),
  };
}

function searchMonitorFor(
  payload: SlskdPayload,
  activeSearch: NonNullable<SlskdPayload["activeSearch"]>,
) {
  let monitor = searchMonitors.get(activeSearch.id);
  if (!monitor) {
    monitor = slskdClient.monitorSearch(activeSearch.id, {
      startedAt: activeSearch.startedAt,
      queued: activeSearch.queued,
      onSearchSettled: trackSearchWork(payload).onSearchSettled,
    });
    searchMonitors.set(activeSearch.id, monitor);
  }
  return monitor;
}

async function stopSearch(searchId: string) {
  const deleted = await slskdClient.deleteSearch(searchId, { timeout: 20000 }).catch(() => false);
  if (deleted) clearDownloadProviderWork({ provider: "slskd-search", workId: searchId });
}

const searchResultKey = (result: SoulseekSearchItem) => `${result.user}\0${result.file}`;

// One step of a search: either one poll of the running slskd search, or the
// start of the next query. Results of finished queries live in the shared
// search cache, so a restart only repeats the queries it lost.
async function advanceSlskdSearch(
  payload: SlskdPayload,
  job: SlskdJob,
  queries: string[],
  resolvedTrack: SearchTrackRequest,
  searchOptions: SlskdSearchOptions,
): Promise<SlskdSearchStep> {
  const aggregated: SoulseekSearchItem[] = [];
  const seen = new Set<string>();
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
  const enough = (results: SoulseekSearchItem[]) =>
    hasSlskdSearchCandidates(results, resolvedTrack, searchOptions);
  const activeSearch = payload.activeSearch?.query === queries[index] ? payload.activeSearch : null;
  if (payload.activeSearch && !activeSearch) {
    searchMonitors.delete(payload.activeSearch.id);
    await stopSearch(payload.activeSearch.id);
  }
  if (activeSearch) {
    const monitor = searchMonitorFor(payload, activeSearch);
    let result;
    try {
      result = await monitor.poll({
        shouldCancel: isCancelled,
        earlyExitWhen: (data: unknown) =>
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
    if (isCancelled()) {
      searchMonitors.delete(activeSearch.id);
      return { cancelled: true };
    }
    if (!result.done) {
      return {
        payload: {
          ...payload,
          searchQueryIndex: index,
          activeSearch: { ...activeSearch, startedAt: monitor.startedAt, queued: monitor.queued },
          delaySeconds: Math.max(1, Math.ceil(result.waitMs / 1000)),
        },
      };
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
    let created;
    try {
      created = await slskdClient.createSearch(queries[index], {
        shouldCancel: isCancelled,
        ...trackSearchWork(payload),
      });
    } catch (error) {
      if (!isSoulseekLoggedOutError(error)) throw error;
      return {
        loggedOut: error,
        payload: { ...payload, searchQueryIndex: index, searchIds, activeSearch: null },
      };
    }
    searchIds.push(created.id);
    if (!job.slskdSearchId) {
      updateSlskdMetaStmt.run(created.id, null, null, null, job.id);
      job.slskdSearchId = created.id;
    }
    if (isCancelled()) {
      await stopSearch(created.id);
      return { cancelled: true };
    }
    return {
      payload: {
        ...payload,
        searchQueryIndex: index,
        searchIds,
        searchId: payload.searchId || created.id,
        activeSearch: { id: created.id, query: queries[index], startedAt: Date.now() },
        delaySeconds: 1,
      },
    };
  }
  return { aggregated, searchIds, queryCount: index };
}

async function handleSearch(payload: SlskdPayload, helpers: SlskdHelpers) {
  const job: SlskdJob | null = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (await isStillLoggedOut(payload)) return waitForSoulseekLogin(payload, job, helpers);
  if (payload.soulseekLoggedOutSince) {
    payload = { ...payload, soulseekLoggedOutSince: null };
    recordTrackJobHistory(job, (history) => history.recordTrackJobSearching(job));
  }
  if (!payload.searchQueries) {
    downloadTracker.setDownloading(job.id);
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: "slskd",
    });
    recordTrackJobHistory(job, (history) => history.recordTrackJobSearching(job));
  }
  const release = await attemptRelease(payload, job);
  const resolvedTrack = attemptTrackRequest(job, release, payload.track);
  const albumJobs = payload.albumGrab === true ? albumGrabJobs(payload) : null;
  const queries =
    payload.searchQueries ||
    (albumJobs
      ? buildAlbumSearchTiers({ ...resolvedTrack, compilation: release?.compilation === true })
      : buildSlskdSearchTierGroups(resolvedTrack)
    ).flatMap((tier) => tier.queries);
  const currentTier = payload.upgradeForJobId
    ? downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier
    : null;
  const deniedSources = Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [];
  const deniedSourceKeys: Set<string> = albumJobs
    ? deniedAlbumSources([job, ...albumJobs], "slskd")
    : new Set(
        deniedSources
          .filter((entry) => Array.isArray(entry) && entry[0] === "slskd")
          .map((entry) =>
            String(entry[1] || "")
              .trim()
              .toLowerCase(),
          ),
      );
  const searchOptions = {
    deniedSourceKeys,
    ...(await getWorkerSearchOptions()),
    qualityProfile: getQualityProfile(),
    currentTier,
    upgrade: payload.upgrade === true,
    albumJobs,
    manifest: release,
  };
  const step = await advanceSlskdSearch(
    { ...payload, searchQueries: queries },
    job,
    queries,
    resolvedTrack,
    searchOptions,
  );
  if (step.cancelled || !isPipelinePayloadActive(payload)) return null;
  if (step.loggedOut)
    return waitForSoulseekLogin(step.payload!, job, helpers, asAppError(step.loggedOut)?.message);
  if (step.payload) return step.payload;
  const { aggregated, searchIds, queryCount } = step;
  const searchId = payload.searchId || searchIds[0] || null;
  if (albumJobs) {
    const selection = selectAlbumFolders(aggregated, searchOptions);
    if (selection.decision !== "selectable") {
      return helpers.failOrTryNextSource(payload, job, "No selectable Soulseek album folder");
    }
    return {
      ...payload,
      ...SEARCH_RESET,
      phase: "download",
      source: "slskd",
      searchId,
      searchIds: [...new Set(searchIds)],
      candidateIndex: 0,
      candidates: selection.candidates.map((candidate) => ({
        raw: { user: candidate.group.user, files: candidate.files },
        resolvedAlbumName: job.albumName,
        score: candidate.fit,
        releaseVerified: true,
      })),
      policyVersion: selection.policyVersion,
    };
  }
  const evaluation = await buildSourceCandidates({
    source: "soulseek",
    results: aggregated,
    request: resolvedTrack,
    options: { ...searchOptions },
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
  // A copy from a folder of the pinned release is that recording, so it goes
  // ahead of an equally good copy from anywhere else.
  const releaseCopies = soulseekReleaseCopies(aggregated, release, job);
  const ordered = qualityOrdered
    .map((entry, index) => ({
      entry,
      originalOrder: index,
      tierRank: getAdvertisedQualityRank(
        entry.candidate?.raw?.file,
        entry.candidate?.raw?.bitrate ?? entry.candidate?.raw?.bitRate,
        profile,
      ),
      decisionRank: DECISION_RANKS[entry.decision] ?? 3,
      releaseRank: releaseCopies.has(`${entry.candidate?.raw?.user}\0${entry.candidate?.raw?.file}`)
        ? 0
        : 1,
      distance: Number.isFinite(entry.distance) ? entry.distance : Number.POSITIVE_INFINITY,
      queuePenalty: Number(searchOptions.getUserQueuePenalty?.(entry.candidate?.raw?.user) || 0),
    }))
    .sort(
      (left, right) =>
        left.tierRank - right.tierRank ||
        left.decisionRank - right.decisionRank ||
        left.releaseRank - right.releaseRank ||
        left.distance - right.distance ||
        left.queuePenalty - right.queuePenalty ||
        left.originalOrder - right.originalOrder,
    )
    .map(({ entry }) => entry);
  const filteredPool =
    deniedSourceKeys.size > 0
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

async function handleDownload(payload: SlskdPayload, helpers: SlskdHelpers) {
  const job: SlskdJob | null = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (await isStillLoggedOut(payload)) return waitForSoulseekLogin(payload, job, helpers);
  if (payload.soulseekLoggedOutSince) payload = { ...payload, soulseekLoggedOutSince: null };
  recordTrackJobHistory(job, (history) => history.recordTrackJobDownloading(job));
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  if (payload.albumGrab === true) {
    const activeJobIds = new Set(albumGrabJobs(payload).map((entry: { id: string }) => entry.id));
    const files = (candidate?.raw?.files || []).filter(
      (file) => !file.jobId || activeJobIds.has(file.jobId),
    );
    if (!candidate?.raw?.user || files.length === 0) {
      return (
        continueAlbumGrab(payload, ALBUM_TRANSFER_RESET) ||
        helpers.failOrTryNextSource(payload, job, "No Soulseek album files available")
      );
    }
    const username = candidate.raw.user;
    let submission;
    try {
      submission = await withPipelineCommitLock(payload, async () => {
        const result = await slskdClient.enqueueBatch({
          username,
          files: files.map((file) => ({ filename: file.file, size: Number(file.size || 0) })),
        });
        const transfers: SlskdTransfer[] = Array.isArray(result.transfers) ? result.transfers : [];
        if (
          transfers.length !== files.length ||
          transfers.some((transfer) => !readTransferId(transfer))
        ) {
          for (const transfer of transfers) {
            const id = readTransferId(transfer);
            if (id)
              await slskdClient.deleteTransfer(username, id, { remove: true }).catch(() => {});
          }
          throw new Error("slskd did not return a transfer ID for every album file");
        }
        downloadTracker.updateDownloadMetadata(job.id, {
          downloadSource: "slskd",
          downloadClient: "slskd",
          downloadClientId: readTransferId(transfers[0]),
          remoteUsername: username,
          remoteFilename: files[0].file,
        });
        return transfers;
      });
    } catch (error) {
      if (isSoulseekLoggedOutError(error))
        return waitForSoulseekLogin(payload, job, helpers, asAppError(error)?.message);
      return (
        continueAlbumGrab(payload, ALBUM_TRANSFER_RESET) ||
        helpers.failOrTryNextSource(payload, job, safeLogDiagnostic(error))
      );
    }
    if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
    return {
      ...payload,
      phase: "poll",
      candidate: { ...candidate, raw: { ...candidate.raw, files } },
      albumTransfers: submission.result,
      pollAttempts: 0,
    };
  }
  if (!candidate?.raw?.user || !candidate?.raw?.file) {
    return helpers.failOrTryNextSource(payload, job, "No download candidate available");
  }
  const searchId = payload.searchId || null;
  const username = candidate.raw.user;
  const remoteFile = candidate.raw.file;
  updateSlskdMetaStmt.run(searchId, null, username, remoteFile, job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "slskd",
    downloadClient: "slskd",
    remoteUsername: username,
    remoteFilename: remoteFile,
  });
  let submission;
  try {
    submission = await withPipelineCommitLock(payload, async () => {
      const result = await slskdClient.enqueueBatch({
        username,
        files: [
          {
            filename: remoteFile,
            size: Number(candidate.raw.size || 0),
          },
        ],
      });
      const transfer = result?.transfers?.[0] || null;
      const transferId = readTransferId(transfer) || String(result?.transferId || "").trim();
      const transferUsername = String(result?.username || transfer?.username || username).trim();
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
    if (isSoulseekLoggedOutError(error))
      return waitForSoulseekLogin(payload, job, helpers, asAppError(error)?.message);
    const message = asAppError(error)?.message || String(error);
    recordPayloadOutcome(job, { ...payload, candidate }, "enqueue_failed", message, { candidate });
    logger.warn("slskd", "slskd batch enqueue failed for candidate", {
      jobId: job.id,
      username,
      file: remoteFile,
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

// slskd re-requests a queued file now and then, which cycles its state
// through "Requested" and back without anything moving, so only the outcome,
// the bytes, and the queue position count as progress.
function readTransferProgress(transfer: SlskdTransfer | null | undefined) {
  if (!transfer) return "missing";
  return [
    classifyTransferState(readTransferState(transfer)),
    transfer.bytesTransferred ?? transfer.BytesTransferred ?? "",
    transfer.placeInQueue ?? transfer.PlaceInQueue ?? "",
  ].join("|");
}

// A transfer times out only when nothing about it moves for a while, so a
// slow upload or a moving remote queue keeps going.
function trackTransferProgress(payload: SlskdPayload, progress: string, now = Date.now()) {
  const changed = progress !== payload.lastProgress;
  const lastProgressAt =
    changed || !Number(payload.lastProgressAt) ? now : Number(payload.lastProgressAt);
  return {
    lastProgress: progress,
    lastProgressAt,
    stalled: now - lastProgressAt > STALLED_TRANSFER_MS,
  };
}

function isQueuedUntouched(transfer: SlskdTransfer) {
  return (
    /queued/i.test(readTransferState(transfer)) &&
    !Number(transfer.bytesTransferred ?? transfer.BytesTransferred)
  );
}

// Once every other file of the album finished or failed, the rest get a
// limited window: files still in the uploader's queue 10 minutes, a file
// still transferring 20. Then the album imports what finished and moves on.
function albumTailWindow(transfers: (SlskdTransfer | null)[]) {
  const pending = transfers.filter(
    (transfer) => !transfer || classifyTransferState(readTransferState(transfer)) === "pending",
  );
  if (
    pending.length === 0 ||
    pending.length === transfers.length ||
    pending.some((transfer) => !transfer)
  ) {
    return null;
  }
  return pending.every((transfer) => transfer && isQueuedUntouched(transfer))
    ? QUEUED_TRANSFER_MS
    : TAIL_ALBUM_TRANSFER_MS;
}

async function handlePoll(payload: SlskdPayload, helpers: SlskdHelpers) {
  const job: SlskdJob | null = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  if (payload.albumGrab === true) {
    const username = payload.candidate?.raw?.user;
    const transfers: (SlskdTransfer | null)[] = await Promise.all(
      (payload.albumTransfers || []).map(async (transfer) =>
        slskdClient.getTransfer(username, readTransferId(transfer)).catch(() => null),
      ),
    );
    if (
      !transfers.some(
        (transfer) => !transfer || classifyTransferState(readTransferState(transfer)) === "pending",
      )
    ) {
      return { ...payload, phase: "finalize", pollAttempts, albumTransfers: transfers };
    }
    const progress = trackTransferProgress(payload, transfers.map(readTransferProgress).join(","));
    const tailWindow = albumTailWindow(transfers);
    const tailSince = tailWindow ? Number(payload.tailSince) || Date.now() : null;
    // A folder whose files all still wait untouched in the uploader's queue
    // gets 10 minutes, as a single file does, before the next folder.
    const queuedTooLong =
      transfers.every((transfer) => transfer && isQueuedUntouched(transfer)) &&
      Date.now() - progress.lastProgressAt > QUEUED_TRANSFER_MS;
    if (
      !progress.stalled &&
      !queuedTooLong &&
      !(tailSince && Date.now() - tailSince > tailWindow!)
    ) {
      return {
        ...payload,
        phase: "poll",
        pollAttempts,
        delaySeconds: POLL_DELAY_SECONDS,
        lastProgress: progress.lastProgress,
        lastProgressAt: progress.lastProgressAt,
        tailSince,
      };
    }
    // Keep the files that finished. The album attempt continues for the rest.
    const settled = transfers.map((transfer, index) => transfer || payload.albumTransfers![index]);
    for (const transfer of settled) {
      if (classifyTransferState(readTransferState(transfer)) !== "pending") continue;
      const id = readTransferId(transfer);
      if (id)
        await slskdClient.deleteTransfer(username, id, { remove: true }).catch((error: unknown) =>
          logger.warn("slskd", "Stalled album transfer cleanup failed", {
            jobId: job.id,
            transferId: id,
            reason: safeLogDiagnostic(error),
          }),
        );
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
      const reason = describeTransferFailure(transfer);
      const waiting = await waitToRetryAfterLogin(basePayload, job, helpers, reason);
      if (waiting) return waiting;
      // A rejection, such as a ban or a file no longer shared, fails again on
      // a retry, so the next user is tried at once.
      const rejected = /rejected/i.test(readTransferState(transfer));
      if (rejected) recordPayloadOutcome(job, basePayload, "transfer_failed", reason, { transfer });
      const nextPayload = rejected
        ? hasNextCandidate(basePayload)
          ? buildNextCandidatePayload(basePayload, TRANSFER_RESET)
          : null
        : retrySameCandidateOrNext(basePayload, job, "transfer_failed", reason, { transfer });
      if (nextPayload) return nextPayload;
      return helpers.failOrTryNextSource(basePayload, job, reason);
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
  // A file another user also has waits only 10 minutes in an uploader's queue.
  const queuedTooLong =
    transfer &&
    isQueuedUntouched(transfer) &&
    hasNextCandidate(basePayload) &&
    Date.now() - progress.lastProgressAt > QUEUED_TRANSFER_MS;
  if (!progress.stalled && !queuedTooLong) {
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
    await slskdClient
      .deleteTransfer(payload.legacyTransfer.username, payload.legacyTransfer.id, { remove: true })
      .catch(() => false);
  }
  const waiting = await waitToRetryAfterLogin(basePayload, job, helpers, "slskd transfer stalled");
  if (waiting) return waiting;
  recordPayloadOutcome(
    job,
    basePayload,
    "transfer_timeout",
    progress.stalled ? "slskd transfer stalled" : "slskd transfer stayed in the uploader's queue",
    { transfer },
  );
  if (hasNextCandidate(basePayload)) {
    return buildNextCandidatePayload(basePayload, TRANSFER_RESET);
  }
  return helpers.failOrTryNextSource(basePayload, job, "slskd transfer stalled");
}

async function handleFinalize(payload: SlskdPayload, helpers: SlskdHelpers) {
  const job: SlskdJob | null = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (payload.albumGrab === true) {
    const slskdRoot = resolveLocalPath(
      await slskdClient.getDownloadDirectory(),
      getPathMappings("slskd"),
    );
    const playlistRoot = resolveDownloadRoot();
    const remoteFiles = payload.candidate?.raw?.files || [];
    const paths = [];
    const isPeerFailure = (transfer: SlskdTransfer | null | undefined) => {
      const transferState = readTransferState(transfer);
      return classifyTransferState(transferState) === "failed" && !/cancel/i.test(transferState);
    };
    const blamePeer =
      (payload.albumTransfers || []).some(isPeerFailure) && !(await isLoggedOut({ force: true }));
    for (const [index, transfer] of (payload.albumTransfers || []).entries()) {
      const transferState = readTransferState(transfer);
      if (blamePeer && isPeerFailure(transfer)) {
        const remote = remoteFiles[index];
        recordPayloadOutcome(
          downloadTracker.getJob(remote?.jobId) || job,
          payload,
          "transfer_failed",
          describeTransferFailure(transfer),
          {
            transfer,
            candidate: { raw: { user: payload.candidate?.raw?.user, file: remote?.file } },
          },
        );
      }
      if (classifyTransferState(transferState) !== "success") continue;
      const remote = remoteFiles[index];
      const local = await locateCompletedDownload(slskdRoot, playlistRoot, remote?.file, {
        expectedSizeBytes: Number(remote?.size || 0),
        transfer,
      });
      if (local) paths.push(local);
    }
    const next = await finishAlbumGrab(payload, {
      filePaths: paths,
      source: "soulseek",
      album: job.albumName,
      resetFields: ALBUM_TRANSFER_RESET,
    });
    // A file the album did not import, because it failed its check or no
    // track needed it, and the folders the imports emptied would otherwise
    // stay in slskd's download folder.
    for (const filePath of paths) {
      if (await fs.stat(filePath).catch(() => null)) {
        await cleanupRejectedDownload({ sourcePath: filePath, slskdRoot, playlistRoot });
      } else if (slskdRoot) {
        await cleanupEmptyAncestors(path.dirname(filePath), slskdRoot).catch(() => {});
      }
    }
    if (slskdClient.isCleanupAfterRunsEnabled()) {
      const transfers = (payload.albumTransfers || [])
        .map((transfer) => ({
          username: payload.candidate?.raw?.user,
          transferId: readTransferId(transfer),
        }))
        .filter((entry) => entry.username && entry.transferId);
      await slskdClient
        .cleanupAfterRun({ searchIds: getPayloadSearchIds(payload), transfers })
        .catch((error: unknown) =>
          logger.warn("slskd", "Album transfer cleanup failed", {
            jobId: job.id,
            reason: safeLogDiagnostic(error),
          }),
        );
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
    const reason = slskdRoot
      ? `Downloaded file missing: ${predictSlskdLocalPathCandidates(slskdRoot, remoteFile)[0] || fileName}`
      : "Aurral doesn't know slskd's download folder. Check slskd under Settings → Status → Storage.";
    const nextPayload = retrySameCandidateOrNext(payload, job, "missing_file", reason, {
      transfer,
    });
    if (nextPayload) return nextPayload;
    return helpers.failOrTryNextSource(payload, job, reason);
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const finalPath = path.join(finalDir, finalName);
  const resolvedTrack = {
    ...attemptTrackRequest(job, await attemptRelease(payload, job), payload.track),
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
      expectedDurationMs: resolvedTrack.durationMs,
      actualDurationMs: validation.actualDurationMs ?? null,
      reason: validation.reason,
      remoteFile,
      sourcePath,
    });
    if (validation.blocked && !payload.heldForReview) {
      recordPayloadOutcome(
        job,
        payload,
        "held_for_review",
        validation.reason || "Held for review",
        { transfer, sourcePath, validation },
      );
      const heldPayload = {
        ...payload,
        heldForReview: holdForReview(job, {
          source: "slskd",
          sourcePath,
          reason: validation.reason,
          username: candidate?.raw?.user || null,
          transferId: readTransferId(transfer) || null,
        }),
      };
      return hasNextCandidate(payload)
        ? buildNextCandidatePayload(heldPayload, TRANSFER_RESET)
        : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
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
      : null;
    if (nextPayload) return nextPayload;
    return helpers.failOrTryNextSource(
      payload,
      job,
      validation.reason || "Download validation failed",
    );
  }
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const committed = await withPipelineCommitLock(payload, async () => {
    import("./aurralHistoryService.ts")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err: unknown) => {
        logger.warn("slskd", "Failed to record track job moving", {
          jobId: job.id,
          error: asAppError(err)?.message || String(err),
        });
      });
    const committedFinalPath = await commitDownloadedFile(sourcePath, finalPath);
    await writeImportedFileMetadata(committedFinalPath, resolvedTrack, {
      source: "slskd",
      jobId: job.id,
    });
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
      album: candidate?.resolvedAlbumName,
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

export async function discardSlskdSearch(payload: SlskdPayload) {
  if (!payload.activeSearch?.id || !slskdClient.isConfigured()) return;
  searchMonitors.delete(payload.activeSearch.id);
  await stopSearch(payload.activeSearch.id);
}

// The running search and queued transfers of a payload dropped before its
// step finished with them.
export async function discardSlskdWork(payload: SlskdPayload) {
  if (!slskdClient.isConfigured()) return;
  await discardSlskdSearch(payload);
  for (const transfer of [...(payload.albumTransfers || []), payload.legacyTransfer].filter(
    Boolean,
  )) {
    await cleanupTransferForPayload(payload, transfer);
  }
}

export async function discardSlskdDownload({
  sourcePath,
  transferId,
  username,
}: {
  sourcePath: string;
  transferId?: string | number | null;
  username?: string | null;
}) {
  await cleanupRejectedDownload({
    sourcePath,
    slskdRoot: resolveLocalPath(await slskdClient.getDownloadDirectory(), getPathMappings("slskd")),
    playlistRoot: resolveDownloadRoot(),
    transfer: transferId ? { id: String(transferId) } : null,
    username,
  });
}

export function processSlskdPipelinePayload(payload: SlskdPayload, helpers: SlskdHelpers) {
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
