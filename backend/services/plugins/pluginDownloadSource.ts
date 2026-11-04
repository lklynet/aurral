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
  toPipelineCandidate,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
} from "../trackMatching/index.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import {
  activePluginWith,
  pluginIdFromSource,
  pluginInput,
  PLUGIN_SOURCE_PREFIX,
  type InstalledPlugin,
} from "./pluginStore.ts";

const SEARCH_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const STATUS_TIMEOUT_MS = 60_000;
const POLL_SECONDS = 15;
const MAX_POLLS = (24 * 60 * 60) / POLL_SECONDS;
const MAX_RESULTS = 50;
const MAX_ALBUM_CANDIDATES = 5;

const text = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500));
const searchResult = v.object({
  id: text,
  title: text,
  artist: text,
  album: v.nullish(v.pipe(v.string(), v.maxLength(500))),
  durationMs: v.nullish(v.pipe(v.number(), v.minValue(0))),
  format: v.nullish(v.pipe(v.string(), v.maxLength(20))),
  bitrate: v.nullish(v.pipe(v.number(), v.minValue(0))),
  data: v.optional(v.unknown()),
});
export const searchResults = v.pipe(v.array(searchResult), v.maxLength(MAX_RESULTS));
const albumResult = v.object({
  id: text,
  title: text,
  artist: text,
  year: v.nullish(v.pipe(v.number(), v.integer())),
  trackCount: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
  format: v.nullish(v.pipe(v.string(), v.maxLength(20))),
  bitrate: v.nullish(v.pipe(v.number(), v.minValue(0))),
  data: v.optional(v.unknown()),
});
export const albumResults = v.pipe(v.array(albumResult), v.maxLength(MAX_RESULTS));
const pending = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const filePathText = v.pipe(v.string(), v.minLength(1));
export const trackDownloadResult = v.union([
  v.object({ path: filePathText }),
  v.object({ pending }),
]);
export const albumDownloadResult = v.nullish(v.object({ pending: v.optional(pending) }), {});
export const statusResult = v.object({
  done: v.boolean(),
  path: v.optional(filePathText),
});

type PluginResult = v.InferOutput<typeof searchResult> | v.InferOutput<typeof albumResult>;
type PluginCandidate = Omit<ReturnType<typeof toPipelineCandidate>, "raw"> & {
  raw: PluginResult;
};
type PluginPayload = {
  jobId: string;
  phase: string;
  source?: string | null;
  playlistId?: string | null;
  track?: Parameters<typeof buildResolvedTrack>[1];
  destination?: string | null;
  upgradeForJobId?: string | null;
  manualSelection?: boolean;
  candidates?: PluginCandidate[];
  candidate?: PluginCandidate | null;
  candidateIndex?: number;
  downloadedPath?: string | null;
  heldForReview?: ReturnType<typeof holdForReview> | null;
  pendingId?: string | null;
  pollAttempts?: number;
  albumGrab?: boolean;
  releaseMbid?: string | null;
  albumGroupJobIds?: string[];
};
type Helpers = {
  failOrTryNextSource: (
    payload: PluginPayload,
    job: DownloadJob,
    message: string,
    logDetails?: Record<string, number>,
  ) => Promise<PipelinePayload | null>;
};

const sourceId = (plugin: InstalledPlugin) => `${PLUGIN_SOURCE_PREFIX}${plugin.id}`;
const stagingDir = (plugin: InstalledPlugin, jobId: string) =>
  path.join(resolveAurralDataDir(), "_staging", "plugins", plugin.id, jobId);
const cleanup = (directory: string) =>
  fs.rm(directory, { recursive: true, force: true }).catch(() => {});

function recordHistory(
  job: DownloadJob,
  step: "recordTrackJobSearching" | "recordTrackJobDownloading" | "recordTrackJobMoving",
) {
  import("../aurralHistoryService.ts")
    .then((history) => history[step](job))
    .catch((error) => console.warn(error));
}

