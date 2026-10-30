import path from "path";
import { downloadTracker, type DownloadJob, type DownloadTrackInput } from "./downloadTracker.ts";
import { playlistManager } from "../playlists/playlistManager.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import type { FlowRunSpec } from "../flows/flowTrackSource.ts";
import { buildFlowRunPlanIsolated } from "../flows/flowPlanRunner.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { resolveTrackSearchContext } from "./trackSearchContext.ts";
import {
  MAX_RELEASE_WAITS,
  readReleaseManifest,
  RELEASE_WAIT_SECONDS,
} from "../releaseResolver.ts";
import { indexUnmonitoredJobs } from "../aurralUnmonitoredJobs.ts";
import { safeLogDiagnostic } from "../logger.ts";
import {
  normalizeExistingFileMode,
  repairOrphanedPlaylistTrackPaths,
  moveHandedOverTracksToLidarr,
  repairReusableTrackLinks,
  requeueJobsUsingRemovedFolders,
  reuseTrackForPlaylist,
  type RemovedFolderRequeue,
} from "./fileReuse.ts";
import { AURRAL_FLOWS_DIR, resolveDownloadRoot } from "../downloadPaths.ts";
import { startDownloadPipelineWorker } from "../downloadPipelineWorker.ts";
import {
  activeLidarrRoots,
  configuredLidarrFolders,
  isLidarrLibraryActive,
  readOnlyFolderPaths,
} from "../libraryFolders.ts";
import { listHonkerJobs, withHonkerLock } from "../honkerDb.ts";
import { isPlaylistOwnerActive } from "./playlistOwnerStatus.ts";
import {
  getDownloadOwnerStatus,
  isDownloadOwnerProcess,
  requestDownloadOwner,
} from "./downloadOwnerClient.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.ts";
import { isPipelinePayloadActive } from "./downloadCancellation.ts";
import { asAppError } from "../../../lib/errors.ts";
import { getShareDownload } from "../shareLinks/downloadStore.ts";

const DEFAULT_CONCURRENCY = 3;
const SEARCH_SLOT_RECHECK_MS = 2000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 3;
const JOB_COOLDOWN_MS = 750;
const REUSE_REPAIR_INTERVAL_MS = 30 * 60 * 1000;
const WORKER_STOPPED_CODE = "WORKER_STOPPED";
const PLAYLIST_MUTATION_CODE = "PLAYLIST_MUTATION_IN_PROGRESS";
const RELEASE_WAIT_REASON = "Waiting for metadata to read the album release";
// The worker hands a job to the pipeline only while fewer jobs than its
// concurrency are searching, so a large playlist does not start every
// provider search at once.
function countSearchingPipelineJobs() {
  return listHonkerJobs("slskd-pipeline").filter((entry) => entry.payload?.phase === "search")
    .length;
}

type WorkerSettings = ReturnType<DownloadWorker["getWorkerSettings"]>;
type CurrentJob = Pick<DownloadJob, "id" | "playlistType" | "artistName" | "trackName"> & {
  progressPct: number;
  startedAt: number;
};
type ActiveJob = { playlistType: string; promise: Promise<void> };
type ReleaseWait = { waits: number; readyAt: number };
type JobMetrics = {
  jobId: string;
  finishedAt: number;
  failed?: true;
  error?: string;
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuTotalMs: number;
  timingsMs: { completionCheck: number };
};

export class DownloadWorker {
  declare downloadRoot: string;
  declare running: boolean;
  declare activeCount: number;
  declare lastReuseRepairAt: number;
  declare reuseRepairCursor: number;
  declare processLoop: (() => void) | null;
  declare processTimer: ReturnType<typeof setTimeout> | null;
  declare currentJob: CurrentJob | null;
  declare lastDequeuedPlaylistType: string | null;
  declare reuseRepairInFlight: Promise<unknown> | null;
  declare lastJobMetrics: JobMetrics | null;
  declare activeJobs: Map<string, ActiveJob>;
  declare blockedPlaylistTypes: Set<string>;
  declare runGeneration: number;
  declare playlistFinalizing: Set<string>;
  declare releaseWaits: Map<string, ReleaseWait>;
  declare downloadMetrics: {
    completedTracks: number;
    completedTrackAttempts: number;
    completedTrackLatencyMs: number;
  };

