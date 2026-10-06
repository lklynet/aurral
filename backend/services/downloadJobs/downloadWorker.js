import path from "path";
import { downloadTracker } from "./downloadTracker.js";
import { playlistManager } from "../playlists/playlistManager.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import { flowTrackSource } from "../flows/flowTrackSource.js";
import { buildFlowRunPlanIsolated } from "../flows/flowPlanRunner.js";
import { dbOps, userOps } from "../../db/helpers/index.js";
import { resolveTrackSearchContext } from "./trackSearchContext.js";
import { getListenHistoryProfile } from "../listeningHistory.js";
import { indexUnmonitoredJobs } from "../aurralUnmonitoredJobs.js";
import { safeLogDiagnostic } from "../logger.js";
import {
  normalizeExistingFileMode,
  repairOrphanedPlaylistTrackPaths,
  moveHandedOverTracksToLidarr,
  repairReusableTrackLinks,
  reuseTrackForPlaylist,
} from "./fileReuse.js";
import {
  AURRAL_FLOWS_DIR,
  resolveDownloadRoot,
} from "../downloadPaths.js";
import { startDownloadPipelineWorker } from "../downloadPipelineWorker.js";
import { listHonkerJobs, withHonkerLock } from "../honkerDb.js";
import { isPlaylistOwnerActive } from "./playlistOwnerStatus.js";
import {
  getDownloadOwnerStatus,
  isDownloadOwnerProcess,
  requestDownloadOwner,
} from "./downloadOwnerClient.js";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../downloadSourceService.js";
import {
  isPipelinePayloadActive,
} from "./downloadCancellation.js";

const DEFAULT_CONCURRENCY = 3;
const SEARCH_SLOT_RECHECK_MS = 2000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 3;
const JOB_COOLDOWN_MS = 750;
const REUSE_REPAIR_INTERVAL_MS = 30 * 60 * 1000;
const WORKER_STOPPED_CODE = "WORKER_STOPPED";
const PLAYLIST_MUTATION_CODE = "PLAYLIST_MUTATION_IN_PROGRESS";
// The worker hands a job to the pipeline only while fewer jobs than its
// concurrency are searching, so a large playlist does not start every
// provider search at once.
function countSearchingPipelineJobs() {
  return listHonkerJobs("slskd-pipeline").filter((entry) => entry.payload?.phase === "search").length;
}

export class DownloadWorker {
  constructor(downloadRoot = resolveDownloadRoot()) {
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.running = false;
    this.activeCount = 0;
    this.lastReuseRepairAt = 0;
    this.reuseRepairCursor = 0;
    this.processLoop = null;
    this.processTimer = null;
    this.currentJob = null;
    this.lastDequeuedOwnerId = null;
    this.reuseRepairInFlight = null;
    this.lastJobMetrics = null;
    this.activeJobs = new Map();
    this.blockedOwnerIds = new Set();
    this.runGeneration = 0;
    this.playlistFinalizing = new Set();
    this.downloadMetrics = {
      completedTracks: 0,
      completedTrackAttempts: 0,
      completedTrackLatencyMs: 0,
    };
  }

