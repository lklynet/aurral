import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import type { PipelinePayload } from "../downloadPipeline.ts";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "../downloadJobs/downloadCancellation.ts";
import {
  downloadTracker,
  type DownloadJob,
  type PipelineStep,
} from "../downloadJobs/downloadTracker.ts";
import { deferForInactiveOwner } from "../downloadJobs/playlistOwnerStatus.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { readOnlyFolderPaths } from "../libraryFolders.ts";
import { isLibraryScanActive, scheduleLibraryScan } from "../libraryScanWorker.ts";
import {
  buildResolvedJobTrack as buildResolvedTrack,
  buildTrackFileName,
  commitDownloadedFile,
  joinUnderRoot,
  writeAudioMetadata,
} from "../downloadUtils.ts";
import { logger } from "../logger.ts";
import { albumGrabJobs, deniedAlbumSources, finishAlbumGrab } from "../albumGrab.ts";
import { selectSoulseekAlbumFolder } from "../albumReleaseSearch.ts";
import { getQualityProfile } from "../qualityProfile.ts";
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
import { filedAlbumFiles } from "./filedAlbum.ts";
import { pluginIdFromSource } from "../plugins/pluginStore.ts";
import {
  recordTrackJobSearching,
  recordTrackJobDownloading,
  recordTrackJobMoving,
} from "../aurralHistoryService.ts";

const POLL_SECONDS = 15;
const MAX_POLLS = (24 * 60 * 60) / POLL_SECONDS;
const MAX_ALBUM_CANDIDATES = 5;
const FILED_FALLBACK_SCAN = 8;
const FILED_GIVE_UP = 16;

type SourceCandidate =
  | ReturnType<typeof toPipelineCandidate<TrackResult>>
  | {
      raw: AlbumResult;
      resolvedAlbumName: string;
      releaseVerified: boolean;
      candidate?: never;
      evaluation?: never;
    };
export const isSourceContractId = (source: unknown): source is DownloadSource["id"] =>
  typeof source === "string" && (source === "qbittorrent" || Boolean(pluginIdFromSource(source)));

