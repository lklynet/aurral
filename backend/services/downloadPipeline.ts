import fs from "fs/promises";
import { asAppError } from "../../lib/errors.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { logger } from "./logger.ts";
import { enqueuePipelineJob, listHonkerJobs, type HonkerPayload } from "./honkerDb.ts";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import {
  discardSlskdSearch,
  discardSlskdWork,
  processSlskdPipelinePayload,
  SLSKD_NOT_CONFIGURED_MESSAGE,
} from "./slskdOrchestrator.ts";
import { discardUsenetWork, processUsenetPipelinePayload } from "./usenetOrchestrator.ts";
import { processYtdlpPipelinePayload } from "./ytdlpOrchestrator.ts";
import { discardDeemixWork, processDeemixPipelinePayload } from "./deemixOrchestrator.ts";
import {
  albumGrabJobs,
  blockAlbumGrabSource,
  fallbackAlbumGrabToTracks,
  heldAlbumGrabJobs,
  nextAlbumSource,
  returnUntriedAlbumGrabJobs,
} from "./albumGrab.ts";
import { mapRequest } from "./releaseManifest.ts";
import {
  attemptRelease,
  MAX_RELEASE_WAITS,
  readReleaseManifest,
  RELEASE_WAIT_SECONDS,
  resolveReleaseManifest,
} from "./releaseResolver.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  getEnabledDownloadSources,
  ALBUM_GRAB_SOURCE_IDS,
  getSourceLabel,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.ts";
import { blockPipelineJobForReview, SEARCH_RESET } from "./pipelineHelpers.ts";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.ts";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.ts";
import { discardHeldFile } from "./downloadJobs/reviewFiles.ts";
import { processShareDownload } from "./shareLinks/download.ts";

// Runs one step of a download job: it picks the next enabled source in
// priority order and hands the step to that source's adapter. Every source
// shares the Honker queue still named slskd-pipeline.
const slskdClient = getDownloadClient("slskd");

type TrackerPayload = Parameters<typeof downloadTracker.upgradeAttemptAhead>[0];
type SlskdStepPayload = Parameters<typeof processSlskdPipelinePayload>[0];
type SlskdStepHelpers = Parameters<typeof processSlskdPipelinePayload>[1];
type UsenetStepPayload = Parameters<typeof processUsenetPipelinePayload>[0];
type YtdlpStepPayload = Parameters<typeof processYtdlpPipelinePayload>[0];
type DeemixStepPayload = Parameters<typeof processDeemixPipelinePayload>[0];
type SourceError = { source: string; message: string };

type AdapterPayload = SlskdStepPayload | UsenetStepPayload | YtdlpStepPayload | DeemixStepPayload;
type AdapterState<Payload> = {
  [Key in Exclude<Payload extends unknown ? keyof Payload : never, keyof TrackerPayload>]?:
    | (Payload extends unknown ? (Key extends keyof Payload ? Payload[Key] : never) : never)
    | null;
};

export type PipelinePayload = TrackerPayload &
  AdapterState<AdapterPayload> & {
    exhaustedSources?: string[];
    sourceErrors?: SourceError[];
    releaseWaits?: number | null;
    upgradeWaits?: number;
    delaySeconds?: number;
  };

type SourceFields = Partial<
  Pick<
    PipelinePayload,
    | "manualSelection"
    | "allowedSources"
    | "albumGrab"
    | "triedSources"
    | "sourceErrors"
    | "exhaustedSources"
  >
>;

