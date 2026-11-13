import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import type { PipelinePayload } from "../downloadPipeline.ts";
import {
  isPipelinePayloadActive,
  isPipelinePayloadCancelled,
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
  NATIVE_SOURCE_IDS,
  statusResult,
  trackResult,
  type AlbumResult,
  type DownloadSource,
  type ResolvedTrack,
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
const CANCEL_CHECK_MS = 1000;
const MAX_UNREAD_POLLS = (30 * 60) / POLL_SECONDS;
const MAX_TRACK_ALBUM_DOWNLOADS = 2;
const HANDED_OVER = ".aurral-handed-over.json";

type SourceCandidate =
  | ReturnType<typeof toPipelineCandidate<TrackResult>>
  | { raw: TrackResult; resolvedAlbumName?: string | null; candidate?: never; evaluation?: never }
  | {
      raw: AlbumResult;
      resolvedAlbumName: string;
      releaseVerified: boolean;
      candidate?: never;
      evaluation?: never;
    };
const nativeIds: readonly string[] = NATIVE_SOURCE_IDS;
export const isSourceContractId = (source: unknown): source is DownloadSource["id"] =>
  typeof source === "string" && (nativeIds.includes(source) || Boolean(pluginIdFromSource(source)));

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
  unreadPolls?: number;
  albumDownloads?: number;
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

export const stagingDir = (source: DownloadSource, jobId: string) =>
  path.resolve(resolveAurralDataDir(), "_staging", source.staging, jobId);
const handoverDir = (source: DownloadSource, pendingId: string) =>
  stagingDir(
    source,
    `pending-${createHash("sha256").update(pendingId).digest("hex").slice(0, 32)}`,
  );
const filesDir = (payload: Pick<SourcePayload, "jobId" | "pendingId">, source: DownloadSource) =>
  payload.pendingId ? handoverDir(source, payload.pendingId) : stagingDir(source, payload.jobId);
const cleanup = (directory: string) =>
  fs.rm(directory, { recursive: true, force: true }).catch(() => {});

const fromAlbum = (payload: SourcePayload, source: DownloadSource) =>
  payload.albumGrab !== true && !source.tracks;

// A track job takes at most two albums from a source before it moves on, so
// one track never spends an indexer's grabs on a whole search.
const hasNextTry = (payload: SourcePayload, source: DownloadSource) =>
  hasNextCandidate(payload) &&
  (!fromAlbum(payload, source) || Number(payload.albumDownloads || 0) < MAX_TRACK_ALBUM_DOWNLOADS);
const NEXT_TRY = { downloadedPath: null, pendingId: null, unreadPolls: 0 };

const usesDownload = (job: DownloadJob, sourceId: string, pendingId: string) =>
  job.status === "downloading" &&
  job.downloadSource === sourceId &&
  String(job.downloadClientId ?? "") === pendingId &&
  downloadTracker.hasPersistedJob(job.id) &&
  !downloadTracker.isInActiveAlbumGrab(job.id);

const otherUsers = (sourceId: string, pendingId: string, except: ReadonlySet<string>) =>
  downloadTracker
    .getAll()
    .some((job) => !except.has(job.id) && usesDownload(job, sourceId, pendingId));

const deniedKey = (payload: SourcePayload, source: DownloadSource, id: string | undefined) =>
  id && fromAlbum(payload, source) ? `album:${id}` : id;

const searchUpgrade = (payload: SourcePayload): Upgrade =>
  payload.upgrade === true
    ? { currentTier: downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier ?? null }
    : null;

export const resolveTrack = (
  payload: Pick<SourcePayload, "track" | "upgradeForJobId">,
  job: DownloadJob,
) => ({
  ...buildResolvedTrack(job, payload.track),
  upgradeForJobId: payload.upgradeForJobId || null,
});

export function trackQuery(track: ResolvedTrack) {
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

export const albumQuery = async (payload: Parameters<typeof attemptRelease>[0], job: DownloadJob) =>
  albumOf(await attemptRelease(payload, job), job);

export function albumOf(release: ReleaseManifest | null, job: DownloadJob) {
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

// A job is done with what its step started: the folder Aurral gave it, and
// the source's own download once no other job takes a track from it. A
// download Aurral imported from stays with the source, so a torrent seeds.
// Synchronous from releasing the job to checking for others, so the last of
// two jobs finishing at once removes the download.
export async function discardSourceWork(
  payload: Pick<SourcePayload, "jobId" | "pendingId">,
  source: DownloadSource,
  {
    imported = false,
    except = new Set([payload.jobId]),
    onDiscardError = (error: unknown) =>
      logger.warn(source.id, "Could not remove a download", {
        jobId: payload.jobId,
        pendingId: payload.pendingId,
        error: error instanceof Error ? error.message : String(error),
      }),
  }: {
    imported?: boolean;
    except?: ReadonlySet<string>;
    onDiscardError?: (error: unknown) => void;
  } = {},
) {
  const { pendingId } = payload;
  for (const jobId of except) downloadTracker.releaseDownloadClient(jobId);
  const last = !pendingId || !otherUsers(source.id, pendingId, except);
  await cleanup(stagingDir(source, payload.jobId));
  if (!pendingId || !last) return;
  if (!imported && source.discard) await source.discard(pendingId).catch(onDiscardError);
  await cleanup(handoverDir(source, pendingId));
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
  const release = await attemptRelease(payload, job);
  const denied = deniedAlbumSources([job, ...albumGrabJobs(payload)], source.id);
  let results: AlbumResult[];
  try {
    results = await albums.search(albumOf(release, job), {
      upgrade: searchUpgrade(payload),
      track: fromAlbum(payload, source) ? resolveTrack(payload, job) : null,
      denied: new Set([...denied].map((key) => key.replace(/^album:/, ""))),
      release,
    });
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `album search failed: ${error.message}`);
  }
  const candidates = results
    .filter((result) => !denied.has(`album:${result.id}`.toLowerCase()))
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
  const denied = new Set(
    (job.deniedRemoteSources ?? [])
      .filter((entry) => Array.isArray(entry) && entry[0] === source.id)
      .map((entry) => String(entry[1] ?? "")),
  );
  let results: TrackResult[];
  try {
    results = await tracks.search(resolvedTrack, { upgrade: searchUpgrade(payload), denied });
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `search failed: ${error.message}`);
  }
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
      remoteFilename: fromAlbum(payload, source) ? path.basename(filePath) : candidate.raw.title,
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
  payload.importedFiles ?? stagedAudioFiles(filesDir(payload, source));

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
    options: {
      release: await attemptRelease(payload, job),
      manualSelection: payload.manualSelection === true,
    },
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
  if (hasNextTry(payload, source)) return buildNextCandidatePayload(payload, NEXT_TRY);
  return helpers.failOrTryNextSource(payload, job, `download failed: ${error.message}`);
}

// A download that runs in Aurral stops once its step is cancelled.
async function whileActive<T>(payload: SourcePayload, run: (signal: AbortSignal) => Promise<T>) {
  const stop = new AbortController();
  const check = setInterval(() => {
    if (!isPipelinePayloadActive(payload))
      stop.abort(new DownloadSourceError("the download was cancelled"));
  }, CANCEL_CHECK_MS);
  try {
    return await run(stop.signal);
  } finally {
    clearInterval(check);
  }
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
  const { tracks, albums } = source;
  if (payload.albumGrab !== true && tracks)
    return whileActive(payload, (signal) => tracks.download({ result, directory, signal }));
  if (!albums)
    throw new DownloadSourceError(
      payload.albumGrab === true ? "can't download albums" : "can't download tracks",
    );
  const album = await albumQuery(payload, job);
  return whileActive(payload, (signal) => albums.download({ result, album, directory, signal }));
}

// Track jobs that take one album from a source share its download. Finding
// the download and claiming its start happen in one synchronous step, so
// after a start fails, one waiting job starts it for the others.
const starting = new Map<string, Promise<void>>();

async function joinDownload(source: DownloadSource, job: DownloadJob, result: TrackResult) {
  const key = `${source.id}\0${result.id}`;
  const releaseGuid = `album:${result.id}`;
  for (;;) {
    const running = downloadTracker
      .getAll()
      .find(
        (entry) =>
          entry.id !== job.id &&
          entry.releaseGuid === releaseGuid &&
          usesDownload(entry, source.id, String(entry.downloadClientId ?? "")),
      );
    if (running?.downloadClientId) return { pendingId: String(running.downloadClientId) };
    const waiting = starting.get(key);
    if (!waiting) {
      let settle = () => {};
      const claim = new Promise<void>((resolve) => {
        settle = resolve;
      });
      starting.set(key, claim);
      return {
        settle: () => {
          if (starting.get(key) === claim) starting.delete(key);
          settle();
        },
      };
    }
    await waiting;
  }
}

function useDownload(
  payload: SourcePayload,
  source: DownloadSource,
  result: TrackResult,
  pendingId: string,
) {
  downloadTracker.updateDownloadMetadata(payload.jobId, {
    downloadSource: source.id,
    downloadClient: source.id,
    downloadClientId: pendingId,
    releaseGuid: deniedKey(payload, source, result.id),
    releaseTitle: result.title,
  });
}

const polling = (payload: SourcePayload, pendingId: string) => ({
  ...payload,
  phase: "poll",
  pendingId,
  pollAttempts: 0,
  unreadPolls: 0,
  filesChecked: false,
  delaySeconds: POLL_SECONDS,
});

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
  const joined = fromAlbum(payload, source) ? await joinDownload(source, job, result) : null;
  if (joined?.pendingId) {
    if (!isPipelinePayloadActive(payload)) return null;
    useDownload(payload, source, result, joined.pendingId);
    return polling(payload, joined.pendingId);
  }
  let tried = payload;
  try {
    const counted = { ...payload, albumDownloads: Number(payload.albumDownloads || 0) + 1 };
    const start = async () => {
      const started = await startDownload(payload, source, job, result);
      const pendingId = "pending" in started && started.pending ? started.pending : null;
      if (pendingId) useDownload(counted, source, result, pendingId);
      return { started, pendingId };
    };
    // A cancellation waits while a download is handed to its client, so it
    // finds the download and removes it, or fails and can run again. A track
    // source without a client downloads the file itself, which isn't waited on.
    const locked = !source.tracks || Boolean(source.status) || payload.albumGrab === true;
    const handed = locked
      ? await withPipelineCommitLock(payload, start)
      : { cancelled: false, result: await start() };
    if (handed.cancelled) return null;
    const { started, pendingId } = handed.result;
    tried = counted;
    if (!isPipelinePayloadActive(payload)) {
      if (!locked || !pendingId || !isPipelinePayloadCancelled(payload))
        await discardSourceWork({ ...payload, pendingId }, source);
      return null;
    }
    if (pendingId) {
      joined?.settle?.();
      const next = polling(counted, pendingId);
      return await keepFiles(next, source, job).catch(() => next);
    }
    if (payload.albumGrab === true)
      return { ...payload, phase: "finalize", candidate, pendingId: null };
    if (fromAlbum(payload, source)) return await albumTrackDownloaded(counted, source, job);
    if (!("path" in started) || !started.path)
      throw new DownloadSourceError("returned neither a path nor a pending download");
    return trackDownloaded(
      payload,
      source,
      await resolveDownloadedFile(stagingDir(source, job.id), started.path),
    );
  } catch (error) {
    if (!(error instanceof DownloadSourceError)) throw error;
    return downloadFailed(tried, source, job, error, helpers);
  } finally {
    joined?.settle?.();
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

// Every job sharing a download reads it, but the source hands it over once,
// and a mark in its folder outlasts a restart.
const handing = new Map<string, Promise<v.InferOutput<typeof statusResult>>>();

async function pendingStatus(
  status: NonNullable<DownloadSource["status"]>,
  id: string,
  directory: string,
) {
  const mark = path.join(directory, HANDED_OVER);
  const handed = await fs
    .readFile(mark, "utf8")
    .then((text) => v.parse(statusResult, JSON.parse(text)))
    .catch(() => null);
  if (handed) return handed;
  const running = handing.get(directory);
  if (running) return running;
  const check = (async () => {
    await fs.mkdir(directory, { recursive: true });
    const read = await status({ id, directory });
    if (read.done) await fs.writeFile(mark, JSON.stringify(read));
    return read;
  })().finally(() => handing.delete(directory));
  handing.set(directory, check);
  return check;
}

// A client Aurral can't reach keeps downloading, so the download waits for
// it to answer again instead of ending.
async function readStatus(
  payload: SourcePayload,
  source: DownloadSource,
  status: NonNullable<DownloadSource["status"]>,
  directory: string,
) {
  try {
    return await pendingStatus(status, String(payload.pendingId), directory);
  } catch (error) {
    if (error instanceof DownloadSourceError) throw error;
    const unreadPolls = Number(payload.unreadPolls || 0) + 1;
    if (unreadPolls > MAX_UNREAD_POLLS) throw error;
    if (unreadPolls === 1)
      logger.warn(source.id, "Could not read a download; waiting", {
        jobId: payload.jobId,
        pendingId: payload.pendingId,
        error: error instanceof Error ? error.message : String(error),
      });
    return { unreadPolls };
  }
}

async function handlePoll(payload: SourcePayload, source: DownloadSource, helpers: SourceHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const directory = filesDir(payload, source);
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  try {
    if (payload.filedCount)
      return await waitForFiledAlbum({ ...payload, pollAttempts }, source, job);
    const checked = await keepFiles(payload, source, job);
    if (!source.status) throw new DownloadSourceError("can't report a pending download");
    const status = await readStatus(checked, source, source.status, directory);
    if ("unreadPolls" in status)
      return { ...checked, phase: "poll", pollAttempts, ...status, delaySeconds: POLL_SECONDS };
    const current = { ...checked, unreadPolls: 0 };
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
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
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
  await discardSourceWork(payload, source, { imported });
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
    if (hasNextTry(payload, source)) return buildNextCandidatePayload(payload, NEXT_TRY);
    return helpers.failOrTryNextSource(payload, job, "download is missing its file");
  }
  const shared = () =>
    Boolean(payload.pendingId) &&
    otherUsers(source.id, String(payload.pendingId), new Set([job.id]));
  const validation = await validateDownloadedTrackFile({
    request: resolvedTrack,
    candidate: candidate?.candidate ?? candidate,
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
      if (shared()) await fs.link(filePath, heldPath).catch(() => fs.copyFile(filePath, heldPath));
      else await fs.rename(filePath, heldPath);
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
      return hasNextTry(payload, source)
        ? buildNextCandidatePayload(heldPayload, NEXT_TRY)
        : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
    }
    downloadTracker.recordDeniedSource(
      job.id,
      source.id,
      deniedKey(payload, source, candidate?.raw?.id),
    );
    await discardSourceWork(payload, source);
    const reason = validation.reason || "download failed track validation";
    if (hasNextTry(payload, source)) return buildNextCandidatePayload(payload, NEXT_TRY);
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
    const committedFinalPath = inPlace
      ? filePath
      : await commitDownloadedFile(filePath, finalPath, { preserveSource: shared() });
    await discardSourceWork(payload, source, { imported: true });
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
    await discardSourceWork(payload, source);
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
  const job = downloadTracker.getJob(payload.jobId);
  const finished = !job || job.status === "failed" || job.status === "done";
  if (finished && !album && payload.phase !== "search") {
    await discardSourceWork(payload, source, {
      imported: job?.status === "done" && payload.phase === "finalize",
    });
    return null;
  }
  if (payload.phase === "search") {
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
