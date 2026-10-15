import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import {
  buildSourceCandidates,
  hasUsableSearchCandidates,
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "./trackMatching/index.js";
import {
  buildDeemixAlbumSearchQueries,
  buildDeemixSearchQueries,
  isSameCoreAlbum,
} from "./downloadJobs/deemixSearch.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import {
  buildResolvedJobTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeAudioMetadata,
} from "./downloadUtils.js";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.js";
import { getQualityProfile } from "./qualityProfileService.js";
import { isQualityUpgrade } from "./qualityProfileModel.js";
import { deemixQueueIds, readDeemixAlbumQueue } from "./deemixClient.js";
import {
  albumGrabJobs,
  continueAlbumGrab,
  deniedAlbumSources,
  finishAlbumGrab,
} from "./albumGrab.js";
import { attemptTrackRequest, mapRequest } from "./releaseManifest.js";
import { attemptRelease } from "./releaseResolver.js";
import { judgeRelease } from "./trackMatching/releaseJudge.js";
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

const SEARCH_LIMIT = 10;
const MAX_ALBUM_CANDIDATES = 3;
const ALBUM_QUEUE_RESET = Object.freeze({ queueUuid: null, queueUuids: null, downloadedPaths: null });
const POLL_DELAY_SECONDS = 3;
const MAX_POLL_ATTEMPTS = 200;

function getDeemixClient() {
  return getDownloadClient("deemix");
}

// A release candidate queues the whole album only when every track of the
// release is wanted, and otherwise each wanted track by its own URL.
const queuesAlbum = (payload, candidate) => payload.albumGrab === true && candidate?.kind !== "tracks";
const queuesTracks = (payload, candidate) => payload.albumGrab === true && candidate?.kind === "tracks";

// A later candidate of an attempt wants only the tracks no earlier one
// imported, so it may no longer want every track of the release.
function stillWanted(payload, candidate) {
  const listed = Array.isArray(candidate?.raw?.tracks) ? candidate.raw.tracks : [];
  const wanted = new Set(albumGrabJobs(payload).map((job) => job.id));
  const tracks = listed.filter((track) => wanted.has(track.jobId));
  return candidate?.kind === "album" && tracks.length === listed.length
    ? candidate
    : { ...candidate, kind: "tracks", raw: { ...candidate.raw, tracks } };
}
async function removeQueued(payload, message) {
  for (const uuid of deemixQueueIds(payload)) {
    await getDeemixClient().removeFromQueue(uuid).catch((error) => {
      logger.warn("deemix", message, { jobId: payload.jobId, reason: safeLogDiagnostic(error) });
    });
  }
}

export async function discardDeemixWork(payload) {
  await removeQueued(payload, "Could not remove a dropped queue item");
}

function hasEnoughCandidates(aggregated, resolvedTrack) {
  // Availability is provider-specific evidence the shared engine never sees.
  const availableResults = aggregated.filter((result) => result?.readable !== false);
  // Node-only pre-filter: no matcher process is spawned during searches.
  return hasUsableSearchCandidates({
    source: "deemix",
    results: availableResults,
    request: resolvedTrack,
  });
}

// The configured bitrate fixes the tier, so an upgrade that deemix cannot
// improve on is refused before the download rather than after validation.
function readUnusableUpgradeTier(upgradeForJobId, manualReplacementSearch = false) {
  if (!upgradeForJobId || manualReplacementSearch) return null;
  const tier = getDeemixClient().getQualityTierId();
  const currentTier = downloadTracker.getJob(upgradeForJobId)?.qualityTier || null;
  if (isQualityUpgrade({ tier }, currentTier, getQualityProfile())) return null;
  return `deemix downloads ${tier || "an unknown tier"}, which is not an upgrade over ${
    currentTier || "the current file"
  }`;
}

function readQueuedRemotePath(queueItem) {
  const files = Array.isArray(queueItem?.files) ? queueItem.files : [];
  return files.map((file) => String(file?.path || "").trim()).find(Boolean) || "";
}