export function enqueuePendingJobsWithoutBatch() {
  if (!isAnyDownloadSourceConfigured()) return 0;
  const activePipelineJobIds = new Set(
    listHonkerJobs("slskd-pipeline")
      .map((entry) => String(entry.payload?.jobId || "").trim())
      .filter(Boolean),
  );
  let count = 0;
  let resolving = false;
  for (const job of downloadTracker.getByStatus("pending")) {
    const hasProviderSearch = job.slskdBatchId || job.slskdSearchId;
    if (!hasProviderSearch && job.manualReplacementSearch !== true) continue;
    if (activePipelineJobIds.has(job.id)) continue;
    downloadTracker.clearSlskdPipelineState(job.id);
    // The worker resolves the release of a track that can search by one.
    if (downloadTracker.canSearchByRelease(job)) resolving = true;
    else if (downloadTracker.enqueueDownloadPipeline(job.id)) count += 1;
  }
  if (resolving) {
    void import("./downloadJobs/mutationGuards.ts")
      .then(({ wakeDownloadWorker }) => wakeDownloadWorker())
      .catch(() => {});
  }
  return count;
}

async function failJob(job: DownloadJob, message: string) {
  if (job.upgradeForJobId) {
    const { finalizeQualityUpgradeFailure } = await import("./qualityProfileService.ts");
    await finalizeQualityUpgradeFailure(job, message);
    return;
  }
  downloadTracker.setFailed(job.id, message);
  try {
    const { recordTrackJobFailed } = await import("./aurralHistoryService.ts");
    recordTrackJobFailed(job, message);
  } catch {}
  try {
    const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
    downloadWorker.wake(0);
    await downloadWorker.checkPlaylistComplete(job.playlistId || job.playlistType);
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("downloads", "Failed to run post-failure playlist checks", {
      jobId: job.id,
      error: failure?.message || String(error),
    });
  }
}

// A held file goes to review only when no source verifies a file. It is
// removed when another file is imported or the job ends another way. A
// track denied in review can try its release again.
async function parkHeldForReview(payload: PipelinePayload, job: DownloadJob | null | undefined) {
  const held = payload?.heldForReview;
  if (!job || !held?.sourcePath) return false;
  if (!(await fs.stat(held.sourcePath).catch(() => null))?.isFile()) return false;
  downloadTracker.updateDownloadMetadata(job.id, held.metadata || {});
  const parked = blockPipelineJobForReview({
    downloadTracker,
    job,
    validation: { blocked: true, reason: held.reason },
    sourcePath: held.sourcePath,
  });
  if (parked) downloadTracker.setAlbumGrabAttempted(job.id, false);
  return parked;
}

const keepHeldForReview = (payload: PipelinePayload | null | undefined) =>
  payload?.heldForReview &&
  isPipelinePayloadActive(payload) &&
  downloadTracker.keepHeldForReview(payload.jobId, payload.heldForReview);

// A step that ends leaves a file the job still keeps, as when the job went
// back to wait for its next attempt.
async function discardHeldForReview(payload: PipelinePayload) {
  const held = payload?.heldForReview;
  if (!held?.sourcePath) return;
  const job = downloadTracker.getJob(payload.jobId);
  if (job?.stagingPath === held.sourcePath || job?.heldForReview?.sourcePath === held.sourcePath)
    return;
  await discardHeldFile(payload.jobId, held);
}

function isSourceConfigured(sourceId: string) {
  return getEnabledDownloadSources().some((source) => source.id === sourceId);
}

export function buildNextSourcePayload<Payload extends SourceFields>(
  payload: Payload,
  failedSource: string | null = null,
  reason: string | null = null,
) {
  if (payload?.manualSelection === true) return null;
  const allowedSources = Array.isArray(payload?.allowedSources)
    ? new Set(payload.allowedSources)
    : null;
  const sources = getEnabledDownloadSources().filter(
    (source) =>
      (!allowedSources || allowedSources.has(source.id)) &&
      (payload?.albumGrab !== true || ALBUM_GRAB_SOURCE_IDS.includes(source.id)),
  );
  if (sources.length === 0) return null;
  const tried = new Set(Array.isArray(payload?.triedSources) ? payload.triedSources : []);
  const sourceErrors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  if (failedSource) {
    tried.add(failedSource);
    if (reason) {
      sourceErrors.push({
        source: failedSource,
        message: String(reason || "").trim(),
      });
    }
  }
  const exhausted = new Set(
    Array.isArray(payload?.exhaustedSources) ? payload.exhaustedSources : [],
  );
  const untried = sources.filter((source) => !tried.has(source.id));
  const next = untried.find((source) => !exhausted.has(source.id)) || untried[0];
  if (!next) return null;
  return {
    ...payload,
    ...sourceSearchReset(),
    source: next.id,
    triedSources: [...tried],
    sourceErrors,
  };
}