  constructor(downloadRoot = resolveDownloadRoot()) {
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.running = false;
    this.activeCount = 0;
    this.lastReuseRepairAt = 0;
    this.reuseRepairCursor = 0;
    this.processLoop = null;
    this.processTimer = null;
    this.currentJob = null;
    this.lastDequeuedPlaylistType = null;
    this.reuseRepairInFlight = null;
    this.lastJobMetrics = null;
    this.activeJobs = new Map();
    this.blockedPlaylistTypes = new Set();
    this.runGeneration = 0;
    this.playlistFinalizing = new Set();
    this.releaseWaits = new Map();
    this.downloadMetrics = {
      completedTracks: 0,
      completedTrackAttempts: 0,
      completedTrackLatencyMs: 0,
    };
  }

  _recordCompletedTrack(elapsedMs: number, attempts: number) {
    this.downloadMetrics.completedTracks += 1;
    this.downloadMetrics.completedTrackLatencyMs += Math.max(0, Math.round(Number(elapsedMs) || 0));
    this.downloadMetrics.completedTrackAttempts += Math.max(1, Math.round(Number(attempts) || 1));
  }

  _scheduleProcessIn(delayMs = JOB_COOLDOWN_MS) {
    const waitMs = Math.max(250, Math.floor(Number(delayMs) || JOB_COOLDOWN_MS));
    if (!this.running || this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      if (this.processLoop) this.processLoop();
    }, waitMs);
  }

  wake(delayMs = 0) {
    if (!this.running) return;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    this._scheduleProcessIn(delayMs);
  }

  _createControlFlowError(code: string, message: string) {
    const error: Error & { code?: string } = new Error(message);
    error.code = code;
    return error;
  }

  _isControlFlowError(error: { code?: unknown } | null | undefined) {
    const code = String(error?.code || "");
    return code === WORKER_STOPPED_CODE || code === PLAYLIST_MUTATION_CODE;
  }

  _isPlaylistBlocked(playlistType: string) {
    return this.blockedPlaylistTypes.has(String(playlistType || ""));
  }

  _assertJobCanContinue(job: DownloadJob, runGeneration: number) {
    if (runGeneration !== this.runGeneration) {
      throw this._createControlFlowError(WORKER_STOPPED_CODE, "Worker stopped");
    }
    if (this._isPlaylistBlocked(job?.playlistType)) {
      throw this._createControlFlowError(PLAYLIST_MUTATION_CODE, "Playlist mutation in progress");
    }
    if (!isPlaylistOwnerActive(job?.playlistId || job?.playlistType)) {
      throw this._createControlFlowError(PLAYLIST_MUTATION_CODE, "Playlist owner is inactive");
    }
  }

  blockPlaylist(playlistType: string) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    this.blockedPlaylistTypes.add(id);
    return true;
  }

  unblockPlaylist(playlistType: string) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    const removed = this.blockedPlaylistTypes.delete(id);
    if (removed && this.running) {
      this.wake();
    }
    return removed;
  }

  async waitForPlaylistIdle(playlistType: string) {
    const id = String(playlistType || "").trim();
    if (!id) return;
    while (true) {
      const active = [];
      for (const entry of this.activeJobs.values()) {
        if (entry?.playlistType === id && entry?.promise) {
          active.push(entry.promise);
        }
      }
      if (active.length === 0) {
        return;
      }
      await Promise.allSettled(active);
    }
  }

  async waitForIdle() {
    while (true) {
      const active = [...this.activeJobs.values()].map((entry) => entry?.promise).filter(Boolean);
      if (active.length === 0) {
        return;
      }
      await Promise.allSettled(active);
    }
  }

  _normalizeRetryPausedPlaylistIds(value: unknown) {
    if (!Array.isArray(value)) return [];
    const out = new Set();
    for (const entry of value) {
      const id = String(entry || "").trim();
      if (!id) continue;
      out.add(id);
    }
    return [...out];
  }

  _getRetryPausedPlaylistIds() {
    const settings = dbOps.getSettings();
    const raw = settings?.playlistWorker || {};
    return this._normalizeRetryPausedPlaylistIds(raw.retryPausedPlaylistIds);
  }

  setRetryCyclePaused(playlistType: string, paused: boolean) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    const current = dbOps.getSettings();
    const worker = current?.playlistWorker || {};
    const pausedIds = new Set(this._normalizeRetryPausedPlaylistIds(worker.retryPausedPlaylistIds));
    if (paused) {
      pausedIds.add(id);
    } else {
      pausedIds.delete(id);
    }
    dbOps.updateSettings({
      playlistWorker: {
        ...worker,
        retryPausedPlaylistIds: [...pausedIds],
      },
    });
    if (!paused && this.running) {
      this.wake();
    }
    return true;
  }

  getRetryCyclePausedMap(playlistIds: string[] = []) {
    const paused = new Set(this._getRetryPausedPlaylistIds());
    const out: Record<string, boolean> = {};
    for (const id of Array.isArray(playlistIds) ? playlistIds : []) {
      const key = String(id || "").trim();
      if (!key) continue;
      out[key] = paused.has(key);
    }
    return out;
  }

  _normalizeConcurrency(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(parsed)));
  }

  _normalizeExistingFileMode(value: unknown) {
    return normalizeExistingFileMode(value);
  }

  _getNextReadyPendingJob(lastPlaylistType: string | null = null) {
    const now = Date.now();
    return downloadTracker.getNextPendingMatching(
      (job) =>
        !this.activeJobs.has(job.id) &&
        !((this.releaseWaits.get(job.id)?.readyAt ?? 0) > now) &&
        isPlaylistOwnerActive(job?.playlistId || job?.playlistType),
      lastPlaylistType,
    );
  }

  // A track that searches by release waits while metadata cannot be read,
  // so a brief outage never sends it to a search for the track alone. After
  // the last wait it searches without its release.
  _waitForRelease(job: DownloadJob) {
    const waits = (this.releaseWaits.get(job.id)?.waits || 0) + 1;
    if (waits > MAX_RELEASE_WAITS) {
      this.releaseWaits.delete(job.id);
      return false;
    }
    this.releaseWaits.set(job.id, { waits, readyAt: Date.now() + RELEASE_WAIT_SECONDS * 1000 });
    downloadTracker.deferPendingToBack(job.id, RELEASE_WAIT_REASON, { keepRetryTier: true });
    return true;
  }

  // Once an album's release reads, none of its tracks waits any longer.
  _endReleaseWaits(job: DownloadJob) {
    for (const jobId of this.releaseWaits.keys()) {
      const waiting = downloadTracker.getJob(jobId);
      if (waiting && jobId !== job.id && (!job.albumMbid || waiting.albumMbid !== job.albumMbid))
        continue;
      this.releaseWaits.delete(jobId);
      if (waiting?.status === "pending" && waiting.error === RELEASE_WAIT_REASON) {
        downloadTracker.deferPendingToBack(jobId, null, { keepRetryTier: true });
      }
    }
  }

  _scheduleReleaseWaits() {
    let readyAt = Infinity;
    for (const [jobId, wait] of this.releaseWaits) {
      if (downloadTracker.getJob(jobId)?.status !== "pending") this.releaseWaits.delete(jobId);
      else readyAt = Math.min(readyAt, wait.readyAt);
    }
    if (Number.isFinite(readyAt)) this._scheduleProcessIn(readyAt - Date.now());
  }

  getWorkerSettings() {
    const settings = dbOps.getSettings();
    const raw = settings?.playlistWorker || {};
    return {
      concurrency: this._normalizeConcurrency(raw.concurrency),
      retryPausedPlaylistIds: this._normalizeRetryPausedPlaylistIds(raw.retryPausedPlaylistIds),
      existingFileMode: this._normalizeExistingFileMode(raw.existingFileMode),
    };
  }

  updateWorkerSettings(nextSettings: Partial<WorkerSettings> = {}) {
    const base = this.getWorkerSettings();
    const normalized = {
      concurrency:
        nextSettings.concurrency === undefined
          ? base.concurrency
          : this._normalizeConcurrency(nextSettings.concurrency),
      retryPausedPlaylistIds: this._normalizeRetryPausedPlaylistIds(base.retryPausedPlaylistIds),
      existingFileMode:
        nextSettings.existingFileMode === undefined
          ? base.existingFileMode
          : this._normalizeExistingFileMode(nextSettings.existingFileMode),
    };
    dbOps.updateSettings({
      playlistWorker: {
        concurrency: normalized.concurrency,
        retryPausedPlaylistIds: normalized.retryPausedPlaylistIds,
        existingFileMode: normalized.existingFileMode,
      },
    });
    return normalized;
  }

  async prepareFlowRunPlan(flow: FlowRunSpec, options: { size?: number } = {}) {
    const sizeOverride =
      Number.isFinite(Number(options?.size)) && Number(options.size) > 0
        ? Math.round(Number(options.size))
        : null;
    return buildFlowRunPlanIsolated(sizeOverride ? { ...flow, size: sizeOverride } : flow);
  }

  async seedFlowRun(
    playlistType: string,
    flow: FlowRunSpec,
    options: { size?: number; plan?: { primaryTracks: DownloadTrackInput[] } | null } = {},
  ) {
    const key = String(playlistType || "").trim();
    if (!key || !flow) {
      return { tracksQueued: 0, jobIds: [] };
    }
    const plan = options?.plan || (await this.prepareFlowRunPlan(flow, options));
    const primaryTracks = Array.isArray(plan?.primaryTracks) ? plan.primaryTracks : [];
    const jobIds = downloadTracker.addJobs(primaryTracks, key);
    flowPlaylistConfig.markLastRunAt(key);
    return { tracksQueued: primaryTracks.length, jobIds };
  }

  hasWork() {
    return (
      this.activeJobs.size > 0 ||
      this.blockedPlaylistTypes.size > 0 ||
      Boolean(this.reuseRepairInFlight) ||
      (this.running && Boolean(downloadTracker.getNextPending()))
    );
  }

  _maybeStopWhenIdle() {
    if (!this.running) return;
    if (this.activeJobs.size > 0) return;
    if (downloadTracker.getNextPending()) return;
    this._requestStop();
  }

  async researchMissingTracks(playlistType: string) {
    const jobs = downloadTracker.getByPlaylistType(playlistType);
    const isUnmonitored = indexUnmonitoredJobs();
    let requeued = 0;
    for (const job of jobs) {
      if (job.status !== "failed" || isUnmonitored(job)) continue;
      const priorError = String(job?.error || "").trim();
      const reason = ["Manual re-search", priorError].filter(Boolean).join(" • ");
      if (downloadTracker.setPending(job.id, reason || null, { asRetryCycle: true })) {
        requeued += 1;
      }
    }
    if (requeued > 0) {
      if (this.running) {
        this.wake();
      } else {
        await this.start();
      }
      return requeued;
    }
    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    if (stats.pending > 0) {
      if (this.running) {
        this.wake();
      } else {
        await this.start();
      }
    }
    return requeued;
  }

  async releaseLidarrFiles() {
    const { lidarrClient } = await import("../lidarrClient.ts");
    if (isLidarrLibraryActive(lidarrClient)) return 0;
    return this.requeueRemovedFolderFiles({
      removedFolders: configuredLidarrFolders(lidarrClient),
      keptFolders: readOnlyFolderPaths(),
      externalFiles: true,
      reason: "Lidarr was turned off",
    });
  }

  async releaseReadOnlyFolderFiles(folders: string[]) {
    const { lidarrClient } = await import("../lidarrClient.ts");
    return this.requeueRemovedFolderFiles({
      removedFolders: folders,
      keptFolders: [...readOnlyFolderPaths(), ...activeLidarrRoots(lidarrClient)],
      reason: "Its read-only folder left the Library",
    });
  }

  async requeueRemovedFolderFiles(options: RemovedFolderRequeue) {
    const requeued = requeueJobsUsingRemovedFolders({
      downloadRoot: this.downloadRoot,
      ...options,
    });
    if (requeued > 0) {
      if (this.running) this.wake();
      else await this.start();
    }
    return requeued;
  }

  async repairReusableLinks(force = false) {
    await this.releaseLidarrFiles();
    const now = Date.now();
    if (!force && now - this.lastReuseRepairAt < REUSE_REPAIR_INTERVAL_MS) {
      return null;
    }
    this.lastReuseRepairAt = now;
    const { existingFileMode } = this.getWorkerSettings();
    if (force) {
      await repairOrphanedPlaylistTrackPaths({
        existingFileMode,
        downloadRoot: this.downloadRoot,
      });
    }
    if (normalizeExistingFileMode(existingFileMode) === "download") {
      return null;
    }
    const result = await repairReusableTrackLinks({
      existingFileMode,
      downloadRoot: this.downloadRoot,
      cursor: this.reuseRepairCursor,
    });
    if (Number.isFinite(result?.nextCursor)) {
      this.reuseRepairCursor = result.nextCursor;
    }
    await moveHandedOverTracksToLidarr({ existingFileMode, downloadRoot: this.downloadRoot });
    return result;
  }

  scheduleReuseLinkRepair(force = false) {
    if (this.reuseRepairInFlight) return;
    this.reuseRepairInFlight = this.repairReusableLinks(force)
      .catch((error) => {
        console.warn(`[DownloadWorker] Reuse link repair failed: ${error?.message || error}`);
      })
      .finally(() => {
        this.reuseRepairInFlight = null;
      });
  }

  async start() {
    if (this.running) {
      return;
    }

    this.runGeneration += 1;
    this.running = true;
    void startDownloadPipelineWorker();
    console.log("[DownloadWorker] Starting worker...");

    this.processLoop = () => {
      if (!this.running) return;
      const { concurrency } = this.getWorkerSettings();
      while (this.activeCount < concurrency) {
        if (this.activeCount + countSearchingPipelineJobs() >= concurrency) {
          this._scheduleProcessIn(SEARCH_SLOT_RECHECK_MS);
          break;
        }
        const job = this._getNextReadyPendingJob(this.lastDequeuedPlaylistType);
        if (!job) {
          this._scheduleReleaseWaits();
          break;
        }
        this.lastDequeuedPlaylistType = job.playlistType;
        if (this._isPlaylistBlocked(job.playlistType)) {
          downloadTracker.deferPendingToBack(job.id, "Playlist mutation in progress", {
            keepRetryTier: true,
          });
          this._scheduleProcessIn(JOB_COOLDOWN_MS);
          break;
        }

        this.activeCount++;
        this.currentJob = {
          id: job.id,
          playlistType: job.playlistType,
          artistName: job.artistName,
          trackName: job.trackName,
          progressPct: 0,
          startedAt: Date.now(),
        };
        const jobRunGeneration = this.runGeneration;
        const jobPromise = this.processJob(job, jobRunGeneration)
          .catch(async (error) => {
            if (
              jobRunGeneration !== this.runGeneration ||
              this._isPlaylistBlocked(job.playlistType) ||
              this._isControlFlowError(error)
            ) {
              return;
            }
            console.error(`[DownloadWorker] Error processing job ${job.id}:`, error.message);
            if (job.upgradeForJobId) {
              const { finalizeQualityUpgradeFailure } = await import("../qualityProfileService.ts");
              await finalizeQualityUpgradeFailure(job, error.message);
              return;
            }
            downloadTracker.setFailed(job.id, error.message);
            import("../aurralHistoryService.ts")
              .then(({ recordTrackJobFailed }) => recordTrackJobFailed(job, error.message))
              .catch((historyError) => {
                console.warn(
                  `[DownloadWorker] Could not record failed job ${job.id} in history:`,
                  safeLogDiagnostic(historyError),
                );
              });
            await this.checkPlaylistComplete(job.playlistType);
          })
          .finally(() => {
            this.activeJobs.delete(job.id);
            this.activeCount--;
            if (this.activeCount <= 0) {
              this.currentJob = null;
            }
            this._maybeStopWhenIdle();
            this.wake(0);
          });
        this.activeJobs.set(job.id, {
          playlistType: job.playlistType,
          promise: jobPromise,
        });
      }
    };

    this.processLoop();
    this.scheduleReuseLinkRepair(true);
  }

  _requestStop() {
    if (!this.running) {
      return false;
    }
    this.running = false;
    this.runGeneration += 1;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    this.processLoop = null;
    this.lastDequeuedPlaylistType = null;
    this.currentJob = null;
    this.playlistFinalizing.clear();
    console.log("[DownloadWorker] Worker stopped");
    return true;
  }

  stop() {
    const stopped = this._requestStop();
    if (!stopped) {
      return;
    }
    downloadTracker.resetDownloadingToPending();
  }

  async stopAndDrain() {
    this._requestStop();
    await this.waitForIdle();
    downloadTracker.resetDownloadingToPending();
  }

  async processJob(job: DownloadJob, runGeneration = this.runGeneration) {
    console.log(
      `[DownloadWorker] Processing job ${job.id}: ${job.artistName} - ${job.trackName} (${job.playlistType})`,
    );

    const perfStartCpu = process.cpuUsage();
    const perfStartHr = process.hrtime.bigint();
    const timingsMs = {
      completionCheck: 0,
    };

    this._assertJobCanContinue(job, runGeneration);
    if (
      !isPipelinePayloadActive({
        jobId: job.id,
        playlistId: job.playlistId || job.playlistType,
        playlistGeneration: job.playlistGeneration,
      })
    ) {
      return;
    }

    try {
      if (getShareDownload(job.id)) {
        if (!downloadTracker.enqueueDownloadPipeline(job.id))
          throw new Error("Could not queue the shared file transfer.");
        return;
      }
      if (job.upgradeForJobId) {
        await this._enqueueUpgrade(job, runGeneration);
        return;
      }
      let phaseStart = process.hrtime.bigint();
      const { metadataUnreachable, ...resolvedTrack } = await resolveTrackSearchContext(job);
      this._assertJobCanContinue(job, runGeneration);
      // A quick search needs no release, so a track that starts with one
      // never waits for metadata.
      if (
        metadataUnreachable &&
        downloadTracker.canAwaitRelease(job) &&
        !downloadTracker.startsWithQuickSearch(job) &&
        this._waitForRelease(job)
      )
        return;
      downloadTracker.updateMetadata(job.id, resolvedTrack);
      Object.assign(job, resolvedTrack);
      const { existingFileMode } = this.getWorkerSettings();
      if (existingFileMode !== "download") {
        const reuse = await reuseTrackForPlaylist(resolvedTrack, job.playlistType, {
          existingFileMode,
          downloadRoot: this.downloadRoot,
          existingJobId: job.id,
          excludeJobIds: [job.id],
          allowLidarr: !job.requestGroupId,
        });
        if (reuse.reused) {
          this._recordCompletedTrack(Number(process.hrtime.bigint() - perfStartHr) / 1e6, 0);
          phaseStart = process.hrtime.bigint();
          this._assertJobCanContinue(job, runGeneration);
          await this.checkPlaylistComplete(job.playlistType);
          timingsMs.completionCheck += Number(process.hrtime.bigint() - phaseStart) / 1e6;
          const cpuDelta = process.cpuUsage(perfStartCpu);
          const elapsedMs = Number(process.hrtime.bigint() - perfStartHr) / 1e6;
          this.lastJobMetrics = {
            jobId: job.id,
            finishedAt: Date.now(),
            elapsedMs: Math.round(elapsedMs),
            cpuUserMs: Math.round(cpuDelta.user / 1000),
            cpuSystemMs: Math.round(cpuDelta.system / 1000),
            cpuTotalMs: Math.round((cpuDelta.user + cpuDelta.system) / 1000),
            timingsMs: {
              completionCheck: Math.round(timingsMs.completionCheck),
            },
          };
          return;
        }
        if (reuse.deferred) {
          downloadTracker.deferPendingToBack(job.id, reuse.reason, {
            keepRetryTier: true,
          });
          this._scheduleProcessIn(JOB_COOLDOWN_MS);
          return;
        }
      }
      if (!isAnyDownloadSourceConfigured()) {
        throw new Error(getDownloadSourceNotConfiguredMessage());
      }
      if (
        !isPipelinePayloadActive({
          jobId: job.id,
          playlistId: job.playlistId || job.playlistType,
          playlistGeneration: job.playlistGeneration,
        })
      ) {
        return;
      }
      const { manifest: release, unreachable } = downloadTracker.startsWithQuickSearch(job)
        ? {}
        : await readReleaseManifest(job.albumMbid, job.releaseMbid);
      this._assertJobCanContinue(job, runGeneration);
      if (
        unreachable &&
        !metadataUnreachable &&
        downloadTracker.canSearchByRelease(job) &&
        this._waitForRelease(job)
      )
        return;
      if (!unreachable && !metadataUnreachable) this._endReleaseWaits(job);
      if (!downloadTracker.enqueueDownloadPipeline(job.id, { release })) {
        throw new Error("Failed to enqueue the download pipeline");
      }
      return;
    } catch (error) {
      const cpuDelta = process.cpuUsage(perfStartCpu);
      const elapsedMs = Number(process.hrtime.bigint() - perfStartHr) / 1e6;
      this.lastJobMetrics = {
        jobId: job.id,
        finishedAt: Date.now(),
        failed: true,
        error: asAppError(error)?.message,
        elapsedMs: Math.round(elapsedMs),
        cpuUserMs: Math.round(cpuDelta.user / 1000),
        cpuSystemMs: Math.round(cpuDelta.system / 1000),
        cpuTotalMs: Math.round((cpuDelta.user + cpuDelta.system) / 1000),
        timingsMs: {
          completionCheck: Math.round(timingsMs.completionCheck),
        },
      };
      throw error;
    }
  }

  async _enqueueUpgrade(job: DownloadJob, runGeneration: number) {
    if (!isAnyDownloadSourceConfigured()) throw new Error(getDownloadSourceNotConfiguredMessage());
    const { manifest: release } = await readReleaseManifest(job.albumMbid, job.releaseMbid);
    this._assertJobCanContinue(job, runGeneration);
    if (downloadTracker.enqueueDownloadPipeline(job.id, { release })) return;
    if (
      downloadTracker.getJob(job.id)?.status !== "pending" ||
      downloadTracker.isSlskdDispatched(job.id)
    )
      return;
    throw new Error("The upgrade could not be queued");
  }

  async checkPlaylistComplete(playlistType: string) {
    const playlistKey = String(playlistType || "");
    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    const { total, pending, downloading, done, failed } = stats;
    const allSettled = total > 0 && pending === 0 && downloading === 0;
    const hasDone = done > 0;

    if (allSettled && hasDone) {
      if (this.playlistFinalizing.has(playlistKey)) {
        return;
      }
      this.playlistFinalizing.add(playlistKey);
      try {
        await withHonkerLock(
          `playlist-finalize:${playlistKey}`,
          async () => {
            console.log(
              `[DownloadWorker] All jobs complete for ${playlistType}, queueing media server playlist sync`,
            );
            try {
              const { removeUnusedPlaybackFiles, createPlaybackDeletionGuard } =
                await import("../playback/playbackFileRetention.ts");
              await removeUnusedPlaybackFiles(
                path.join(this.downloadRoot, "_fallback"),
                createPlaybackDeletionGuard({ playlistRoot: this.downloadRoot }),
              );
            } catch {}
            try {
              playlistManager.requestPlaylistSync([playlistType]);
              if (flowPlaylistConfig.isEnabled(playlistType)) {
                flowPlaylistConfig.scheduleNextRun(playlistType);
              }
            } catch (error) {
              console.error(
                `[DownloadWorker] Failed to queue media server playlist sync for ${playlistType}:`,
                asAppError(error)?.message,
              );
            }

            const completed = done;
            const flowName = playlistManager.getPlaylistName(playlistType) || playlistType;
            const flowPath = flowPlaylistConfig.getFlow(playlistType)
              ? path.join(playlistManager.downloadRoot, AURRAL_FLOWS_DIR, playlistType)
              : playlistManager.downloadRoot;
            const { notifyFlowDone } = await import("../notificationService.ts");
            notifyFlowDone(playlistType, { completed, failed }, flowPath, flowName).catch((err) =>
              console.warn("[DownloadWorker] Gotify notification failed:", err.message),
            );
            import("../download/downloadClientSettings.ts")
              .then(({ getDownloadClient }) => {
                const slskdClient = getDownloadClient("slskd");
                if (!slskdClient.isCleanupAfterRunsEnabled()) return null;
                const globalStats = downloadTracker.getStats();
                if (globalStats.pending > 0 || globalStats.downloading > 0) {
                  return null;
                }
                return slskdClient.cleanupAfterRun();
              })
              .catch((err) =>
                console.warn("[DownloadWorker] slskd cleanup failed:", err?.message || err),
              );
          },
          {
            ttlSeconds: 180,
            waitTimeoutMs: 15 * 60 * 1000,
          },
        );
      } finally {
        this.playlistFinalizing.delete(playlistKey);
      }
    }
  }

  pruneOrphanedJobState() {
    const activePlaylistIds = new Set([
      ...flowPlaylistConfig.getFlows().map((flow: { id: string }) => flow.id),
      ...flowPlaylistConfig.getStaticPlaylists().map((playlist: { id: string }) => playlist.id),
    ]);
    for (const jobId of [...this.activeJobs.keys()]) {
      if (downloadTracker.getJob(jobId)) continue;
      this.activeJobs.delete(jobId);
    }
    for (const playlistId of [...this.blockedPlaylistTypes]) {
      if (activePlaylistIds.has(playlistId)) continue;
      this.blockedPlaylistTypes.delete(playlistId);
    }
    for (const playlistId of [...this.playlistFinalizing]) {
      if (activePlaylistIds.has(playlistId)) continue;
      this.playlistFinalizing.delete(playlistId);
    }
  }

  getStatus() {
    const settings = this.getWorkerSettings();
    const completedTracks = Number(this.downloadMetrics.completedTracks || 0);
    return {
      running: this.running,
      processing: this.activeCount > 0,
      activeCount: this.activeCount,
      stats: downloadTracker.getStats(),
      currentJob: this.currentJob,
      lastJobMetrics: this.lastJobMetrics,
      downloadMetrics: {
        completedTracks,
        avgAttemptsPerTrack:
          completedTracks > 0
            ? Number((this.downloadMetrics.completedTrackAttempts / completedTracks).toFixed(2))
            : 0,
        avgSuccessLatencyMs:
          completedTracks > 0
            ? Math.round(this.downloadMetrics.completedTrackLatencyMs / completedTracks)
            : 0,
      },
      settings,
    };
  }
}

