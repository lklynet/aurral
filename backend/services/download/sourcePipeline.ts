import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import type { PipelinePayload } from "../downloadPipeline.ts";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "../downloadJobs/downloadCancellation.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { deferForInactiveOwner } from "../downloadJobs/playlistOwnerStatus.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import {
  buildResolvedJobTrack as buildResolvedTrack,
  buildTrackFileName,
  commitDownloadedFile,
  joinUnderRoot,
  writeAudioMetadata,
} from "../downloadUtils.ts";
import { logger } from "../logger.ts";
import { albumGrabJobs, deniedAlbumSources, finishAlbumGrab } from "../albumGrab.ts";
import { isSameCoreAlbum } from "../downloadJobs/deemixSearch.ts";
import { isAudioFile } from "../downloadJobs/usenetReleaseSearch.ts";
import { attemptRelease } from "../releaseResolver.ts";
import type { ReleaseManifest } from "../releaseManifest.ts";
import {
  buildNextCandidatePayload,
  finalizePipelineJobSuccess,
  getPayloadCandidate,
  hasNextCandidate,
  holdForReview,
} from "../pipelineHelpers.ts";
import {
  buildSourceCandidates,
  selectVerifiedDownloadedFile,
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "../trackMatching/index.ts";
import {
  DownloadSourceError,
  trackResult,
  type AlbumResult,
  type DownloadSource,
  type TrackResult,
  type Upgrade,
} from "./downloadSource.ts";

const POLL_SECONDS = 15;
const MAX_POLLS = (24 * 60 * 60) / POLL_SECONDS;
const MAX_ALBUM_CANDIDATES = 5;

type SourceCandidate = Omit<ReturnType<typeof toPipelineCandidate>, "raw"> & {
  raw: TrackResult | AlbumResult;
};
export type SourcePayload = {
  jobId: string;
  phase: string;
  source?: string | null;
  playlistId?: string | null;
  track?: Parameters<typeof buildResolvedTrack>[1];
  destination?: string | null;
  upgradeForJobId?: string | null;
  upgrade?: boolean;
  manualSelection?: boolean;
  candidates?: SourceCandidate[];
  candidate?: SourceCandidate | null;
  candidateIndex?: number;
  downloadedPath?: string | null;
  heldForReview?: ReturnType<typeof holdForReview> | null;
  pendingId?: string | null;
  pollAttempts?: number;
  albumGrab?: boolean;
  releaseMbid?: string | null;
  albumGroupJobIds?: string[];
  filesChecked?: boolean;
};
export type SourceHelpers = {
  failOrTryNextSource: (
    payload: SourcePayload,
    job: DownloadJob,
    message: string,
    logDetails?: Record<string, number>,
  ) => Promise<PipelinePayload | null>;
};

const stagingDir = (source: DownloadSource, jobId: string) =>
  path.join(resolveAurralDataDir(), "_staging", source.staging, jobId);
const cleanup = (directory: string) =>
  fs.rm(directory, { recursive: true, force: true }).catch(() => {});

const fromAlbum = (payload: SourcePayload, source: DownloadSource) =>
  payload.albumGrab !== true && !source.tracks;

const deniedKey = (payload: SourcePayload, source: DownloadSource, id: string | undefined) =>
  id && fromAlbum(payload, source) ? `album:${id}` : id;

const searchUpgrade = (payload: SourcePayload): Upgrade =>
  payload.upgrade === true
    ? { currentTier: downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier ?? null }
    : null;

const resolveTrack = (payload: SourcePayload, job: DownloadJob) => ({
  ...buildResolvedTrack(job, payload.track),
  upgradeForJobId: payload.upgradeForJobId || null,
});

function recordHistory(
  job: DownloadJob,
  step: "recordTrackJobSearching" | "recordTrackJobDownloading" | "recordTrackJobMoving",
) {
  import("../aurralHistoryService.ts")
    .then((history) => history[step](job))
    .catch((error) => console.warn(error));
}

export function trackQuery(track: ReturnType<typeof buildResolvedTrack>) {
  return {
    artist: track.artistName ?? null,
    title: track.trackName ?? null,
    album: track.albumName ?? null,
    durationMs: track.durationMs ?? null,
    artistMbid: track.artistMbid ?? null,
    albumMbid: track.albumMbid ?? null,
    releaseMbid: track.releaseMbid ?? null,
    trackMbid: track.trackMbid ?? null,
    releaseYear: track.releaseYear ?? null,
    trackNumber: track.trackNumber ?? null,
    discNumber: track.discNumber ?? null,
  };
}

export async function albumQuery(payload: SourcePayload, job: DownloadJob) {
  const release: ReleaseManifest | null = await attemptRelease(payload, job);
  return {
    artist: release?.artistNames[0] ?? job.artistName ?? null,
    title: release?.title || job.albumName || null,
    releaseMbid: release?.releaseMbid || null,
    releaseGroupMbid: release?.releaseGroupMbid ?? null,
    tracks: (release?.tracks ?? []).map((track) => ({
      title: track.title,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      durationMs: track.durationMs ?? null,
    })),
  };
}

async function resolveDownloadedFile(directory: string, returned: string) {
  const root = await fs.realpath(directory);
  const filePath = await fs.realpath(path.resolve(directory, returned)).catch(() => null);
  const relative = filePath ? path.relative(root, filePath) : "";
  if (!filePath || !relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new DownloadSourceError("returned a file outside the folder Aurral gave it");
  if (!(await fs.stat(filePath)).isFile())
    throw new DownloadSourceError("returned a path that isn't a file");
  return filePath;
}

// Removes what a step started: the source's own download, if it has one, and
// the folder Aurral gave it.
export async function discardSourceWork(payload: SourcePayload, source: DownloadSource) {
  if (payload.pendingId && source.discard) {
    await source.discard(payload.pendingId).catch((error: unknown) =>
      logger.warn(source.id, "Could not remove a download", {
        jobId: payload.jobId,
        pendingId: payload.pendingId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  await cleanup(stagingDir(source, payload.jobId));
}

function startSearch(job: DownloadJob, source: DownloadSource) {
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: source.id,
    downloadClient: source.id,
  });
  recordHistory(job, "recordTrackJobSearching");
}

async function handleAlbumSearch(
  payload: SourcePayload,
  source: DownloadSource,
  albums: NonNullable<DownloadSource["albums"]>,
  helpers: SourceHelpers,
) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  startSearch(job, source);
  const album = await albumQuery(payload, job);
  let results: AlbumResult[];
  try {
    results = await albums.search(album, searchUpgrade(payload));
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `album search failed: ${error.message}`);
  }
  const denied = deniedAlbumSources([job, ...albumGrabJobs(payload)], source.id);
  const candidates = results
    .filter(
      (result) =>
        !denied.has(`album:${result.id}`.toLowerCase()) &&
        isSameCoreAlbum(result.title, album.title),
    )
    .slice(0, MAX_ALBUM_CANDIDATES)
    .map((result) => ({ raw: result, resolvedAlbumName: result.title, releaseVerified: false }));
  if (candidates.length === 0)
    return helpers.failOrTryNextSource(payload, job, "No matching album in the search results");
  return { ...payload, phase: "download", source: source.id, candidates, candidateIndex: 0 };
}

async function handleSearch(
  payload: SourcePayload,
  source: DownloadSource,
  tracks: NonNullable<DownloadSource["tracks"]>,
  helpers: SourceHelpers,
) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  startSearch(job, source);
  const resolvedTrack = resolveTrack(payload, job);
  let results: TrackResult[];
  try {
    results = await tracks.search(trackQuery(resolvedTrack), searchUpgrade(payload));
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `search failed: ${error.message}`);
  }
  const denied = new Set(
    (job.deniedRemoteSources ?? [])
      .filter((entry) => Array.isArray(entry) && entry[0] === source.id)
      .map((entry) => String(entry[1] ?? "")),
  );
  const evaluation = await buildSourceCandidates({
    source: source.id,
    results: results.filter((result) => !denied.has(result.id)),
    request: resolvedTrack,
  });
  const candidates = usableEvaluationEntries(evaluation).map(toPipelineCandidate);
  if (candidates.length === 0)
    return helpers.failOrTryNextSource(payload, job, "No suitable search results", {
      rawResultCount: results.length,
      rankedCount: evaluation.evaluations.length,
    });
  return {
    ...payload,
    phase: "download",
    source: source.id,
    candidates,
    candidateIndex: 0,
    resolvedTrack,
  };
}