function readQueuedFilePath(queueItem) {
  const remotePath = readQueuedRemotePath(queueItem);
  return remotePath ? resolveLocalPath(remotePath, getPathMappings("deemix")) : "";
}

function readQueueError(queueItem) {
  const errors = Array.isArray(queueItem?.errors) ? queueItem.errors : [];
  for (const error of errors) {
    const message = String(error?.error || error?.message || error || "").trim();
    if (message) return message;
  }
  return "";
}

function deemixListing(album, tracks) {
  return {
    artistLabel: album.artist || null,
    albumLabel: album.title,
    files: tracks.map((track) => ({
      title: track.title,
      artists: [track.artist].filter(Boolean),
      durationMs: track.durationSec > 0 ? track.durationSec * 1000 : null,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
    })),
  };
}

// The Deezer track to download for each wanted place: a copy Deezer can
// stream. A place with none makes the album unusable.
function wantedTracks(verdict, tracks, wanted) {
  const picked = [];
  for (const [trackIndex, jobId] of wanted) {
    const track = verdict.copiesForTrack[trackIndex].map((index) => tracks[index])
      .find((entry) => entry.readable !== false);
    if (!track) return null;
    picked.push({ ...track, jobId });
  }
  return picked;
}

// Album searches until one finds a same-titled album whose whole tracklist
// is the requested release; nothing is queued before that check. Unreadable
// tracks still count toward the tracklist.
async function searchDeemixAlbum(payload, helpers, job, client, manifest) {
  const jobs = albumGrabJobs(payload);
  const { wanted } = mapRequest(manifest, jobs);
  if (wanted.size === 0) return helpers.failOrTryNextSource(payload, job, "No wanted track is on the requested release");
  const denied = deniedAlbumSources([job, ...jobs], "deemix");
  const checked = new Set();
  const ranked = [];
  let searchFailed = false;
  const albumName = manifest.title || job.albumName;
  const queries = buildDeemixAlbumSearchQueries({
    ...buildResolvedJobTrack(job), albumName, compilation: manifest.compilation,
  });
  for (const query of queries) {
    let albums = [];
    try {
      albums = await client.searchAlbums(query, { limit: SEARCH_LIMIT });
    } catch (error) {
      searchFailed = true;
      logger.warn("deemix", "Album search failed", { jobId: job.id, reason: safeLogDiagnostic(error) });
    }
    if (!isPipelinePayloadActive(payload)) return null;
    const fresh = albums.filter((album) => !checked.has(album.id)
      && !denied.has(`album:${album.id}`) && isSameCoreAlbum(album.title, albumName));
    for (const album of fresh.slice(0, MAX_ALBUM_CANDIDATES)) {
      checked.add(album.id);
      let tracks;
      try {
        tracks = await client.getAlbumTracks(album.id);
      } catch (error) {
        searchFailed = true;
        logger.warn("deemix", "Album tracklist failed", { jobId: job.id, reason: safeLogDiagnostic(error) });
        continue;
      }
      if (!isPipelinePayloadActive(payload)) return null;
      const verdict = judgeRelease(manifest, deemixListing(album, tracks));
      const picked = verdict.kind === "exact" ? wantedTracks(verdict, tracks, wanted) : null;
      if (picked) ranked.push({ album, picked, fit: verdict.fit });
    }
    if (ranked.length > 0) break;
  }
  ranked.sort((left, right) => right.fit - left.fit);
  if (ranked.length === 0) {
    return helpers.failOrTryNextSource(payload, job, searchFailed
      ? "deemix album search failed or found no exact release"
      : "No exact deemix album release");
  }
  const albumRaw = (album) => ({ albumId: album.id, albumUrl: album.url, album: album.title, artist: album.artist });
  const kind = wanted.size < manifest.tracks.length ? "tracks" : "album";
  return {
    ...payload, source: "deemix", phase: "download", candidateIndex: 0,
    candidates: ranked.map(({ album, picked }) => ({
      kind,
      raw: { ...albumRaw(album), tracks: picked.map((track) => ({ id: track.id, url: track.url, jobId: track.jobId })) },
      resolvedAlbumName: album.title,
      releaseVerified: true,
    })),
  };
}

