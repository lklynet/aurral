import path from "path";
import fs from "fs/promises";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import { asAppError } from "../../lib/errors.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { logger } from "./logger.ts";
import type { YtdlpClient } from "./ytdlpClient.ts";
import {
  buildSourceCandidates,
  prefilterCandidates,
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "./trackMatching/index.ts";
import { readYoutubeUpload } from "./trackMatching/youtubeEvidence.ts";
import { buildYtdlpSearchQueries } from "./downloadJobs/ytdlpSearch.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import {
  buildResolvedJobTrack as buildResolvedTrack,
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeAudioMetadata,
} from "./downloadUtils.ts";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.ts";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  holdForReview,
  finalizePipelineJobSuccess,
} from "./pipelineHelpers.ts";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.ts";

const ytdlpClient = getDownloadClient("ytdlp");
const SONG_READS = 6;
const LIVE_STATUSES = new Set(["is_live", "was_live", "post_live", "is_upcoming"]);

type YtdlpResult = Awaited<ReturnType<YtdlpClient["search"]>>[number];
type YtdlpCandidate = Omit<ReturnType<typeof toPipelineCandidate>, "raw"> & { raw: YtdlpResult };

type YtdlpPayload = {
  jobId: string;
  phase: string;
  source?: string | null;
  playlistId?: string | null;
  track?: Parameters<typeof buildResolvedTrack>[1];
  destination?: string | null;
  upgradeForJobId?: string | null;
  manualSelection?: boolean;
  candidates?: YtdlpCandidate[];
  candidate?: YtdlpCandidate | null;
  candidateIndex?: number;
  downloadedPath?: string | null;
  heldForReview?: ReturnType<typeof holdForReview> | null;
};

type YtdlpHelpers = {
  failOrTryNextSource: (
    payload: YtdlpPayload,
    job: DownloadJob,
    message: string,
    logDetails?: Record<string, number>,
  ) => Promise<unknown>;
};
type YtdlpSearchOptions = NonNullable<Parameters<YtdlpClient["search"]>[1]>;

export function isYtdlpLiveResult(result: YtdlpResult) {
  return LIVE_STATUSES.has(
    String(result?.liveStatus || "")
      .trim()
      .toLowerCase(),
  );
}

// The release audio on the artist's channel is the copy to download, so the
// next query runs until a usable one turns up.
export function hasEnoughCandidates(
  aggregated: YtdlpResult[],
  resolvedTrack: ReturnType<typeof buildResolvedTrack>,
) {
  const artistNames = [resolvedTrack.artistName, ...(resolvedTrack.artistAliases || [])].filter(
    Boolean,
  );
  return prefilterCandidates({
    source: "ytdlp",
    candidates: aggregated.filter((result) => !isYtdlpLiveResult(result)),
    request: resolvedTrack,
  }).some(
    (entry) =>
      !entry.rejected &&
      readYoutubeUpload(entry.candidate.title, entry.candidate.provider?.uploader, artistNames)
        .officialAudio,
  );
}