function trackDownloaded(payload: SourcePayload, source: DownloadSource, filePath: string) {
  const job = downloadTracker.getJob(payload.jobId);
  const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
  if (job && candidate)
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: source.id,
      downloadClient: source.id,
      releaseGuid: deniedKey(payload, source, candidate.raw.id),
      releaseTitle: candidate.raw.title,
      remoteFilename: path.basename(filePath),
    });
  return {
    ...payload,
    phase: "finalize",
    source: source.id,
    candidate,
    pendingId: null,
    downloadedPath: filePath,
  };
}

async function stagedAudioFiles(directory: string) {
  const entries = (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(
    isAudioFile,
  );
  const resolved = await Promise.all(
    entries.map((entry) => resolveDownloadedFile(directory, entry).catch(() => null)),
  );
  return resolved.filter((file) => file !== null);
}

// Aurral judges the files themselves, as it does for a Usenet release, so a
// track still imports when the file names didn't show which one it is.
async function albumTrackDownloaded(
  payload: SourcePayload,
  source: DownloadSource,
  job: DownloadJob,
) {
  const found = await selectVerifiedDownloadedFile({
    request: resolveTrack(payload, job),
    filePaths: await stagedAudioFiles(stagingDir(source, job.id)),
    source: source.id,
    options: { release: await attemptRelease(payload, job) },
  });
  if (!found.filePath) {
    const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
    downloadTracker.recordDeniedSource(
      job.id,
      source.id,
      deniedKey(payload, source, candidate?.raw.id),
    );
    throw new DownloadSourceError("downloaded an album without the track");
  }
  return trackDownloaded(payload, source, found.filePath);
}

// Before an album downloads for one track, the source keeps only the file
// whose name matches it. Without a match, the whole album downloads.
async function keepTrackFile(payload: SourcePayload, source: DownloadSource, job: DownloadJob) {
  const files = source.albums?.files;
  if (!files || !fromAlbum(payload, source) || payload.filesChecked || !payload.pendingId)
    return payload;
  const listed = await files.list(payload.pendingId);
  if (!listed) return payload;
  const evaluation = await buildSourceCandidates({
    source: "soulseek",
    results: listed.map((file) => ({ user: source.id, file: file.path, size: file.size })),
    request: resolveTrack(payload, job),
  });
  const file = usableEvaluationEntries(evaluation)[0]?.candidate.raw.file;
  if (typeof file === "string") await files.keep({ id: payload.pendingId, path: file });
  return { ...payload, filesChecked: true };
}

async function downloadFailed(
  payload: SourcePayload,
  source: DownloadSource,
  job: DownloadJob,
  error: DownloadSourceError,
  helpers: SourceHelpers,
) {
  await discardSourceWork(payload, source);
  if (!isPipelinePayloadActive(payload)) return null;
  logger.warn(source.id, "Download failed", {
    jobId: job.id,
    result: payload.candidates?.[Number(payload.candidateIndex || 0)]?.raw.id ?? null,
    error: error.message,
  });
  if (hasNextCandidate(payload))
    return buildNextCandidatePayload(payload, { downloadedPath: null, pendingId: null });
  return helpers.failOrTryNextSource(payload, job, `download failed: ${error.message}`);
}

async function startDownload(
  payload: SourcePayload,
  source: DownloadSource,
  job: DownloadJob,
  result: TrackResult,
) {
  const directory = stagingDir(source, job.id);
  await cleanup(directory);
  await fs.mkdir(directory, { recursive: true });
  if (payload.albumGrab !== true && source.tracks)
    return source.tracks.download({ result, directory });
  if (!source.albums)
    throw new DownloadSourceError(
      payload.albumGrab === true ? "can't download albums" : "can't download tracks",
    );
  return source.albums.download({ result, album: await albumQuery(payload, job), directory });
}

async function handleDownload(
  payload: SourcePayload,
  source: DownloadSource,
  helpers: SourceHelpers,
) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
  const result = candidate?.raw;
  if (!v.is(trackResult, result))
    return helpers.failOrTryNextSource(payload, job, "No search result to download");
  recordHistory(job, "recordTrackJobDownloading");
  try {
    const started = await startDownload(payload, source, job, result);
    if (!isPipelinePayloadActive(payload)) {
      await discardSourceWork(
        { ...payload, pendingId: "pending" in started ? started.pending : null },
        source,
      );
      return null;
    }
    if ("pending" in started && started.pending) {
      const polling = {
        ...payload,
        phase: "poll",
        pendingId: started.pending,
        pollAttempts: 0,
        delaySeconds: POLL_SECONDS,
      };
      return await keepTrackFile(polling, source, job).catch(() => polling);
    }
    if (payload.albumGrab === true)
      return { ...payload, phase: "finalize", candidate, pendingId: null };
    if (fromAlbum(payload, source)) return await albumTrackDownloaded(payload, source, job);
    if (!("path" in started) || !started.path)
      throw new DownloadSourceError("returned neither a path nor a pending download");
    return trackDownloaded(
      payload,
      source,
      await resolveDownloadedFile(stagingDir(source, job.id), started.path),
    );
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return downloadFailed(payload, source, job, error, helpers);
  }
}