async function handleDeemixSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const unusableUpgrade = readUnusableUpgradeTier(
    payload.upgradeForJobId,
    payload.manualReplacementSearch === true,
  );
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
      logger.warn("deemix", "Could not record search history", {
        jobId: job.id,
        reason: safeLogDiagnostic(err),
      });
    });

  const release = await attemptRelease(payload, job);
  const resolvedTrack = {
    ...attemptTrackRequest(job, release, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const client = getDeemixClient();
  if (payload.albumGrab === true) return searchDeemixAlbum(payload, helpers, job, client, release);
  const queries = buildDeemixSearchQueries(resolvedTrack);
  const deniedIds = new Set(
    (Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [])
      .filter((entry) => Array.isArray(entry) && entry[0] === "deemix")
      .map((entry) => String(entry[1] || "").trim()),
  );
  const aggregated = [];
  const seen = new Set();
  let lastError = "";
  for (const query of queries) {
    if (hasEnoughCandidates(aggregated, resolvedTrack)) break;
    try {
      const results = await client.search(query, { limit: SEARCH_LIMIT });
      mergeSearchResults(aggregated, seen, results.filter((entry) => !deniedIds.has(String(entry.id || "").trim())
        && !deniedIds.has(`album:${entry.albumId}`)), (entry) => String(entry.id || "").trim());
    } catch (error) {
      lastError = safeLogDiagnostic(error);
      logger.warn("deemix", "deemix search failed", {
        jobId: job.id,
        query: safeLogDiagnostic(query),
        error: lastError,
      });
    }
  }

  // Availability is provider-specific evidence the shared engine never sees.
  const availableResults = aggregated.filter((result) => result?.readable !== false);
  const evaluation = await buildSourceCandidates({
    source: "deemix",
    results: availableResults,
    request: resolvedTrack,
  });
  const candidates = usableEvaluationEntries(evaluation)
    .filter((entry) => !deniedIds.has(String(entry.candidate?.provider?.id || "").trim()))
    .map(toPipelineCandidate);
  if (candidates.length === 0) {
    const message =
      lastError && aggregated.length === 0
        ? `deemix search failed: ${lastError}`
        : "No suitable deemix search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: evaluation.evaluations.length,
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

// The wanted tracks of an exact release, each queued by its own URL, so no
// track the request does not want is downloaded.
async function queueReleaseTracks(payload, helpers, job, candidate) {
  const tracks = Array.isArray(candidate.raw?.tracks) ? candidate.raw.tracks : [];
  const queued = [];
  let submission;
  try {
    submission = await withPipelineCommitLock(payload, async () => {
      for (const track of tracks) queued.push(await getDeemixClient().addToQueue(track.url, track.id));
      downloadTracker.updateDownloadMetadata(job.id, {
        downloadSource: "deemix",
        downloadClient: "deemix",
        downloadClientId: queued[0],
        releaseGuid: `album:${candidate.raw.albumId}`,
        releaseTitle: candidate.raw.album,
        remoteUsername: candidate.raw.artist,
      });
      return queued;
    });
  } catch (error) {
    await removeQueued({ jobId: payload.jobId, queueUuids: queued }, "Could not remove a queued release track");
    logger.warn("deemix", "deemix queue submission failed", { jobId: job.id, error: safeLogDiagnostic(error) });
    return continueAlbumGrab(payload, ALBUM_QUEUE_RESET) || helpers.failOrTryNextSource(payload, job,
      safeLogDiagnostic(error));
  }
  if (submission.cancelled || !isPipelinePayloadActive(payload)) {
    await removeQueued({ jobId: payload.jobId, queueUuids: queued }, "Could not remove a queued release track");
    return null;
  }
  return { ...payload, phase: "poll", source: "deemix", candidate, queueUuid: null, queueUuids: queued, pollAttempts: 0 };
}

async function pollReleaseTracks(payload, helpers, job, pollAttempts) {
  const items = [];
  for (const uuid of payload.queueUuids || []) {
    try {
      items.push(await getDeemixClient().getQueueItem(uuid));
    } catch (error) {
      logger.warn("deemix", "deemix queue poll failed", { jobId: job.id, uuid: safeLogDiagnostic(uuid),
        error: safeLogDiagnostic(error) });
      return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
    }
  }
  const waiting = items.some((item) => !item || ["inQueue", "downloading"].includes(String(item.status || "")));
  if (waiting) return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
  const downloadedPaths = items.map(readQueuedRemotePath).filter(Boolean);
  if (downloadedPaths.length > 0) return { ...payload, phase: "finalize", downloadedPaths, pollAttempts };
  await removeQueued(payload, "Could not remove a failed release track");
  return continueAlbumGrab(payload, ALBUM_QUEUE_RESET) || helpers.failOrTryNextSource(payload, job,
    safeLogDiagnostic(items.map(readQueueError).find(Boolean) || "deemix release tracks failed"));
}

async function handleDeemixDownload(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const listed = candidates[index];
  const candidate = payload.albumGrab === true && Array.isArray(listed?.raw?.tracks) ? stillWanted(payload, listed) : listed;
  const albumQueue = queuesAlbum(payload, candidate);
  if (queuesTracks(payload, candidate)) return queueReleaseTracks(payload, helpers, job, candidate);
  const url = albumQueue ? candidate?.raw?.albumUrl : candidate?.raw?.url;
  if (!url) {
    return helpers.failOrTryNextSource(payload, job, "No deemix track URL available");
  }
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => {
      logger.warn("deemix", "Could not record download history", {
        jobId: job.id,
        reason: safeLogDiagnostic(err),
      });
    });

  const client = getDeemixClient();
  let submission;
  try {
    submission = await withPipelineCommitLock(payload, async () => {
      const queueUuid = albumQueue
        ? await client.addAlbumToQueue(url, candidate.raw.albumId)
        : await client.addToQueue(url, candidate.raw.id);
      downloadTracker.updateDownloadMetadata(job.id, {
        downloadSource: "deemix",
        downloadClient: "deemix",
        downloadClientId: queueUuid,
        releaseGuid: albumQueue ? `album:${candidate.raw.albumId}` : candidate.raw.id,
        releaseTitle: candidate.raw.album || candidate.raw.title,
        remoteUsername: candidate.raw.artist,
        remoteFilename: candidate.raw.file,
      });
      return queueUuid;
    });
  } catch (error) {
    const message = safeLogDiagnostic(error);
    logger.warn("deemix", "deemix queue submission failed", {
      jobId: job.id,
      error: message,
    });
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, message);
  }

  if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
  const queueUuid = submission.result;

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
    await removeQueued(payload, "Could not remove timed-out queue item");
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, payload.albumGrab === true ? ALBUM_QUEUE_RESET : { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, "deemix polling timed out");
  }
  if (queuesTracks(payload, getPayloadCandidate(payload))) return pollReleaseTracks(payload, helpers, job, pollAttempts);

  let queueItem;
  try {
    queueItem = await client.getQueueItem(payload.queueUuid);
  } catch (error) {
    logger.warn("deemix", "deemix queue poll failed", {
      jobId: job.id,
      uuid: safeLogDiagnostic(payload.queueUuid),
      error: safeLogDiagnostic(error),
    });
    return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
  }

  const status = String(queueItem?.status || "").trim();
  if (queuesAlbum(payload, getPayloadCandidate(payload))) {
    const albumQueue = readDeemixAlbumQueue(queueItem);
    if (!albumQueue.finished) {
      return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
    }
    if (albumQueue.filePaths.length > 0) {
      return { ...payload, phase: "finalize", downloadedPaths: albumQueue.filePaths,
        albumFailedCount: albumQueue.failedCount, pollAttempts };
    }
    await client.removeFromQueue(payload.queueUuid).catch(() => {});
    return continueAlbumGrab(payload, ALBUM_QUEUE_RESET) || helpers.failOrTryNextSource(payload, job,
      safeLogDiagnostic(readQueueError(queueItem) || `deemix album ${status || "failed"}`));
  }
  if (!queueItem || status === "inQueue" || status === "downloading") {
    return { ...payload, phase: "poll", delaySeconds: POLL_DELAY_SECONDS, pollAttempts };
  }
  const downloadedPath = readQueuedFilePath(queueItem);
  if (!downloadedPath) {
    await client.removeFromQueue(payload.queueUuid).catch((error) => {
      logger.warn("deemix", "Could not remove failed queue item", {
        jobId: job.id,
        reason: safeLogDiagnostic(error),
      });
    });
    const reason = safeLogDiagnostic(readQueueError(queueItem) || `deemix download ${status || "failed"}`);
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }
  return { ...payload, phase: "finalize", downloadedPath, pollAttempts };
}