function trackInput(track: ReturnType<typeof buildResolvedTrack>) {
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

async function resolveDownloadedFile(directory: string, returned: string) {
  const root = await fs.realpath(directory);
  const filePath = await fs.realpath(path.resolve(directory, returned)).catch(() => null);
  const relative = filePath ? path.relative(root, filePath) : "";
  if (!filePath || !relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new PluginError("returned a file outside the folder Aurral gave it");
  if (!(await fs.stat(filePath)).isFile())
    throw new PluginError("returned a path that isn't a file");
  return filePath;
}

async function albumInput(payload: PluginPayload, job: DownloadJob) {
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

async function handleAlbumSearch(
  payload: PluginPayload,
  plugin: InstalledPlugin,
  helpers: Helpers,
) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const source = sourceId(plugin);
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: source,
    downloadClient: source,
  });
  recordHistory(job, "recordTrackJobSearching");
  const album = await albumInput(payload, job);
  let results: v.InferOutput<typeof albumResults>;
  try {
    results = await callPlugin(
      plugin,
      { path: "downloadSource.searchAlbum", input: { ...pluginInput(plugin), album } },
      albumResults,
      SEARCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `album search failed: ${error.message}`);
  }
  const denied = deniedAlbumSources([job, ...albumGrabJobs(payload)], source);
  const candidates = results
    .filter(
      (result) =>
        !denied.has(`album:${result.id}`.toLowerCase()) &&
        isSameCoreAlbum(result.title, album.title),
    )
    .slice(0, MAX_ALBUM_CANDIDATES)
    .map((result) => ({ raw: result, resolvedAlbumName: result.title, releaseVerified: false }));
  if (candidates.length === 0)
    return helpers.failOrTryNextSource(payload, job, "No matching album in the plugin's results");
  return { ...payload, phase: "download", source, candidates, candidateIndex: 0 };
}

async function handleSearch(payload: PluginPayload, plugin: InstalledPlugin, helpers: Helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const source = sourceId(plugin);
  downloadTracker.setDownloading(job.id);
  downloadTracker.updateDownloadMetadata(job.id, {
    downloadSource: source,
    downloadClient: source,
  });
  recordHistory(job, "recordTrackJobSearching");
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  let results: PluginResult[];
  try {
    results = await callPlugin(
      plugin,
      {
        path: "downloadSource.search",
        input: { ...pluginInput(plugin), track: trackInput(resolvedTrack) },
      },
      searchResults,
      SEARCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    return helpers.failOrTryNextSource(payload, job, `search failed: ${error.message}`);
  }
  const denied = new Set(
    (job.deniedRemoteSources ?? [])
      .filter((entry) => Array.isArray(entry) && entry[0] === source)
      .map((entry) => String(entry[1] ?? "")),
  );
  const evaluation = await buildSourceCandidates({
    source,
    results: results.filter((result) => !denied.has(result.id)),
    request: resolvedTrack,
  });
  const candidates = usableEvaluationEntries(evaluation).map(toPipelineCandidate);
  if (candidates.length === 0)
    return helpers.failOrTryNextSource(payload, job, "No suitable search results", {
      rawResultCount: results.length,
      rankedCount: evaluation.evaluations.length,
    });
  return { ...payload, phase: "download", source, candidates, candidateIndex: 0, resolvedTrack };
}

function trackDownloaded(payload: PluginPayload, plugin: InstalledPlugin, filePath: string) {
  const job = downloadTracker.getJob(payload.jobId);
  const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
  if (job && candidate)
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: sourceId(plugin),
      downloadClient: sourceId(plugin),
      releaseGuid: candidate.raw.id,
      releaseTitle: candidate.raw.title,
      remoteFilename: path.basename(filePath),
    });
  return {
    ...payload,
    phase: "finalize",
    source: sourceId(plugin),
    candidate,
    pendingId: null,
    downloadedPath: filePath,
  };
}

async function downloadFailed(
  payload: PluginPayload,
  plugin: InstalledPlugin,
  job: DownloadJob,
  error: PluginError,
  helpers: Helpers,
) {
  await cleanup(stagingDir(plugin, job.id));
  if (!isPipelinePayloadActive(payload)) return null;
  logger.warn(`plugin:${plugin.id}`, "Plugin download failed", {
    jobId: job.id,
    result: payload.candidates?.[Number(payload.candidateIndex || 0)]?.raw.id ?? null,
    error: error.message,
  });
  if (hasNextCandidate(payload))
    return buildNextCandidatePayload(payload, { downloadedPath: null, pendingId: null });
  return helpers.failOrTryNextSource(payload, job, `download failed: ${error.message}`);
}