async function handlePoll(payload: SourcePayload, source: DownloadSource, helpers: SourceHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const directory = stagingDir(source, job.id);
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  try {
    const current = await keepTrackFile(payload, source, job);
    const status = await source.status({ id: String(current.pendingId), directory });
    if (!isPipelinePayloadActive(current)) {
      await discardSourceWork(current, source);
      return null;
    }
    if (!status.done) {
      if (pollAttempts >= MAX_POLLS)
        throw new DownloadSourceError("didn't finish the download within a day");
      return { ...current, phase: "poll", pollAttempts, delaySeconds: POLL_SECONDS };
    }
    const candidate = current.candidates?.[Number(current.candidateIndex || 0)];
    if (current.albumGrab === true)
      return { ...current, phase: "finalize", candidate, pendingId: null, pollAttempts };
    if (status.path)
      return trackDownloaded(current, source, await resolveDownloadedFile(directory, status.path));
    if (fromAlbum(current, source)) return await albumTrackDownloaded(current, source, job);
    throw new DownloadSourceError("finished a download without its path");
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return downloadFailed(payload, source, job, error, helpers);
  }
}

async function handleAlbumFinalize(payload: SourcePayload, source: DownloadSource) {
  const directory = stagingDir(source, payload.jobId);
  const next = await finishAlbumGrab(payload, {
    filePaths: await stagedAudioFiles(directory),
    source: source.id,
    album: getPayloadCandidate(payload)?.resolvedAlbumName ?? null,
    resetFields: { pendingId: null, pollAttempts: 0, downloadedPath: null },
  });
  await cleanup(directory);
  return next;
}

