import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { prowlarrClient } from "./prowlarrClient.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger } from "./logger.js";
import {
  buildUsenetSearchQueries,
  isAudioFile,
  isProwlarrMusicQuery,
  rankUsenetReleases,
  selectRankedUsenetCandidates,
} from "./downloadJobs/usenetReleaseSearch.js";
import {
  cacheSearchResults,
  getCachedSearchResults,
} from "./downloadJobs/searchResultCache.js";
import {
  selectVerifiedDownloadedFile,
} from "./trackMatching/index.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildResolvedJobTrack as buildResolvedTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeImportedFileMetadata,
} from "./downloadUtils.js";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.js";
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
} from "./downloadJobs/downloadCancellation.js";
import { getQualityProfile } from "./qualityProfileService.js";
import { orderAdvertisedQualityCandidates } from "./qualityProfileModel.js";
import { albumGrabJobs, deniedAlbumSources, finishAlbumGrab } from "./albumGrab.js";
import { isCompilationJobs } from "./albumReleases.js";

const MIN_USENET_CANDIDATES = 2;
const MAX_DOWNLOAD_CANDIDATES = 5;
const POLL_DELAY_SECONDS = 5;
const MAX_MISSING_POLLS = 60;

function getUsenetClient(preferredKey = null) {
  if (["sabnzbd", "nzbget"].includes(preferredKey)) {
    return getDownloadClient(preferredKey);
  }
  const sabnzbd = getDownloadClient("sabnzbd");
  if (sabnzbd.isConfigured()) return sabnzbd;
  return getDownloadClient("nzbget");
}

function getUsenetClientKey(preferredKey = null) {
  return getUsenetClient(preferredKey).key;
}

// Both clients drop the queue and history entry. SABnzbd also deletes the
// job's files; NZBGet does with deleteFiles, unless its setting is off.
async function removeUsenetItem(payload, jobId, options = {}) {
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
  for (const [entry, remove] of [
    ["queue", () => client.deleteQueueItem(payload.nzbId)],
    ["history", () => client.deleteHistoryItem(payload.nzbId, options)],
  ]) {
    await remove().catch((error) => {
      logger.warn("usenet", `Could not remove the ${client.key} ${entry} item`, {
        jobId,
        reason: error?.message || String(error),
      });
    });
  }
}

// A song held for review keeps its release until it is approved, denied, or removed.
export async function removeReviewedUsenetDownload(job) {
  if (job?.downloadSource !== "usenet" || !job.downloadClientId) return;
  await removeUsenetItem(
    { downloadClient: job.downloadClient, nzbId: job.downloadClientId },
    job.id,
    { deleteFiles: true },
  );
}

const RELEASE_RESET = Object.freeze({ nzbId: null, history: null, missingPolls: 0 });

// A release that failed or held no matching file is blocked for every track
// it was meant to fill.
function blockRelease(payload, job) {
  const guid = String(getPayloadCandidate(payload)?.raw?.release?.guid || "").trim();
  if (!guid) return;
  const jobs = payload.albumGrab === true ? albumGrabJobs(payload) : [job];
  for (const entry of jobs) downloadTracker.recordDeniedSource(entry.id, "usenet", guid);
}

