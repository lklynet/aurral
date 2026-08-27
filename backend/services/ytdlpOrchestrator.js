import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";
import { logger } from "./logger.js";
import { validateDownloadedTrack } from "./weeklyFlow/weeklyFlowSoulseekMatcher.js";
import {
  buildYtdlpSearchQueries,
  rankYtdlpResults,
} from "./weeklyFlow/weeklyFlowYtdlpMatcher.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
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

const ytdlpClient = getDownloadClient("ytdlp");

function hasEnoughCandidates(aggregated, resolvedTrack) {
  return rankYtdlpResults(aggregated, resolvedTrack).some((entry) => entry.preDownloadValid);
}

async function handleYtdlpSearch(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
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
  const queries = buildYtdlpSearchQueries(resolvedTrack);
  const aggregated = [];
  const seen = new Set();
  let lastError = "";
  for (const query of queries) {
    if (hasEnoughCandidates(aggregated, resolvedTrack)) break;
    try {
      const results = await ytdlpClient.search(query, { limit: 5 });
      mergeSearchResults(aggregated, seen, results, (entry) =>
        String(entry.id || entry.url || "").trim().toLowerCase(),
      );
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn("ytdlp", "yt-dlp search failed", {
        jobId: job.id,
        query,
        error: lastError,
      });
    }
  }

  const ranked = rankYtdlpResults(aggregated, resolvedTrack);
  const deniedIds = new Set(
    (Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [])
      .filter((entry) => Array.isArray(entry) && entry[0] === "ytdlp")
      .map((entry) => String(entry[1] || "").trim()),
  );
  const candidates =
    deniedIds.size > 0
      ? ranked.filter((entry) => !deniedIds.has(String(entry?.raw?.id || "").trim()))
      : ranked;
  if (candidates.length === 0) {
    const message =
      lastError && aggregated.length === 0
        ? `yt-dlp search failed: ${lastError}`
        : "No suitable yt-dlp search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount: queries.length,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
    });
  }
  return {
    ...payload,
    phase: "download",
    source: "ytdlp",
    candidates,
    candidateIndex: 0,
    resolvedTrack,
  };
}

async function handleYtdlpDownload(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  const url = candidate?.raw?.url;
  if (!url) {
    return helpers.failOrTryNextSource(payload, job, "No yt-dlp video URL available");
  }
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => {
      console.warn(err);
    });

  let downloaded;
  try {
    downloaded = await ytdlpClient.downloadAudio(url, { jobId: job.id });
  } catch (error) {
    const message = error?.message || String(error);
    logger.warn("ytdlp", "yt-dlp download failed", {
      jobId: job.id,
      url,
      error: message,
    });
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, message);
  }

  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
    releaseGuid: candidate.raw.id,
    releaseTitle: candidate.raw.title,
    remoteUsername: candidate.raw.channel,
    remoteFilename: candidate.raw.title,
  });

  return {
    ...payload,
    phase: "finalize",
    source: "ytdlp",
    candidate,
    candidateIndex: index,
    downloadedPath: downloaded.filePath,
  };
}

async function handleYtdlpFinalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidate = getPayloadCandidate(payload);
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const filePath = String(payload.downloadedPath || "").trim();
  if (!filePath) {
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, "yt-dlp download missing output file");
  }

  const validation = await validateDownloadedTrack(
    filePath,
    {
      ...candidate,
      raw: {
        ...(candidate?.raw || {}),
        file: candidate?.raw?.title || filePath,
      },
    },
    resolvedTrack,
  );
  if (!validation.valid) {
    const reviewable =
      validation.blocked || validation.scores?.matchReason === "weak-title-match";
    if (reviewable && blockPipelineJobForReview({
      downloadTracker,
      job,
      validation: { ...validation, blocked: true },
      sourcePath: filePath,
    })) {
      return null;
    }
    await fs.rm(filePath, { force: true }).catch(() => {});
    await ytdlpClient.cleanupStaging(job.id);
    const reason = validation.reason || "yt-dlp download failed track validation";
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { downloadedPath: null });
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
  const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".m4a"}`;
  const finalPath = path.join(finalDir, finalName);
  const committedFinalPath = await commitImportToPlaylistLibrary(filePath, finalPath);
  await ytdlpClient.cleanupStaging(job.id);
  return finalizePipelineJobSuccess({
    downloadTracker,
    job,
    committedFinalPath,
    album: candidate?.resolvedAlbumName || job.albumName,
    quality: validation.quality,
  });
}

export async function processYtdlpPipelinePayload(payload, helpers = {}) {
  logger.debug("ytdlp", "ytdlp pipeline phase", {
    phase: payload.phase,
    jobId: payload.jobId,
    source: payload.source,
  });
  switch (payload.phase) {
    case "search":
      return handleYtdlpSearch(payload, helpers);
    case "download":
      return handleYtdlpDownload(payload, helpers);
    case "finalize":
      return handleYtdlpFinalize(payload, helpers);
    default:
      throw new Error(`Unknown yt-dlp pipeline phase: ${payload.phase}`);
  }
}