function createRemoteDownloadWorker() {
  const reader = new DownloadWorker();
  const call = <T = unknown>(method: string, args: unknown[] = [], timeoutMs = 30000) =>
    requestDownloadOwner<T>(method, args, { timeoutMs });
  const notify = (method: string, args: unknown[] = []) => {
    void call(method, args).catch((error) => {
      console.warn(
        `[DownloadWorker] ${method} could not reach the download worker process:`,
        error.message,
      );
    });
  };
  return {
    downloadRoot: reader.downloadRoot,
    get running() {
      return getDownloadOwnerStatus()?.running === true;
    },
    getStatus() {
      return (
        getDownloadOwnerStatus() || {
          running: false,
          processing: false,
          activeCount: 0,
          currentJob: null,
          stats: downloadTracker.getStats(),
          settings: reader.getWorkerSettings(),
        }
      );
    },
    getWorkerSettings: (...args: Parameters<DownloadWorker["getWorkerSettings"]>) =>
      reader.getWorkerSettings(...args),
    getRetryCyclePausedMap: (...args: Parameters<DownloadWorker["getRetryCyclePausedMap"]>) =>
      reader.getRetryCyclePausedMap(...args),
    start: () => call("start"),
    stop: () => notify("stop"),
    stopAndDrain: () => call("stopAndDrain", [], 30 * 60 * 1000),
    wake: (delayMs = 0) => notify("wakeOrStart", [delayMs]),
    researchMissingTracks: (id: string) =>
      call<number>("researchMissingTracks", [id], 10 * 60 * 1000),
    setRetryCyclePaused: async (id: string, paused: boolean) => {
      const result = await call("setRetryCyclePaused", [id, paused]);
      dbOps.invalidateSettingsCache();
      return result;
    },
    updateWorkerSettings: async (settings: Partial<WorkerSettings>) => {
      const result = await call("updateWorkerSettings", [settings]);
      dbOps.invalidateSettingsCache();
      return result;
    },
    checkPlaylistComplete: (id: string) => call("checkPlaylistComplete", [id], 10 * 60 * 1000),
    blockPlaylist: (id: string) => call("blockPlaylist", [id]),
    unblockPlaylist: (id: string) => call("unblockPlaylist", [id]),
    waitForPlaylistIdle: (id: string) => call("waitForPlaylistIdle", [id], 30 * 60 * 1000),
    waitForIdle: () => call("waitForIdle", [], 30 * 60 * 1000),
    pruneOrphanedJobState: () => call("pruneOrphanedJobState"),
    scheduleReuseLinkRepair: (force: boolean) => notify("scheduleReuseLinkRepair", [force]),
  };
}

export const downloadWorker = isDownloadOwnerProcess()
  ? new DownloadWorker()
  : createRemoteDownloadWorker();

export async function startWorkerIfPending() {
  const pending = downloadTracker.getNextPending();
  if (!pending) return;
  if (downloadWorker.running) {
    downloadWorker.wake();
    return;
  }
  await downloadWorker.start();
}