async function handleDownload(payload: PluginPayload, plugin: InstalledPlugin, helpers: Helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
  const result = candidate?.raw;
  if (!candidate || !v.is(searchResult, result))
    return helpers.failOrTryNextSource(payload, job, "No search result to download");
  recordHistory(job, "recordTrackJobDownloading");
  const directory = stagingDir(plugin, job.id);
  await cleanup(directory);
  await fs.mkdir(directory, { recursive: true });
  const album = payload.albumGrab === true;
  try {
    const started = album
      ? await callPlugin(
          plugin,
          {
            path: "downloadSource.downloadAlbum",
            input: {
              ...pluginInput(plugin),
              result,
              album: await albumInput(payload, job),
              directory,
            },
          },
          albumDownloadResult,
          DOWNLOAD_TIMEOUT_MS,
        )
      : await callPlugin(
          plugin,
          {
            path: "downloadSource.download",
            input: { ...pluginInput(plugin), result, directory },
          },
          trackDownloadResult,
          DOWNLOAD_TIMEOUT_MS,
        );
    if (!isPipelinePayloadActive(payload)) {
      await cleanup(directory);
      return null;
    }
    if ("pending" in started && started.pending)
      return {
        ...payload,
        phase: "poll",
        pendingId: started.pending,
        pollAttempts: 0,
        delaySeconds: POLL_SECONDS,
      };
    if (album) return { ...payload, phase: "finalize", candidate, pendingId: null };
    if (!("path" in started) || !started.path)
      throw new PluginError("returned neither a path nor a pending download");
    return trackDownloaded(payload, plugin, await resolveDownloadedFile(directory, started.path));
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    return downloadFailed(payload, plugin, job, error, helpers);
  }
}

async function handlePoll(payload: PluginPayload, plugin: InstalledPlugin, helpers: Helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const directory = stagingDir(plugin, job.id);
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  try {
    const status = await callPlugin(
      plugin,
      {
        path: "downloadSource.status",
        input: { ...pluginInput(plugin), id: payload.pendingId, directory },
      },
      statusResult,
      STATUS_TIMEOUT_MS,
    );
    if (!isPipelinePayloadActive(payload)) {
      await cleanup(directory);
      return null;
    }
    if (!status.done) {
      if (pollAttempts >= MAX_POLLS)
        throw new PluginError("didn't finish the download within a day");
      return { ...payload, phase: "poll", pollAttempts, delaySeconds: POLL_SECONDS };
    }
    const candidate = payload.candidates?.[Number(payload.candidateIndex || 0)];
    if (payload.albumGrab === true)
      return { ...payload, phase: "finalize", candidate, pendingId: null, pollAttempts };
    if (!status.path) throw new PluginError("finished a download without its path");
    return trackDownloaded(payload, plugin, await resolveDownloadedFile(directory, status.path));
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    return downloadFailed(payload, plugin, job, error, helpers);
  }
}

async function handleAlbumFinalize(payload: PluginPayload, plugin: InstalledPlugin) {
  const directory = stagingDir(plugin, payload.jobId);
  const entries = (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(
    isAudioFile,
  );
  const resolved = await Promise.all(
    entries.map((entry) => resolveDownloadedFile(directory, entry).catch(() => null)),
  );
  const filePaths = resolved.filter((file) => file !== null);
  const next = await finishAlbumGrab(payload, {
    filePaths,
    source: sourceId(plugin),
    album: getPayloadCandidate(payload)?.resolvedAlbumName ?? null,
    resetFields: { pendingId: null, pollAttempts: 0, downloadedPath: null },
  });
  await cleanup(directory);
  return next;
}

async function handleFinalize(payload: PluginPayload, plugin: InstalledPlugin, helpers: Helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job || job.status === "failed" || job.status === "done") return null;
  const source = sourceId(plugin);
  const directory = stagingDir(plugin, job.id);
  const candidate = getPayloadCandidate(payload);
  const resolvedTrack = {
    ...buildResolvedTrack(job, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
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
    source,
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
          source,
          sourcePath: heldPath,
          reason: validation.reason,
        }),
      };
      return hasNextCandidate(payload)
        ? buildNextCandidatePayload(heldPayload)
        : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
    }
    downloadTracker.recordDeniedSource(job.id, source, candidate?.raw?.id);
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

export async function processPluginPipelinePayload(payload: PluginPayload, helpers: Helpers) {
  const id = pluginIdFromSource(payload.source);
  const plugin = id ? activePluginWith(id, "downloadSource") : null;
  if (!plugin?.manifest.downloadSource) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? helpers.failOrTryNextSource(payload, job, "The plugin is turned off") : null;
  }
  if (!isPipelinePayloadActive(payload)) {
    await cleanup(stagingDir(plugin, payload.jobId));
    return null;
  }
  const album = payload.albumGrab === true;
  if (payload.phase === "search")
    return album
      ? handleAlbumSearch(payload, plugin, helpers)
      : handleSearch(payload, plugin, helpers);
  if (payload.phase === "download") return handleDownload(payload, plugin, helpers);
  if (payload.phase === "poll") return handlePoll(payload, plugin, helpers);
  if (payload.phase === "finalize")
    return album ? handleAlbumFinalize(payload, plugin) : handleFinalize(payload, plugin, helpers);
  throw new Error(`Unknown plugin pipeline phase: ${payload.phase}`);
}