const sourceSearchReset = () => ({
  ...SEARCH_RESET,
  phase: "search",
  searchId: null,
  searchIds: [],
  candidates: [],
  candidate: null,
  candidateIndex: 0,
  candidateRetryCounts: {},
  pollAttempts: 0,
  batchId: null,
  legacyTransfer: null,
  nzbId: null,
  queueUuid: null,
  queueUuids: null,
  history: null,
  downloadedPath: null,
});

// A track request whose quick search imported nothing tries its release
// next, keeping a file held for review. While the release cannot be read,
// the step waits with that file and then looks again, as an album download
// does, without taking a search slot. After the last wait it searches for
// the track.
async function searchByReleaseAfterQuickSearch(
  payload: PipelinePayload,
  job: DownloadJob,
  message: string | null,
) {
  const failed = payload.source;
  const searched = {
    ...payload,
    ...sourceSearchReset(),
    source: null,
    triedSources: [
      ...new Set(
        [...(payload.triedSources || []), failed].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ],
    sourceErrors: [
      ...(payload.sourceErrors || []),
      ...(failed && message ? [{ source: failed, message: String(message).trim() }] : []),
    ],
  };
  const { manifest, unreachable } = await readReleaseManifest(job.albumMbid, job.releaseMbid);
  if (!isPipelinePayloadActive(payload)) return null;
  const waits = Number(payload.releaseWaits) || 0;
  if (unreachable && waits < MAX_RELEASE_WAITS) {
    if (waits === 0)
      logger.warn("downloads", "Waiting for the release of a track after its quick search", {
        jobId: job.id,
      });
    return {
      ...searched,
      phase: "release",
      releaseWaits: waits + 1,
      delaySeconds: RELEASE_WAIT_SECONDS,
    };
  }
  const next = {
    ...searched,
    quickSearch: false,
    allowedSources: null,
    releaseWaits: null,
    delaySeconds: 0,
  };
  return downloadTracker.searchByReleaseAfterQuickSearch(next, manifest) || next;
}

function summarizeSourceErrors(
  payload: Pick<PipelinePayload, "sourceErrors" | "source"> | null | undefined,
  message: string,
) {
  const errors = Array.isArray(payload?.sourceErrors) ? [...payload.sourceErrors] : [];
  const source = String(payload?.source || "").trim();
  if (source && message) {
    errors.push({ source, message: String(message || "").trim() });
  }
  const summary = errors
    .map((entry) => {
      const label = getSourceLabel(entry.source);
      const entryMessage = String(entry.message || "").trim();
      return entryMessage ? `${label}: ${entryMessage}` : label;
    })
    .filter(Boolean)
    .join("; ");
  return summary || message;
}

async function failOrTryNextSource(
  sourcePayload: { jobId: string },
  sourceJob: { id: string },
  message: string,
  logDetails: object = {},
) {
  const payload = sourcePayload as PipelinePayload;
  const job = sourceJob as DownloadJob;
  if (payload?.quickSearch === true && payload.source)
    downloadTracker.recordQuickSearched(job.id, payload.source);
  const nextPayload = buildNextSourcePayload(payload, payload?.source || "slskd", message);
  if (nextPayload) {
    logger.info("downloads", "Trying next download source", {
      jobId: job?.id,
      failedSource: payload?.source || "slskd",
      nextSource: nextPayload.source,
      reason: message,
      ...logDetails,
    });
    downloadTracker.clearSlskdDispatched(job.id);
    return nextPayload;
  }
  if (payload?.albumGrab === true) {
    return fallbackAlbumGrabToTracks(payload, summarizeSourceErrors(payload, message));
  }
  if (payload?.quickSearch === true) return searchByReleaseAfterQuickSearch(payload, job, message);
  if (await parkHeldForReview(payload, job)) return null;
  await failJob(job, summarizeSourceErrors(payload, message));
  return null;
}

// An album step that failed on every retry removes its work, blocks a
// release it already downloaded, and moves to the next album source. Once
// none is left, its tracks start again untried after any fresh work, since
// most such failures are a passing outage. After the last of those
// attempts, each searches for its track, trying the failed sources last.
async function moveOnFromFailedAlbumStep(failed: PipelinePayload, message: string) {
  const payload = {
    ...failed,
    exhaustedSources: [
      ...new Set(
        [...(failed.exhaustedSources || []), failed.source].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ],
  };
  await discardSourceWork(payload);
  if (payload.phase === "finalize") blockAlbumGrabSource(payload, albumGrabJobs(payload));
  const next = await nextAlbumSource(payload, message);
  if (next) return next;
  const held = heldAlbumGrabJobs(payload);
  const failures = Math.max(
    0,
    ...held.map((job) => downloadTracker.recordAlbumGrabFailure(job.id)),
  );
  if (failures >= MAX_FAILED_ALBUM_ATTEMPTS) {
    return fallbackAlbumGrabToTracks(payload, summarizeSourceErrors(payload, message));
  }
  returnUntriedAlbumGrabJobs(payload, held, `${ALBUM_GRAB_FAILED_REASON}: ${message}`, {
    retry: true,
  });
  return null;
}

export async function failPipelineJob(failed: PipelinePayload, message: string) {
  const jobId = failed?.jobId;
  if (!jobId) return null;
  keepHeldForReview(failed);
  const next = await failPipelineStep(failed, message);
  keepHeldForReview(next);
  return next;
}

async function failPipelineStep(failed: PipelinePayload, message: string) {
  const jobId = failed.jobId;
  const payload = failed.source
    ? failed
    : { ...failed, source: buildNextSourcePayload(failed)?.source ?? null };
  if (payload.albumGrab === true) {
    const next = isPipelinePayloadActive(payload)
      ? await moveOnFromFailedAlbumStep(payload, message)
      : null;
    if (!next)
      await settleDroppedAlbumGrab(payload, null, `${ALBUM_GRAB_FAILED_REASON}: ${message}`);
    if (next?.jobId !== payload.jobId) await discardHeldForReview(payload);
    return next;
  }
  const job = isPipelinePayloadActive(payload) ? downloadTracker.getJob(jobId) : null;
  if (job?.status === "downloading" || job?.status === "pending") {
    if (payload.manualSelection !== true && payload.phase !== "finalize") {
      const next = await failOrTryNextSource(payload, job, message);
      if (next) {
        await discardSourceWork(payload);
        return next;
      }
    } else if (!(await parkHeldForReview(payload, job))) {
      await failJob(job, message);
    }
  }
  await discardHeldForReview(payload);
  return null;
}

const ALBUM_GRAB_ENDED_REASON = "The album download ended before this track was imported";
const ALBUM_GRAB_FAILED_REASON = "The album download failed and will start again";
const MAX_FAILED_ALBUM_ATTEMPTS = 3;
const NO_ALBUM_SOURCE_REASON = "No album download source is enabled; searching for the track";
const UPGRADE_WAIT_SECONDS = 60;

// Pins an attempt past its search, and the tracks it holds, to the release
// its leading track resolves to now, or to none.
async function repinAlbumAttempt(payload: PipelinePayload) {
  const jobs = albumGrabJobs(payload);
  const leader = jobs.find((job) => job.id === payload.jobId);
  if (!leader) return null;
  const release = await resolveReleaseManifest(leader);
  if (!isPipelinePayloadActive(payload)) return null;
  for (const id of release ? mapRequest(release, jobs).wanted.values() : []) {
    downloadTracker.updateMetadata(id, { releaseMbid: release!.releaseMbid });
  }
  return { ...payload, releaseMbid: release?.releaseMbid || null };
}

// An album download past its search is sorted by its release, so it never
// ends on metadata that is briefly unreachable. A release MusicBrainz no
// longer lists, as after a merge, is chosen again; otherwise the download
// waits. An attempt queued before attempts named their release is adopted
// the same way. After the last wait it finishes without a release.
async function awaitAttemptRelease(payload: PipelinePayload) {
  const waits = Number(payload.releaseWaits) || 0;
  if (waits >= MAX_RELEASE_WAITS)
    return { ...payload, releaseMbid: null, releaseWaits: null, delaySeconds: 0 };
  const repinned = await repinAlbumAttempt(payload);
  if (!repinned) return null;
  if (repinned.releaseMbid) return { ...repinned, releaseWaits: null, delaySeconds: 0 };
  if (waits === 0) {
    logger.warn("downloads", "Waiting for the release of an album download", {
      jobId: payload.jobId,
      releaseMbid: payload.releaseMbid ?? null,
    });
  }
  return { ...payload, releaseWaits: waits + 1, delaySeconds: RELEASE_WAIT_SECONDS };
}

async function discardSourceWork(payload: PipelinePayload) {
  if (payload.source === "slskd") await discardSlskdWork(payload as SlskdStepPayload);
  else if (payload.source === "usenet") await discardUsenetWork(payload as UsenetStepPayload);
  else if (payload.source === "deemix") await discardDeemixWork(payload as DeemixStepPayload);
}

// An attempt that ends while it still holds tracks was dropped before its
// source judged the release: its leading track stopped or was cancelled, the
// release could not be read when it searched, or its step kept failing. The
// tracks start again untried, and the source removes the work it started
// unless a cancellation already did.
export async function settleDroppedAlbumGrab(
  dropped: HonkerPayload | PipelinePayload | null,
  nextPayload: PipelinePayload | null = null,
  reason = ALBUM_GRAB_ENDED_REASON,
) {
  if (
    dropped?.albumGrab !== true ||
    (nextPayload?.albumGrab === true && isPipelinePayloadActive(nextPayload))
  )
    return;
  const payload = dropped as PipelinePayload;
  const held = heldAlbumGrabJobs(payload).filter((job) => job.id !== nextPayload?.jobId);
  if (held.length === 0) return;
  if (isPipelinePayloadActive(payload)) await discardSourceWork(payload);
  returnUntriedAlbumGrabJobs(payload, held, reason);
}

export async function processPipelinePayload(payload: PipelinePayload) {
  if (!payload || !payload.phase || !payload.jobId) {
    throw new Error("Invalid pipeline payload");
  }
  keepHeldForReview(payload);
  const nextPayload = await processSourcePayload(payload);
  keepHeldForReview(nextPayload);
  await settleDroppedAlbumGrab(payload, nextPayload);
  if (nextPayload?.jobId !== payload.jobId) await discardHeldForReview(payload);
  return nextPayload;
}

async function processSourcePayload(payload: PipelinePayload): Promise<PipelinePayload | null> {
  if (!isPipelinePayloadActive(payload)) {
    await discardSlskdSearch(payload as SlskdStepPayload);
    return null;
  }
  const currentJob = downloadTracker.getJob(payload.jobId);
  const inactiveOwner = deferForInactiveOwner(payload, currentJob);
  if (inactiveOwner) return inactiveOwner;
  if (payload.source === "share") return processShareDownload(payload);
  if (!isAnyDownloadSourceConfigured()) {
    const job = downloadTracker.getJob(payload.jobId);
    if (job) {
      await failJob(job, getDownloadSourceNotConfiguredMessage());
    }
    return null;
  }
  if (payload.albumGrab === true && payload.releaseMbid === undefined) {
    return payload.phase === "search" ? null : awaitAttemptRelease(payload);
  }
  if (
    payload.albumGrab === true &&
    payload.upgrade === true &&
    ["search", "waiting"].includes(payload.phase)
  ) {
    const waits = Number(payload.upgradeWaits) || 0;
    if (waits < MAX_RELEASE_WAITS && downloadTracker.upgradeAttemptAhead(payload)) {
      return {
        ...payload,
        phase: "waiting",
        upgradeWaits: waits + 1,
        delaySeconds: UPGRADE_WAIT_SECONDS,
      };
    }
    if (payload.phase === "waiting") payload = { ...payload, phase: "search", delaySeconds: 0 };
  }
  if (!payload.source) {
    const nextPayload = buildNextSourcePayload(payload, null, null);
    if (!nextPayload && payload.albumGrab === true) {
      return processSourcePayload(fallbackAlbumGrabToTracks(payload, NO_ALBUM_SOURCE_REASON));
    }
    if (!nextPayload && payload.quickSearch === true && currentJob) {
      const released = await searchByReleaseAfterQuickSearch(payload, currentJob, null);
      return released?.quickSearch === false ? processSourcePayload(released) : released;
    }
    if (!nextPayload) {
      const job = downloadTracker.getJob(payload.jobId);
      if (job) await failJob(job, getDownloadSourceNotConfiguredMessage());
      return null;
    }
    return processSourcePayload(nextPayload);
  }
  const { source } = payload;
  if (payload.albumGrab === true && ["search", "finalize"].includes(payload.phase) && currentJob) {
    if (await attemptRelease(payload, currentJob)) {
      if (payload.releaseWaits) payload = { ...payload, releaseWaits: null, delaySeconds: 0 };
    } else if (payload.phase === "search") {
      return null;
    } else if (payload.releaseMbid) {
      return awaitAttemptRelease(payload);
    }
  }
  if (payload.albumGrab === true && !ALBUM_GRAB_SOURCE_IDS.includes(source)) {
    const job = downloadTracker.getJob(payload.jobId);
    return job
      ? failOrTryNextSource(
          payload,
          job,
          `${getSourceLabel(payload.source)} cannot download a release`,
        )
      : null;
  }
  if (payload.source === "usenet") {
    if (!isSourceConfigured("usenet")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "Usenet is not configured") : null;
    }
    return processUsenetPipelinePayload(payload as UsenetStepPayload, { failOrTryNextSource });
  }
  if (payload.source === "deemix") {
    if (!isSourceConfigured("deemix")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "deemix is not configured") : null;
    }
    return processDeemixPipelinePayload(payload as DeemixStepPayload, { failOrTryNextSource });
  }
  if (payload.source === "ytdlp") {
    if (!isSourceConfigured("ytdlp")) {
      const job = downloadTracker.getJob(payload.jobId);
      return job ? failOrTryNextSource(payload, job, "yt-dlp is not configured") : null;
    }
    return processYtdlpPipelinePayload(payload as YtdlpStepPayload, { failOrTryNextSource });
  }
  if (payload.source !== "slskd") {
    const job = downloadTracker.getJob(payload.jobId);
    return job
      ? failOrTryNextSource(payload, job, `Unknown download source: ${payload.source}`)
      : null;
  }
  if (!slskdClient.isConfigured() || !isSourceConfigured("slskd")) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? failOrTryNextSource(payload, job, SLSKD_NOT_CONFIGURED_MESSAGE) : null;
  }
  return processSlskdPipelinePayload(payload as SlskdStepPayload, {
    failOrTryNextSource: failOrTryNextSource as SlskdStepHelpers["failOrTryNextSource"],
  });
}

export async function continuePipeline(payload: PipelinePayload | null | undefined) {
  if (!payload) return;
  if (!isPipelinePayloadActive(payload)) return;
  if (payload.delaySeconds) {
    enqueuePipelineJob(payload, {
      delaySeconds: Number(payload.delaySeconds),
    });
    return;
  }
  enqueuePipelineJob(payload, {});
}