  _recordCompletedTrack(elapsedMs, attempts) {
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

  _createControlFlowError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  _isControlFlowError(error) {
    const code = String(error?.code || "");
    return code === WORKER_STOPPED_CODE || code === PLAYLIST_MUTATION_CODE;
  }

  _isPlaylistBlocked(ownerId) {
    return this.blockedOwnerIds.has(String(ownerId || ""));
  }

  _assertJobCanContinue(job, runGeneration) {
    if (runGeneration !== this.runGeneration) {
      throw this._createControlFlowError(WORKER_STOPPED_CODE, "Worker stopped");
    }
    if (this._isPlaylistBlocked(job?.ownerId)) {
      throw this._createControlFlowError(PLAYLIST_MUTATION_CODE, "Playlist mutation in progress");
    }
    if (!isPlaylistOwnerActive(job?.ownerId)) {
      throw this._createControlFlowError(PLAYLIST_MUTATION_CODE, "Playlist owner is inactive");
    }
  }

  blockPlaylist(ownerId) {
    const id = String(ownerId || "").trim();
    if (!id) return false;
    this.blockedOwnerIds.add(id);
    return true;
  }

  unblockPlaylist(ownerId) {
    const id = String(ownerId || "").trim();
    if (!id) return false;
    const removed = this.blockedOwnerIds.delete(id);
    if (removed && this.running) {
      this.wake();
    }
    return removed;
  }

  async waitForPlaylistIdle(ownerId) {
    const id = String(ownerId || "").trim();
    if (!id) return;
    while (true) {
      const active = [];
      for (const entry of this.activeJobs.values()) {
        if (entry?.ownerId === id && entry?.promise) {
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

  _normalizeRetryPausedPlaylistIds(value) {
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

  setRetryCyclePaused(ownerId, paused) {
    const id = String(ownerId || "").trim();
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
      ...current,
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

  getRetryCyclePausedMap(playlistIds = []) {
    const paused = new Set(this._getRetryPausedPlaylistIds());
    const out = {};
    for (const id of Array.isArray(playlistIds) ? playlistIds : []) {
      const key = String(id || "").trim();
      if (!key) continue;
      out[key] = paused.has(key);
    }
    return out;
  }

  _normalizeConcurrency(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(parsed)));
  }

  _normalizeExistingFileMode(value) {
    return normalizeExistingFileMode(value);
  }

  _getNextReadyPendingJob(lastOwnerId = null) {
    return downloadTracker.getNextPendingMatching(
      (job) =>
        !this.activeJobs.has(job.id) &&
        isPlaylistOwnerActive(job?.ownerId),
      lastOwnerId,
    );
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

  updateWorkerSettings(nextSettings = {}) {
    const current = dbOps.getSettings();
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
      ...current,
      playlistWorker: {
        concurrency: normalized.concurrency,
        retryPausedPlaylistIds: normalized.retryPausedPlaylistIds,
        existingFileMode: normalized.existingFileMode,
      },
    });
    return normalized;
  }

  _getFlowListenHistoryProfile(flow) {
    const ownerUserId = Number(flow?.ownerUserId);
    if (!Number.isFinite(ownerUserId)) return null;
    const owner = userOps.getUserById(ownerUserId);
    return owner ? getListenHistoryProfile(owner) : null;
  }

  async seedFlowRunWithTracks(ownerId, flow, tracks, _options = {}) {
    const key = String(ownerId || "").trim();
    if (!key || !flow) {
      return { tracksQueued: 0, jobIds: [], reserveTracks: 0 };
    }
    const primaryTracks = flowTrackSource._filterTracksByArtists(
      Array.isArray(tracks) ? tracks : [],
      null,
      new Set(flowTrackSource._buildFeedbackExcludeKeys(flow?.ownerUserId)),
    );
    flowPlaylistConfig.markLastRunAt(key);
    const jobIds = downloadTracker.addJobs(primaryTracks, key);
    return {
      tracksQueued: primaryTracks.length,
      jobIds,
      reserveTracks: 0,
      reservePending: false,
    };
  }

  async prepareFlowRunPlan(flow, options = {}) {
    const sizeOverride =
      Number.isFinite(Number(options?.size)) && Number(options.size) > 0
        ? Math.round(Number(options.size))
        : null;
    return buildFlowRunPlanIsolated(
      sizeOverride ? { ...flow, size: sizeOverride } : flow,
      {
        listenHistoryProfile: this._getFlowListenHistoryProfile(flow),
      },
    );
  }

  async seedFlowRun(ownerId, flow, options = {}) {
    const key = String(ownerId || "").trim();
    if (!key || !flow) {
      return { tracksQueued: 0, jobIds: [], reserveTracks: 0 };
    }
    const plan = options?.plan || await this.prepareFlowRunPlan(flow, options);
    const primaryTracks = Array.isArray(plan?.primaryTracks) ? plan.primaryTracks : [];
    flowPlaylistConfig.markLastRunAt(key);
    const jobIds = downloadTracker.addJobs(primaryTracks, key);
    return {
      tracksQueued: primaryTracks.length,
      jobIds,
      reserveTracks: 0,
      reservePending: false,
    };
  }

  hasWork() {
    return this.activeJobs.size > 0 ||
      this.blockedOwnerIds.size > 0 ||
      Boolean(this.reuseRepairInFlight) ||
      (this.running && Boolean(downloadTracker.getNextPending()));
  }

  _maybeStopWhenIdle() {
    if (!this.running) return;
    if (this.activeJobs.size > 0) return;
    if (downloadTracker.getNextPending()) return;
    this._requestStop();
  }

  async researchMissingJobs(jobIds) {
    const jobs = jobIds.map((id) => downloadTracker.getJob(id)).filter(Boolean);
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
    if (jobs.some((job) => job.status === "pending")) {
      if (this.running) {
        this.wake();
      } else {
        await this.start();
      }
    }
    return requeued;
  }

  async repairReusableLinks(force = false) {
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
    startDownloadPipelineWorker();
    console.log("[DownloadWorker] Starting worker...");

    this.processLoop = () => {
      if (!this.running) return;
      const { concurrency } = this.getWorkerSettings();
      while (this.activeCount < concurrency) {
        if (this.activeCount + countSearchingPipelineJobs() >= concurrency) {
          this._scheduleProcessIn(SEARCH_SLOT_RECHECK_MS);
          break;
        }
        const job = this._getNextReadyPendingJob(this.lastDequeuedOwnerId);
        if (!job) {
          break;
        }
        this.lastDequeuedOwnerId = job.ownerId;
        if (this._isPlaylistBlocked(job.ownerId)) {
          downloadTracker.deferPendingToBack(job.id, "Playlist mutation in progress", {
            keepRetryTier: true,
          });
          this._scheduleProcessIn(JOB_COOLDOWN_MS);
          break;
        }

        this.activeCount++;
        this.currentJob = {
          id: job.id,
          ownerId: job.ownerId,
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
              this._isPlaylistBlocked(job.ownerId) ||
              this._isControlFlowError(error)
            ) {
              return;
            }
            console.error(`[DownloadWorker] Error processing job ${job.id}:`, error.message);
            downloadTracker.setFailed(job.id, error.message);
            import("../aurralHistoryService.js")
              .then(({ recordTrackJobFailed }) => recordTrackJobFailed(job, error.message))
              .catch((historyError) => {
                console.warn(`[DownloadWorker] Could not record failed job ${job.id} in history:`,
                  safeLogDiagnostic(historyError));
              });
            await this.checkPlaylistComplete(job.ownerId);
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
          ownerId: job.ownerId,
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
    this.lastDequeuedOwnerId = null;
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

  async processJob(job, runGeneration = this.runGeneration) {
    console.log(
      `[DownloadWorker] Processing job ${job.id}: ${job.artistName} - ${job.trackName} (${job.ownerId})`,
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
        ownerId: job.ownerId,
        ownerGeneration: job.ownerGeneration,
      })
    ) {
      return;
    }

    try {
      let phaseStart = process.hrtime.bigint();
      const resolvedTrack = await resolveTrackSearchContext(job);
      this._assertJobCanContinue(job, runGeneration);
      downloadTracker.updateMetadata(job.id, resolvedTrack);
      Object.assign(job, resolvedTrack);
      const { existingFileMode } = this.getWorkerSettings();
      if (existingFileMode !== "download") {
        const reuse = await reuseTrackForPlaylist(resolvedTrack, job.ownerId, {
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
          await this.checkPlaylistComplete(job.ownerId);
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
          ownerId: job.ownerId,
          ownerGeneration: job.ownerGeneration,
        })
      ) {
        return;
      }
      this._assertJobCanContinue(job, runGeneration);
      if (!downloadTracker.enqueueDownloadPipeline(job.id)) {
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
        error: error.message,
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

  async checkPlaylistComplete(ownerId) {
    const playlistKey = String(ownerId || "");
    const stats = downloadTracker.getOwnerStats(ownerId);
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
              `[DownloadWorker] All jobs complete for ${ownerId}, ensuring playlists...`,
            );
            try {
              const { removeUnusedPlaybackFiles, createPlaybackDeletionGuard } = await import("../playback/playbackFileRetention.js");
              await removeUnusedPlaybackFiles(path.join(this.downloadRoot, "_fallback"),
                createPlaybackDeletionGuard({ playlistRoot: this.downloadRoot }));
            } catch {}
            try {
              playlistManager.updateConfig(false);
              await playlistManager.ensurePlaylists();
              await playlistManager.scheduleScanLibrary(true);
              if (flowPlaylistConfig.isEnabled(ownerId)) {
                flowPlaylistConfig.scheduleNextRun(ownerId);
              }
            } catch (error) {
              console.error(
                `[DownloadWorker] Failed to ensure playlists for ${ownerId}:`,
                error.message,
              );
            }

            const completed = done;
            const flowName =
              playlistManager.getPlaylistName(ownerId) || ownerId;
            const flowPath = flowPlaylistConfig.getFlow(ownerId)
              ? path.join(playlistManager.downloadRoot, AURRAL_FLOWS_DIR, ownerId)
              : playlistManager.downloadRoot;
            const { notifyFlowDone } = await import("../notificationService.js");
            notifyFlowDone(
              ownerId,
              { completed, failed },
              flowPath,
              flowName,
            ).catch((err) =>
              console.warn("[DownloadWorker] Gotify notification failed:", err.message),
            );
            import("../download/downloadClientSettings.js")
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
      ...flowPlaylistConfig.getFlows().map((flow) => flow.id),
      ...flowPlaylistConfig.getStaticPlaylists().map((playlist) => playlist.id),
    ]);
    for (const jobId of [...this.activeJobs.keys()]) {
      if (downloadTracker.getJob(jobId)) continue;
      this.activeJobs.delete(jobId);
    }
    for (const playlistId of [...this.blockedOwnerIds]) {
      if (activePlaylistIds.has(playlistId)) continue;
      this.blockedOwnerIds.delete(playlistId);
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
  const call = (method, args = [], timeoutMs = 30000) =>
    requestDownloadOwner(method, args, { timeoutMs });
  const notify = (method, args = []) => {
    void call(method, args).catch((error) => {
      console.warn(`[DownloadWorker] ${method} could not reach the download worker process:`, error.message);
    });
  };
  return {
    downloadRoot: reader.downloadRoot,
    get running() { return getDownloadOwnerStatus()?.running === true; },
    getStatus() {
      return getDownloadOwnerStatus() || {
        running: false,
        processing: false,
        activeCount: 0,
        currentJob: null,
        stats: downloadTracker.getStats(),
        settings: reader.getWorkerSettings(),
      };
    },
    getWorkerSettings: (...args) => reader.getWorkerSettings(...args),
    getRetryCyclePausedMap: (...args) => reader.getRetryCyclePausedMap(...args),
    start: () => call("start"),
    stop: () => notify("stop"),
    stopAndDrain: () => call("stopAndDrain", [], 30 * 60 * 1000),
    wake: (delayMs = 0) => notify("wakeOrStart", [delayMs]),
    researchMissingJobs: (jobIds) => call("researchMissingJobs", [jobIds], 10 * 60 * 1000),
    setRetryCyclePaused: async (id, paused) => {
      const result = await call("setRetryCyclePaused", [id, paused]);
      dbOps.invalidateSettingsCache();
      return result;
    },
    updateWorkerSettings: async (settings) => {
      const result = await call("updateWorkerSettings", [settings]);
      dbOps.invalidateSettingsCache();
      return result;
    },
    checkPlaylistComplete: (id) => call("checkPlaylistComplete", [id], 10 * 60 * 1000),
    blockPlaylist: (id) => call("blockPlaylist", [id]),
    unblockPlaylist: (id) => call("unblockPlaylist", [id]),
    waitForPlaylistIdle: (id) => call("waitForPlaylistIdle", [id], 30 * 60 * 1000),
    waitForIdle: () => call("waitForIdle", [], 30 * 60 * 1000),
    pruneOrphanedJobState: () => call("pruneOrphanedJobState"),
    scheduleReuseLinkRepair: (force) => notify("scheduleReuseLinkRepair", [force]),
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