async function handleYtdlpSearch(payload: YtdlpPayload, helpers: YtdlpHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: "ytdlp",
    downloadClient: "ytdlp",
  });
  import("./aurralHistoryService.ts")
    .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
    .catch((err) => {
      console.warn(err);
    });

  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const { queries, fallbackQuery } = buildYtdlpSearchQueries(resolvedTrack);
  const deniedIds = new Set(
    (Array.isArray(job.deniedRemoteSources) ? job.deniedRemoteSources : [])
      .filter((entry) => Array.isArray(entry) && entry[0] === "ytdlp")
      .map((entry) => String(entry[1] || "").trim()),
  );
  const found: Record<"songs" | "videos", YtdlpResult[]> = { songs: [], videos: [] };
  const seen: Record<"songs" | "videos", Set<string>> = {
    songs: new Set(),
    videos: new Set(),
  };
  const resultKey = (entry: YtdlpResult) =>
    String(entry.id || entry.url || "")
      .trim()
      .toLowerCase();
  let lastError = "";
  const searchOnce = async (
    kind: "songs" | "videos",
    query: string,
    options: YtdlpSearchOptions,
  ) => {
    try {
      const results: YtdlpResult[] = await ytdlpClient.search(query, options);
      mergeSearchResults(
        found[kind],
        seen[kind],
        results.filter((entry) => !deniedIds.has(String(entry.id || "").trim())),
        resultKey,
      );
    } catch (error) {
      lastError = asAppError(error)?.message || String(error);
      logger.warn("ytdlp", "yt-dlp search failed", {
        jobId: job.id,
        query,
        error: lastError,
      });
    }
  };
  // A song id is also a video id. Once videos are searched, a video replaces
  // the song with its id, so a song judged off the requested album can still
  // win as the artist's own upload.
  const searchedResults = () => {
    const videoKeys = new Set(found.videos.map(resultKey));
    return [...found.songs.filter((song) => !videoKeys.has(resultKey(song))), ...found.videos];
  };
  const evaluateResults = (results: YtdlpResult[]) =>
    buildSourceCandidates({
      source: "ytdlp",
      // Live streams are not recordings of the requested track.
      results: results.filter((result) => !isYtdlpLiveResult(result)),
      request: resolvedTrack,
    });
  const holdsTrack = (evaluation: Awaited<ReturnType<typeof buildSourceCandidates>>) =>
    evaluation.evaluations.some(
      (entry) => entry.decision === "accept" || entry.decision === "verify",
    );

  // YouTube Music lists the release audio with its artists, album, and
  // length. Its search reads the next few songs only while none read so far
  // could be the track, and video search runs only when none of its songs is.
  if (queries[0]) {
    await searchOnce("songs", queries[0], {
      songs: true,
      limit: SONG_READS,
      wanted: (song) =>
        !deniedIds.has(song.id) &&
        prefilterCandidates({
          source: "ytdlp",
          candidates: [{ ...song, song: true }],
          request: resolvedTrack,
        })[0]?.rejected === false,
      decided: async (songs) => holdsTrack(await evaluateResults(songs)),
    });
  }
  let evaluation = await evaluateResults(searchedResults());
  if (!holdsTrack(evaluation)) {
    for (const query of [...queries, fallbackQuery].filter((value): value is string =>
      Boolean(value),
    )) {
      if (hasEnoughCandidates(found.videos, resolvedTrack)) break;
      if (query === fallbackQuery && found.videos.length > 0) break;
      await searchOnce("videos", query, { limit: 5 });
    }
    evaluation = await evaluateResults(searchedResults());
  }
  const candidates = usableEvaluationEntries(evaluation)
    .filter((entry) => !deniedIds.has(String(entry.candidate?.provider?.id || "").trim()))
    .map(toPipelineCandidate);
  if (candidates.length === 0) {
    const message =
      lastError && searchedResults().length === 0
        ? `yt-dlp search failed: ${lastError}`
        : "No suitable yt-dlp search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount: queries.length,
      rawResultCount: searchedResults().length,
      rankedCount: evaluation.evaluations.length,
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

async function handleYtdlpDownload(payload: YtdlpPayload, helpers: YtdlpHelpers) {
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
  import("./aurralHistoryService.ts")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => {
      console.warn(err);
    });

  let downloaded;
  try {
    downloaded = await ytdlpClient.downloadAudio(url, {
      jobId: job.id,
      shouldCancel: () => !isPipelinePayloadActive(payload),
    });
  } catch (error) {
    if (!isPipelinePayloadActive(payload)) {
      await ytdlpClient.cleanupStaging(job.id);
      return null;
    }
    const message = asAppError(error)?.message || String(error);
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

  if (!isPipelinePayloadActive(payload)) {
    await ytdlpClient.cleanupStaging(job.id);
    return null;
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

async function handleYtdlpFinalize(payload: YtdlpPayload, helpers: YtdlpHelpers) {
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

  const validation = await validateDownloadedTrackFile({
    request: resolvedTrack,
    candidate: candidate?.candidate || candidate,
    filePath,
    source: "ytdlp",
    options: {
      strict: candidate?.evaluation?.decision !== "accept",
      manualSelection: payload.manualSelection === true,
    },
  });
  if (!isPipelinePayloadActive(payload)) {
    await ytdlpClient.cleanupStaging(job.id);
    return null;
  }
  if (!validation.valid) {
    if (validation.blocked && !payload.heldForReview) {
      const heldPath = path.join(
        path.dirname(filePath),
        "..",
        `${job.id}-held${path.extname(filePath)}`,
      );
      await fs.rename(filePath, heldPath);
      await ytdlpClient.cleanupStaging(job.id);
      const heldPayload = {
        ...payload,
        downloadedPath: null,
        heldForReview: holdForReview(job, {
          source: "ytdlp",
          sourcePath: heldPath,
          reason: validation.reason,
        }),
      };
      return hasNextCandidate(payload)
        ? buildNextCandidatePayload(heldPayload)
        : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
    }
    downloadTracker.recordDeniedSource(job.id, "ytdlp", candidate?.raw?.id);
    await fs.rm(filePath, { force: true }).catch(() => {});
    await ytdlpClient.cleanupStaging(job.id);
    const reason = validation.reason || "yt-dlp download failed track validation";
    if (hasNextCandidate(payload)) {
      return buildNextCandidatePayload(payload, { downloadedPath: null });
    }
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const playlistRoot = resolveDownloadRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".m4a");
  const finalPath = path.join(finalDir, finalName);
  const committed = await withPipelineCommitLock(payload, async () => {
    await writeAudioMetadata(filePath, resolvedTrack);
    import("./aurralHistoryService.ts")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => {
        console.warn(err);
      });
    const committedFinalPath = await commitDownloadedFile(filePath, finalPath);
    await ytdlpClient.cleanupStaging(job.id);
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      album: candidate?.resolvedAlbumName,
      quality: validation.quality,
    });
  });
  if (committed.cancelled) {
    await ytdlpClient.cleanupStaging(job.id);
    return null;
  }
  return committed.result;
}

export async function processYtdlpPipelinePayload(payload: YtdlpPayload, helpers: YtdlpHelpers) {
  logger.debug("ytdlp", "ytdlp pipeline phase", {
    phase: payload.phase,
    jobId: payload.jobId,
    source: payload.source,
  });
  if (!isPipelinePayloadActive(payload)) {
    await ytdlpClient.cleanupStaging(payload.jobId);
    return null;
  }
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