function hasEnoughCandidates(aggregated, resolvedTrack, qualityOptions, albumGrab) {
  const ranked = rankUsenetReleases(aggregated, resolvedTrack).filter(
    (entry) => entry.releaseAdmissible && (!albumGrab || entry.resolvedAlbumName),
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

export async function collectDownloadedAudioFiles(historyItem, preferredClient = null) {
  const clientKey = getUsenetClientKey(preferredClient);
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

async function validateDownloadedRelease(audioFilePaths, candidate, resolvedTrack, options = {}) {
  // Post-download identity is decided by the shared engine: downloaded files
  // are assigned to the expected tracklist with the native matcher
  // and validated individually against the requested track.
  return selectVerifiedDownloadedFile({
    request: resolvedTrack,
    filePaths: audioFilePaths,
    candidate,
    source: "usenet",
    options,
  });
}

const releaseKey = (release) => [release.guid, release.downloadUrl, release.indexerId, release.title]
  .map((entry) => String(entry || "").trim().toLowerCase())
  .join("\0");

// One Prowlarr query per pipeline step, so a slow indexer never holds the
// pipeline for the whole search plan.
async function advanceUsenetSearch(payload, queries, enough, runQuery) {
  const aggregated = [];
  const seen = new Set();
  let index = Number(payload.searchQueryIndex || 0);
  for (let queryIndex = 0; queryIndex < index; queryIndex += 1) {
    const cached = getCachedSearchResults("usenet", queries[queryIndex]);
    if (!cached) {
      index = queryIndex;
      break;
    }
    mergeSearchResults(aggregated, seen, cached, releaseKey);
  }
  let searchError = payload.searchError || "";
  let searched = false;
  while (index < queries.length && !enough(aggregated)) {
    if (searched) {
      return { payload: { ...payload, searchQueryIndex: index, searchError, delaySeconds: 0 } };
    }
    const query = queries[index];
    let releases = getCachedSearchResults("usenet", query);
    if (!releases) {
      searched = true;
      try {
        releases = await runQuery(query);
        cacheSearchResults("usenet", query, releases);
      } catch (error) {
        searchError = error?.message || String(error);
        logger.warn("usenet", "Prowlarr search failed", {
          jobId: payload.jobId,
          query,
          error: searchError,
        });
        releases = [];
        cacheSearchResults("usenet", query, releases);
      }
    }
    mergeSearchResults(aggregated, seen, releases, releaseKey);
    index += 1;
  }
  return { aggregated, queryCount: index, searchError };
}

async function handleUsenetSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (!payload.searchQueries) {
    downloadTracker.setDownloading(job.id);
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: "usenet",
    });
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
      .catch((err) => { console.warn(err); });
  }

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
  const albumGrab = payload.albumGrab === true;
  const albumJobs = albumGrab ? albumGrabJobs(payload) : [];
  const compilation = albumGrab && isCompilationJobs([job, ...albumJobs]);
  const indexers = await prowlarrClient.getEnabledUsenetIndexers().catch(() => []);
  const musicIndexers = indexers.filter((indexer) => indexer.musicSearch);
  const searchContext = { ...resolvedTrack, compilation };
  const queries = payload.searchQueries || buildUsenetSearchQueries(
    searchContext,
    { musicSearch: musicIndexers.length > 0, albumGrab },
  );
  const runQuery = (query) => (isProwlarrMusicQuery(query)
    ? prowlarrClient.search(query, { type: "music", indexers: musicIndexers })
    : prowlarrClient.search(query));
  const deniedSourceGuidSet = deniedAlbumSources([job, ...albumJobs], "usenet");
  const allowed = (releases) => releases.filter((release) =>
    !deniedSourceGuidSet.has(String(release.guid || "").trim().toLowerCase()));
  const step = await advanceUsenetSearch(
    { ...payload, searchQueries: queries },
    queries,
    (results) => hasEnoughCandidates(allowed(results), searchContext, qualityOptions, albumGrab),
    runQuery,
  );
  if (!isPipelinePayloadActive(payload)) return null;
  if (step.payload) return step.payload;
  const aggregated = allowed(step.aggregated);
  const lastError = step.searchError;
  const queryCount = step.queryCount;
  const ranked = rankUsenetReleases(aggregated, searchContext);
  const filteredRanked = deniedSourceGuidSet.size > 0
    ? ranked.filter((entry) => !deniedSourceGuidSet.has(String(entry?.raw?.guid || "").trim().toLowerCase()))
    : ranked;
  const qualityRanked = orderAdvertisedQualityCandidates(
    filteredRanked.filter((entry) => entry.releaseAdmissible
      && (payload.albumGrab !== true || entry.resolvedAlbumName)),
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
      queryCount,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
    });
  }
  return {
    ...payload,
    searchQueries: null,
    searchQueryIndex: 0,
    searchError: null,
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

  const client = getUsenetClient(payload.manualDownloadClient);
  const clientKey = getUsenetClientKey(payload.manualDownloadClient);
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
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
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
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
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
      await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
      blockRelease(payload, job);
      if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
      return helpers.failOrTryNextSource(
        payload,
        job,
        `Usenet download failed: ${historyItem.Status || historyItem.status || "failed"}`,
      );
    }
  }
  // A queued, paused, slow, or post-processing download keeps waiting like it
  // would in Lidarr. Only a download that left both the queue and the history
  // moves on.
  const present = Boolean(historyItem) || Boolean(await client.getQueueItem(payload.nzbId));
  const missingPolls = present ? 0 : Number(payload.missingPolls || 0) + 1;
  if (missingPolls > MAX_MISSING_POLLS) {
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
    return helpers.failOrTryNextSource(payload, job, "The Usenet download left the download client");
  }
  return {
    ...payload,
    phase: "poll",
    delaySeconds: POLL_DELAY_SECONDS,
    pollAttempts,
    missingPolls,
  };
}

async function handleUsenetFinalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidate = getPayloadCandidate(payload);
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
  const historyItem = payload.history || (await client.getHistoryItem(payload.nzbId));
  if (payload.albumGrab === true) {
    const filePaths = await collectDownloadedAudioFiles(
      historyItem, payload.downloadClient || payload.manualDownloadClient,
    );
    const next = await finishAlbumGrab(payload, {
      filePaths, source: "usenet", album: candidate?.resolvedAlbumName || job.albumName,
      resetFields: RELEASE_RESET,
    });
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
    return next;
  }
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const audioFiles = await collectDownloadedAudioFiles(
    historyItem,
    payload.downloadClient || payload.manualDownloadClient,
  );
  const found = await validateDownloadedRelease(
    audioFiles,
    candidate,
    resolvedTrack,
    { manualSelection: payload.manualSelection === true },
  );
  if (!isPipelinePayloadActive(payload)) {
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
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
    const reason = found.validation?.reason
      || "Usenet download completed, but no matching audio file was found";
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
    if (audioFiles.length > 0) blockRelease(payload, job);
    if (hasNextCandidate(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const playlistRoot = resolveDownloadRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(found.filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const finalPath = path.join(finalDir, finalName);
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const committed = await withPipelineCommitLock(payload, async () => {
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => { console.warn(err); });
    const committedFinalPath = await commitDownloadedFile(
      found.filePath,
      finalPath,
    );
    await writeImportedFileMetadata(committedFinalPath, resolvedTrack, {
      source: "usenet",
      jobId: job.id,
    });
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
  await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
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