async function handleDeemixFinalize(payload, helpers) {
  if (payload.albumGrab === true) {
    const filePaths = (payload.downloadedPaths || []).map((remote) =>
      resolveLocalPath(remote, getPathMappings("deemix")));
    try {
      return await finishAlbumGrab(payload, {
        filePaths, source: "deemix", resetFields: ALBUM_QUEUE_RESET,
      });
    } finally {
      await removeQueued(payload, "Could not remove completed album queue item");
    }
  }
  // deemix derives the queue uuid from the track and bitrate, so a finished entry
  // left behind makes the next request match it instead of downloading again.
  // Dropping it once here covers every exit below, a job held for review included.
  await getDeemixClient()
    .removeFromQueue(payload.queueUuid)
    .catch((error) => {
      logger.warn("deemix", "Could not remove completed queue item", {
        jobId: payload.jobId,
        reason: safeLogDiagnostic(error),
      });
    });
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidate = getPayloadCandidate(payload);
  const resolvedTrack = {
    ...attemptTrackRequest(job, await attemptRelease(payload, job), payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const filePath = String(payload.downloadedPath || "").trim();
  const exists = filePath ? await fs.stat(filePath).catch(() => null) : null;
  if (!exists?.isFile()) {
    const reason = filePath
      ? `deemix download is not readable at ${filePath}. Add a path mapping for deemix in Settings.`
      : "deemix finished without an audio file";
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null, downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const validation = await validateDownloadedTrackFile({
    request: resolvedTrack,
    candidate: candidate?.candidate || candidate,
    filePath,
    source: "deemix",
    options: {
      strict: candidate?.evaluation?.decision !== "accept",
      manualSelection: payload.manualSelection === true,
    },
  });
  if (!isPipelinePayloadActive(payload)) {
    return null;
  }
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
    downloadTracker.recordDeniedSource(job.id, "deemix", candidate?.raw?.id);
    const reason = safeLogDiagnostic(validation.reason || "deemix download failed track validation");
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { queueUuid: null, downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const playlistRoot = resolveDownloadRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".flac");
  const finalPath = path.join(finalDir, finalName);
  const committed = await withPipelineCommitLock(payload, async () => {
    await writeAudioMetadata(filePath, resolvedTrack);
    import("./aurralHistoryService.js")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => {
        logger.warn("deemix", "Could not record file move history", {
          jobId: job.id,
          reason: safeLogDiagnostic(err),
        });
      });
    const committedFinalPath = await commitDownloadedFile(filePath, finalPath, {
      reuseExisting: !payload.upgradeForJobId,
    });
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      album: candidate?.resolvedAlbumName || job.albumName,
      quality: validation.quality,
    });
  });
  if (committed.cancelled) {
    return null;
  }
  return committed.result;
}

export async function processDeemixPipelinePayload(payload, helpers = {}) {
  logger.debug("deemix", "deemix pipeline phase", {
    phase: payload.phase,
    jobId: payload.jobId,
    source: payload.source,
  });
  if (!isPipelinePayloadActive(payload)) {
    await removeQueued(payload, "Could not remove a cancelled queue item");
    return null;
  }
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