export type SourcePayload = PipelineStep & {
  source: DownloadSource["id"];
  candidates?: SourceCandidate[];
  candidate?: SourceCandidate | null;
  downloadedPath?: string | null;
  pendingId?: string | null;
  importedFiles?: string[] | null;
  filedCount?: number | null;
  filedPolls?: number;
  fallbackScanned?: boolean;
  pollAttempts?: number;
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
export async function discardSourceWork(
  payload: Pick<SourcePayload, "jobId" | "pendingId">,
  source: DownloadSource,
) {
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
  recordTrackJobSearching(job);
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

const downloadedFiles = (payload: SourcePayload, source: DownloadSource) =>
  payload.importedFiles ?? stagedAudioFiles(stagingDir(source, payload.jobId));

// Aurral judges the files themselves, as it does for a Usenet release, so a
// track still imports when the file names didn't show which one it is.
async function albumTrackDownloaded(
  payload: SourcePayload,
  source: DownloadSource,
  job: DownloadJob,
) {
  const found = await selectVerifiedDownloadedFile({
    request: resolveTrack(payload, job),
    filePaths: await downloadedFiles(payload, source),
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

// Once an album download lists its files, the source keeps only the ones
// Aurral wants, matched by name like a Soulseek listing. An album attempt
// keeps its tracks when the listing holds the whole release, which verifies
// the release, and a single track keeps its file. Otherwise it keeps every
// file, and the whole album downloads.
async function keepFiles(payload: SourcePayload, source: DownloadSource, job: DownloadJob) {
  const files = source.albums?.files;
  const album = payload.albumGrab === true;
  if (!files || (!album && !fromAlbum(payload, source)) || payload.filesChecked) return payload;
  const id = payload.pendingId;
  const listed = id ? await files.list(id) : null;
  if (!id || !listed) return payload;
  const results = listed.map((file) => ({ user: source.id, file: file.path, size: file.size }));
  const checked = { ...payload, filesChecked: true };
  const keepAll = async () => {
    await files.keep({ id, paths: listed.map((file) => file.path) });
    return checked;
  };
  if (album) {
    const [folder] = selectSoulseekAlbumFolder(results, albumGrabJobs(payload), {
      manifest: await attemptRelease(payload, job),
      profile: getQualityProfile(),
    }).candidates;
    if (!folder) return keepAll();
    await files.keep({ id, paths: folder.files.flatMap(({ file }) => file ?? []) });
    const index = Number(payload.candidateIndex || 0);
    return {
      ...checked,
      candidates: payload.candidates?.map((candidate, at) =>
        at === index ? { ...candidate, releaseVerified: true } : candidate,
      ),
    };
  }
  const evaluation = await buildSourceCandidates({
    source: "soulseek",
    results,
    request: resolveTrack(payload, job),
  });
  const file = usableEvaluationEntries(evaluation)[0]?.candidate.raw.file;
  if (typeof file !== "string") return keepAll();
  await files.keep({ id, paths: [file] });
  return checked;
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
  attempt: SourcePayload,
  source: DownloadSource,
  helpers: SourceHelpers,
) {
  const payload = {
    ...attempt,
    importedFiles: null,
    filedCount: null,
    filedPolls: 0,
    fallbackScanned: false,
  };
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
  const result = candidate?.raw;
  if (!v.is(trackResult, result))
    return helpers.failOrTryNextSource(payload, job, "No search result to download");
  recordTrackJobDownloading(job);
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
        filesChecked: false,
        delaySeconds: POLL_SECONDS,
      };
      return await keepFiles(polling, source, job).catch(() => polling);
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

const FILED_NOT_FOUND =
  "finished, but Aurral didn't find the album in a read-only folder. Check that the folder it saves to is in Settings > Library and its files are tagged";

// A client that files its own downloads names no files, so Aurral waits until
// its Library index holds the album. A fallback scan covers shares that send
// no file events, and polls during a scan don't count toward giving up.
async function waitForFiledAlbum(payload: SourcePayload, source: DownloadSource, job: DownloadJob) {
  if (!isPipelinePayloadActive(payload)) {
    await discardSourceWork(payload, source);
    return null;
  }
  const roots = readOnlyFolderPaths();
  if (roots.length === 0) throw new DownloadSourceError(FILED_NOT_FOUND);
  const scanning = isLibraryScanActive();
  const filedPolls = Number(payload.filedPolls || 0);
  const files = scanning ? [] : filedAlbumFiles(job);
  if (!scanning && (files.length >= Number(payload.filedCount) || filedPolls >= FILED_GIVE_UP)) {
    if (files.length === 0) throw new DownloadSourceError(FILED_NOT_FOUND);
    const finished = { ...payload, importedFiles: files };
    if (finished.albumGrab === true)
      return {
        ...finished,
        phase: "finalize",
        candidate: getPayloadCandidate(finished),
        pendingId: null,
      };
    return await albumTrackDownloaded(finished, source, job);
  }
  if (Number(payload.pollAttempts) >= MAX_POLLS) throw new DownloadSourceError(FILED_NOT_FOUND);
  const counted = scanning ? filedPolls : filedPolls + 1;
  const scan = !payload.fallbackScanned && counted >= FILED_FALLBACK_SCAN;
  if (scan) scheduleLibraryScan({ changedPaths: roots });
  return {
    ...payload,
    phase: "poll",
    filedPolls: counted,
    fallbackScanned: payload.fallbackScanned === true || scan,
    delaySeconds: POLL_SECONDS,
  };
}

async function handlePoll(payload: SourcePayload, source: DownloadSource, helpers: SourceHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const directory = stagingDir(source, job.id);
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  try {
    if (payload.filedCount)
      return await waitForFiledAlbum({ ...payload, pollAttempts }, source, job);
    const current = await keepFiles(payload, source, job);
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
    if (status.filed) {
      if (job.upgradeForJobId)
        throw new DownloadSourceError("filed an upgrade itself, and Aurral files its own upgrades");
      if (current.albumGrab !== true && !fromAlbum(current, source))
        throw new DownloadSourceError("finished a download without its path");
      return await waitForFiledAlbum(
        {
          ...current,
          pollAttempts,
          filedCount: status.filed,
          filedPolls: 0,
          fallbackScanned: false,
        },
        source,
        job,
      );
    }
    const candidate = current.candidates?.[Number(current.candidateIndex || 0)];
    if (current.albumGrab === true)
      return { ...current, phase: "finalize", candidate, pollAttempts };
    if (status.path)
      return trackDownloaded(current, source, await resolveDownloadedFile(directory, status.path));
    if (fromAlbum(current, source)) return await albumTrackDownloaded(current, source, job);
    throw new DownloadSourceError("finished a download without its path");
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return downloadFailed(payload, source, job, error, helpers);
  }
}

// The source keeps a download Aurral imported from, so a torrent seeds, and
// removes one Aurral didn't use.
async function handleAlbumFinalize(payload: SourcePayload, source: DownloadSource) {
  let imported = false;
  const settled = { ...payload, pendingId: null };
  const next = await finishAlbumGrab(settled, {
    filePaths: await downloadedFiles(payload, source),
    inPlace: Boolean(payload.importedFiles),
    source: source.id,
    album: getPayloadCandidate(payload)?.resolvedAlbumName ?? null,
    resetFields: {
      pollAttempts: 0,
      downloadedPath: null,
      filedCount: null,
      filedPolls: 0,
      fallbackScanned: false,
    },
    onImported: () => {
      imported = true;
    },
  });
  if (imported) await cleanup(stagingDir(source, payload.jobId));
  else await discardSourceWork(payload, source);
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
    await discardSourceWork(payload, source);
    if (hasNextCandidate(payload))
      return buildNextCandidatePayload(payload, { downloadedPath: null, pendingId: null });
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
    await discardSourceWork(payload, source);
    return null;
  }
  const inPlace = Boolean(payload.importedFiles);
  if (!validation.valid) {
    if (validation.blocked && !payload.heldForReview && !inPlace) {
      const heldPath = path.join(
        path.dirname(directory),
        `${job.id}-held${path.extname(filePath)}`,
      );
      await fs.rename(filePath, heldPath);
      await discardSourceWork(payload, source);
      const heldPayload = {
        ...payload,
        pendingId: null,
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
    await discardSourceWork(payload, source);
    const reason = validation.reason || "download failed track validation";
    if (hasNextCandidate(payload))
      return buildNextCandidatePayload(payload, { downloadedPath: null, pendingId: null });
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
    if (!inPlace) {
      await writeAudioMetadata(filePath, resolvedTrack);
      recordTrackJobMoving(job);
    }
    const committedFinalPath = inPlace ? filePath : await commitDownloadedFile(filePath, finalPath);
    await cleanup(directory);
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      inPlace,
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