async function handleFinalize(
  payload: SourcePayload,
  source: DownloadSource,
  helpers: SourceHelpers,
) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const directory = stagingDir(source, job.id);
  const candidate = getPayloadCandidate(payload);
  const resolvedTrack = resolveTrack(payload, job);
  const filePath = String(payload.downloadedPath || "").trim();
  if (!filePath) {
    if (hasNextCandidate(payload))
      return buildNextCandidatePayload(payload, { downloadedPath: null });
    return helpers.failOrTryNextSource(payload, job, "download is missing its file");
  }
  const validation = await validateDownloadedTrackFile({
    request: resolvedTrack,
    candidate: candidate?.candidate,
    filePath,
    source: source.id,
    options: {
      strict: candidate?.evaluation?.decision !== "accept",
      manualSelection: payload.manualSelection === true,
    },
  });
  if (!isPipelinePayloadActive(payload)) {
    await cleanup(directory);
    return null;
  }
  if (!validation.valid) {
    if (validation.blocked && !payload.heldForReview) {
      const heldPath = path.join(
        path.dirname(directory),
        `${job.id}-held${path.extname(filePath)}`,
      );
      await fs.rename(filePath, heldPath);
      await cleanup(directory);
      const heldPayload = {
        ...payload,
        downloadedPath: null,
        heldForReview: holdForReview(job, {
          source: source.id,
          sourcePath: heldPath,
          reason: validation.reason,
        }),
      };
      return hasNextCandidate(payload)
        ? buildNextCandidatePayload(heldPayload)
        : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
    }
    downloadTracker.recordDeniedSource(
      job.id,
      source.id,
      deniedKey(payload, source, candidate?.raw?.id),
    );
    await cleanup(directory);
    const reason = validation.reason || "download failed track validation";
    if (hasNextCandidate(payload))
      return buildNextCandidatePayload(payload, { downloadedPath: null });
    return helpers.failOrTryNextSource(payload, job, reason);
  }
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const finalDir = joinUnderRoot(resolveDownloadRoot(), String(payload.destination || "").trim());
  const finalPath = path.join(
    finalDir,
    buildTrackFileName(job, path.extname(filePath).toLowerCase() || ".flac"),
  );
  const committed = await withPipelineCommitLock(payload, async () => {
    await writeAudioMetadata(filePath, resolvedTrack);
    recordHistory(job, "recordTrackJobMoving");
    const committedFinalPath = await commitDownloadedFile(filePath, finalPath);
    await cleanup(directory);
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      album: candidate?.resolvedAlbumName,
      quality: validation.quality,
    });
  });
  if (committed.cancelled) {
    await cleanup(directory);
    return null;
  }
  return committed.result;
}

export async function processSourcePipelinePayload(
  payload: SourcePayload,
  source: DownloadSource,
  helpers: SourceHelpers,
) {
  if (!isPipelinePayloadActive(payload)) {
    await discardSourceWork(payload, source);
    return null;
  }
  const album = payload.albumGrab === true;
  if (payload.phase === "search") {
    const job = downloadTracker.getJob(payload.jobId);
    if (!album && source.tracks) return handleSearch(payload, source, source.tracks, helpers);
    if (source.albums) return handleAlbumSearch(payload, source, source.albums, helpers);
    return job
      ? helpers.failOrTryNextSource(
          payload,
          job,
          album ? "can't download albums" : "can't download tracks",
        )
      : null;
  }
  if (payload.phase === "download") return handleDownload(payload, source, helpers);
  if (payload.phase === "poll") return handlePoll(payload, source, helpers);
  if (payload.phase === "finalize")
    return album ? handleAlbumFinalize(payload, source) : handleFinalize(payload, source, helpers);
  throw new Error(`Unknown download source phase: ${payload.phase}`);
}
