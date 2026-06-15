import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { slskdClient } from "./slskdClient.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";
import { dbOps, userOps } from "../config/db-helpers.js";
import { resolveWeeklyFlowTrackContext } from "./weeklyFlowTrackResolver.js";
import { getListenHistoryProfile } from "./listeningHistory.js";
import {
  normalizeExistingFileMode,
  repairReusableTrackLinks,
  reuseTrackForPlaylist,
} from "./weeklyFlowFileReuse.js";
import { resolveWeeklyFlowRoot } from "./weeklyFlowPaths.js";
import { startSlskdOrchestratorWorker } from "./slskdOrchestratorWorker.js";
import { enqueuePlaylistRetryJob, withHonkerLock } from "./honkerDb.js";

const DEFAULT_CONCURRENCY = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 3;
const DEFAULT_RETRY_CYCLE_MINUTES = 360;
const JOB_COOLDOWN_MS = 750;
const REUSE_REPAIR_INTERVAL_MS = 30 * 60 * 1000;
const WORKER_STOPPED_CODE = "WORKER_STOPPED";
const PLAYLIST_MUTATION_CODE = "PLAYLIST_MUTATION_IN_PROGRESS";
const RETRY_JOB_REGISTRY_KEY = "weeklyFlowIncompleteRetryJobs";

export class WeeklyFlowWorker {
  constructor(
    weeklyFlowRoot = resolveWeeklyFlowRoot(),
  ) {
    this.weeklyFlowRoot = resolveWeeklyFlowRoot(weeklyFlowRoot);
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
    this.playlistReservePools = new Map();
    this.playlistRunDiagnostics = new Map();
    this.playlistFailureMemory = new Map();
    this.playlistFinalizing = new Set();
    this.reserveBuildsInFlight = new Set();
    this.downloadMetrics = {
      completedTracks: 0,
      completedTrackAttempts: 0,
      completedTrackLatencyMs: 0,
    };
  }

  _recordCompletedTrack(elapsedMs, attempts) {
    this.downloadMetrics.completedTracks += 1;
    this.downloadMetrics.completedTrackLatencyMs += Math.max(
      0,
      Math.round(Number(elapsedMs) || 0),
    );
    this.downloadMetrics.completedTrackAttempts += Math.max(
      1,
      Math.round(Number(attempts) || 1),
    );
  }

  _scheduleProcessIn(delayMs = JOB_COOLDOWN_MS) {
    const waitMs = Math.max(
      250,
      Math.floor(Number(delayMs) || JOB_COOLDOWN_MS),
    );
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

  _isPlaylistBlocked(playlistType) {
    return this.blockedPlaylistTypes.has(String(playlistType || ""));
  }

  _assertJobCanContinue(job, runGeneration) {
    if (runGeneration !== this.runGeneration) {
      throw this._createControlFlowError(WORKER_STOPPED_CODE, "Worker stopped");
    }
    if (this._isPlaylistBlocked(job?.playlistType)) {
      throw this._createControlFlowError(
        PLAYLIST_MUTATION_CODE,
        "Playlist mutation in progress",
      );
    }
  }

  blockPlaylist(playlistType) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    this.blockedPlaylistTypes.add(id);
    return true;
  }

  unblockPlaylist(playlistType) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    const removed = this.blockedPlaylistTypes.delete(id);
    if (removed && this.running) {
      this.wake();
    }
    return removed;
  }

  async waitForPlaylistIdle(playlistType) {
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
      const active = [...this.activeJobs.values()]
        .map((entry) => entry?.promise)
        .filter(Boolean);
      if (active.length === 0) {
        return;
      }
      await Promise.allSettled(active);
    }
  }

  _getRetryJobRegistry() {
    const raw = dbOps.getJSONSetting(RETRY_JOB_REGISTRY_KEY);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  _setRetryJobRegistry(registry) {
    dbOps.setJSONSetting(RETRY_JOB_REGISTRY_KEY, registry);
  }

  getScheduledRetryJobId(playlistType) {
    const key = String(playlistType || "").trim();
    if (!key) return null;
    const jobId = Number(this._getRetryJobRegistry()[key]);
    return Number.isFinite(jobId) ? jobId : null;
  }

  clearIncompleteRetry(playlistType) {
    const key = String(playlistType || "").trim();
    if (!key) return;
    const registry = this._getRetryJobRegistry();
    if (!(key in registry)) return;
    delete registry[key];
    this._setRetryJobRegistry(registry);
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

  _isRetryCyclePaused(playlistType) {
    if (!playlistType) return false;
    const paused = this._getRetryPausedPlaylistIds();
    return paused.includes(String(playlistType));
  }

  setRetryCyclePaused(playlistType, paused) {
    const id = String(playlistType || "").trim();
    if (!id) return false;
    const current = dbOps.getSettings();
    const worker = current?.playlistWorker || {};
    const pausedIds = new Set(
      this._normalizeRetryPausedPlaylistIds(worker.retryPausedPlaylistIds),
    );
    if (paused) {
      pausedIds.add(id);
      this.clearIncompleteRetry(id);
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

  getIncompleteRetryMap(playlistIds = []) {
    const scheduled = new Set(Object.keys(this._getRetryJobRegistry()));
    const out = {};
    for (const id of Array.isArray(playlistIds) ? playlistIds : []) {
      const key = String(id || "").trim();
      if (!key) continue;
      out[key] = scheduled.has(key);
    }
    return out;
  }

  _normalizeConcurrency(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(
      MAX_CONCURRENCY,
      Math.max(MIN_CONCURRENCY, Math.floor(parsed)),
    );
  }

  _normalizeExistingFileMode(value) {
    return normalizeExistingFileMode(value);
  }

  _getIncompleteRetryDelayMs() {
    return Math.max(1000, DEFAULT_RETRY_CYCLE_MINUTES * 60 * 1000);
  }
  _getNextReadyPendingJob(lastPlaylistType = null) {
    return downloadTracker.getNextPendingMatching(() => true, lastPlaylistType);
  }

  getWorkerSettings() {
    const settings = dbOps.getSettings();
    const raw = settings?.playlistWorker || {};
    return {
      concurrency: this._normalizeConcurrency(raw.concurrency),
      retryCycleMinutes: DEFAULT_RETRY_CYCLE_MINUTES,
      retryPausedPlaylistIds: this._normalizeRetryPausedPlaylistIds(
        raw.retryPausedPlaylistIds,
      ),
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
      retryCycleMinutes: DEFAULT_RETRY_CYCLE_MINUTES,
      retryPausedPlaylistIds: this._normalizeRetryPausedPlaylistIds(
        base.retryPausedPlaylistIds,
      ),
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

  _getPlaylistTargetCount(playlistType) {
    const key = String(playlistType || "").trim();
    const flow = flowPlaylistConfig.getFlow(key);
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(key);
    const achievedPrimary = Number(
      this.playlistRunDiagnostics.get(key)?.achieved?.primary,
    );
    if (Number.isFinite(achievedPrimary) && achievedPrimary > 0) {
      return Math.max(1, Math.floor(achievedPrimary));
    }
    const jobCount = downloadTracker.getByPlaylistType(key).length;
    if (jobCount > 0) {
      return jobCount;
    }
    const raw = Number(flow?.size || sharedPlaylist?.trackCount || 0);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.floor(raw));
  }

  _getPlaylistFailureState(playlistType) {
    const key = String(playlistType || "").trim();
    if (!key) {
      return {
        failedUsers: new Set(),
        queuedUsers: new Set(),
        failedTrackKeys: new Set(),
        terminalFailures: 0,
      };
    }
    let state = this.playlistFailureMemory.get(key);
    if (!state) {
      state = {
        failedUsers: new Set(),
        queuedUsers: new Set(),
        failedTrackKeys: new Set(),
        terminalFailures: 0,
      };
      this.playlistFailureMemory.set(key, state);
    }
    return state;
  }

  _recordPlaylistTerminalFailure(playlistType, job) {
    const state = this._getPlaylistFailureState(playlistType);
    state.terminalFailures += 1;
    const key = this._trackKeyFromJob(job);
    if (key) {
      state.failedTrackKeys.add(key);
    }
  }

  clearPlaylistRunState(playlistType) {
    const key = String(playlistType || "").trim();
    if (!key) return;
    this.clearIncompleteRetry(key);
    this.playlistReservePools.delete(key);
    this.playlistRunDiagnostics.delete(key);
    this.playlistFailureMemory.delete(key);
    this.playlistFinalizing.delete(key);
    this.reserveBuildsInFlight.delete(key);
  }

  _normalizeReserveTracks(tracks = []) {
    return (Array.isArray(tracks) ? tracks : []).filter(
      (track) =>
        track &&
        String(track?.artistName || "").trim() &&
        String(track?.trackName || "").trim(),
    );
  }

  setPlaylistRunPlan(playlistType, plan = {}) {
    const key = String(playlistType || "").trim();
    if (!key) return;
    this.playlistReservePools.set(
      key,
      this._normalizeReserveTracks(plan?.reserveTracks || []),
    );
    this.playlistRunDiagnostics.set(key, plan?.diagnostics || null);
    this.playlistFinalizing.delete(key);
    this._getPlaylistFailureState(key);
  }

  getPlaylistRunStatus(playlistType) {
    const key = String(playlistType || "").trim();
    const reserves = this.playlistReservePools.get(key) || [];
    const diagnostics = this.playlistRunDiagnostics.get(key) || null;
    const failures = this._getPlaylistFailureState(key);
    return {
      reserveDepth: reserves.length,
      diagnostics,
      failureSummary: {
        failedUsers: failures.failedUsers.size,
        queuedUsers: failures.queuedUsers.size,
        failedTracks: failures.failedTrackKeys.size,
        terminalFailures: failures.terminalFailures,
      },
    };
  }

  _getFlowListenHistoryProfile(flow) {
    const ownerUserId = Number(flow?.ownerUserId);
    if (!Number.isFinite(ownerUserId)) return null;
    const owner = userOps.getUserById(ownerUserId);
    return owner ? getListenHistoryProfile(owner) : null;
  }

  async runQueuedReserveBuild() {
    return { skipped: true };
  }

  async seedFlowRunWithTracks(playlistType, flow, tracks, options = {}) {
    const key = String(playlistType || "").trim();
    if (!key || !flow) {
      return { tracksQueued: 0, jobIds: [], reserveTracks: 0 };
    }
    const primaryTracks = Array.isArray(tracks) ? tracks : [];
    const plan = {
      primaryTracks,
      reserveTracks: [],
      diagnostics: {
        targets: { adopted: primaryTracks.length },
        achieved: { primary: primaryTracks.length, reserve: 0 },
      },
    };
    this.clearPlaylistRunState(key);
    this.setPlaylistRunPlan(key, plan);
    flowPlaylistConfig.markLastRunAt(key);
    const jobIds = downloadTracker.addJobs(primaryTracks, key);
    return {
      tracksQueued: primaryTracks.length,
      jobIds,
      reserveTracks: 0,
      reservePending: false,
    };
  }

  async seedFlowRun(playlistType, flow, options = {}) {
    const key = String(playlistType || "").trim();
    if (!key || !flow) {
      return { tracksQueued: 0, jobIds: [], reserveTracks: 0 };
    }
    const sizeOverride =
      Number.isFinite(Number(options?.size)) && Number(options.size) > 0
        ? Math.round(Number(options.size))
        : null;
    const plan = await playlistSource.buildFlowRunPlan(
      sizeOverride ? { ...flow, size: sizeOverride } : flow,
      {
        listenHistoryProfile: this._getFlowListenHistoryProfile(flow),
      },
    );
    this.clearPlaylistRunState(key);
    this.setPlaylistRunPlan(key, plan);
    const primaryTracks = Array.isArray(plan?.primaryTracks)
      ? plan.primaryTracks
      : [];
    flowPlaylistConfig.markLastRunAt(key);
    const jobIds = downloadTracker.addJobs(primaryTracks, key);
    return {
      tracksQueued: primaryTracks.length,
      jobIds,
      reserveTracks: 0,
      reservePending: false,
    };
  }

  _maybeStopWhenIdle() {
    if (!this.running) return;
    if (this.activeJobs.size > 0) return;
    if (this.reserveBuildsInFlight.size > 0) return;
    if (downloadTracker.getNextPending()) return;
    this.stop();
  }

  _hasReachedPlaylistTarget(playlistType) {
    const target = this._getPlaylistTargetCount(playlistType);
    if (!target) return false;
    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    return Number(stats?.done || 0) >= target;
  }

  _trackKeyFromJob(job) {
    const artist = String(job?.artistName || "")
      .trim()
      .toLowerCase();
    const track = String(job?.trackName || "")
      .trim()
      .toLowerCase();
    if (!artist || !track) return "";
    return `${artist}::${track}`;
  }

  _trackKeyFromTrack(track) {
    const artist = String(track?.artistName || "")
      .trim()
      .toLowerCase();
    const name = String(track?.trackName || "")
      .trim()
      .toLowerCase();
    if (!artist || !name) return "";
    return `${artist}::${name}`;
  }

  _artistKeyFromJob(job) {
    return String(job?.artistName || "")
      .trim()
      .toLowerCase();
  }

  _artistKeyFromTrack(track) {
    return String(track?.artistName || "")
      .trim()
      .toLowerCase();
  }

  _dropOverflowPendingJobs(playlistType) {
    if (!this._hasReachedPlaylistTarget(playlistType)) return 0;
    const jobs = downloadTracker.getByPlaylistType(playlistType);
    let removed = 0;
    for (const job of jobs) {
      if (job.status === "done") continue;
      if (downloadTracker.removeJob(job.id)) {
        removed += 1;
      }
    }
    return removed;
  }

  _requeueFailedJobs(playlistType, reason = null) {
    if (this._isRetryCyclePaused(playlistType)) return 0;
    const jobs = downloadTracker.getByPlaylistType(playlistType);
    let requeued = 0;
    for (const job of jobs) {
      if (job.status !== "failed") continue;
      const priorError = String(job?.error || "").trim();
      const retryReason = [String(reason || "").trim(), priorError]
        .filter(Boolean)
        .join(" • ");
      if (
        downloadTracker.setPending(job.id, retryReason || null, {
          asRetryCycle: true,
        })
      ) {
        requeued += 1;
      }
    }
    return requeued;
  }

  _scheduleIncompleteRetry(
    playlistType,
    delayMs = this._getIncompleteRetryDelayMs(),
  ) {
    if (!playlistType) return;
    if (this._isRetryCyclePaused(playlistType)) {
      this.clearIncompleteRetry(playlistType);
      return;
    }
    if (
      !flowPlaylistConfig.getFlow(playlistType) &&
      !flowPlaylistConfig.getSharedPlaylist(playlistType)
    ) {
      this.clearIncompleteRetry(playlistType);
      return;
    }
    if (this.getScheduledRetryJobId(playlistType) != null) return;
    const waitMs = Math.max(
      1000,
      Math.floor(Number(delayMs) || this._getIncompleteRetryDelayMs()),
    );
    const jobId = enqueuePlaylistRetryJob(
      {
        playlistType,
        requestedAt: Date.now(),
      },
      {
        delaySeconds: Math.ceil(waitMs / 1000),
      },
    );
    const registry = this._getRetryJobRegistry();
    registry[String(playlistType)] = jobId;
    this._setRetryJobRegistry(registry);
  }

  markIncompleteRetryDequeued(playlistType, jobId = null) {
    const key = String(playlistType || "").trim();
    if (!key) return;
    const registry = this._getRetryJobRegistry();
    if (!(key in registry)) return;
    if (jobId != null && Number(registry[key]) !== Number(jobId)) return;
    delete registry[key];
    this._setRetryJobRegistry(registry);
  }

  restoreScheduledRetryJobId(playlistType, jobId) {
    const key = String(playlistType || "").trim();
    if (!key || jobId == null) return;
    const registry = this._getRetryJobRegistry();
    if (key in registry) return;
    registry[key] = jobId;
    this._setRetryJobRegistry(registry);
  }

  async retryIncompletePlaylist(playlistType) {
    if (this._isRetryCyclePaused(playlistType)) {
      this.clearIncompleteRetry(playlistType);
      return 0;
    }
    const flow = flowPlaylistConfig.getFlow(playlistType);
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (!flow && !sharedPlaylist) {
      this.clearIncompleteRetry(playlistType);
      return 0;
    }
    if (flow && flow.enabled !== true) {
      this.clearIncompleteRetry(playlistType);
      return 0;
    }
    if (this._isPlaylistBlocked(playlistType)) {
      this._scheduleIncompleteRetry(playlistType, 60 * 1000);
      return 0;
    }

    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    const target = this._getPlaylistTargetCount(playlistType);
    if (!target || stats.done >= target) {
      this.clearIncompleteRetry(playlistType);
      return 0;
    }
    if (stats.pending > 0 || stats.downloading > 0) {
      if (this.running) {
        this.wake();
      } else {
        await this.start();
      }
      return 0;
    }

    const changed = this._requeueFailedJobs(
      playlistType,
      "Retrying incomplete playlist",
    );

    if (changed > 0) {
      if (this.running) {
        this.wake();
      } else {
        await this.start();
      }
      return changed;
    }

    this._scheduleIncompleteRetry(playlistType);
    return 0;
  }

  async repairReusableLinks(force = false) {
    const now = Date.now();
    if (!force && now - this.lastReuseRepairAt < REUSE_REPAIR_INTERVAL_MS) {
      return null;
    }
    this.lastReuseRepairAt = now;
    const { existingFileMode } = this.getWorkerSettings();
    if (normalizeExistingFileMode(existingFileMode) === "download") {
      return null;
    }
    const result = await repairReusableTrackLinks({
      existingFileMode,
      weeklyFlowRoot: this.weeklyFlowRoot,
      cursor: this.reuseRepairCursor,
    });
    if (Number.isFinite(result?.nextCursor)) {
      this.reuseRepairCursor = result.nextCursor;
    }
    return result;
  }

  scheduleReuseLinkRepair(force = false) {
    if (this.reuseRepairInFlight) return;
    this.reuseRepairInFlight = this.repairReusableLinks(force)
      .catch((error) => {
        console.warn(
          `[WeeklyFlowWorker] Reuse link repair failed: ${error?.message || error}`,
        );
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
    startSlskdOrchestratorWorker();
    console.log("[WeeklyFlowWorker] Starting worker...");

    this.processLoop = () => {
      if (!this.running) return;
      const { concurrency } = this.getWorkerSettings();
      while (this.activeCount < concurrency) {
        const job = this._getNextReadyPendingJob(
          this.lastDequeuedPlaylistType,
        );
        if (!job) {
          break;
        }
        this.lastDequeuedPlaylistType = job.playlistType;
        if (this._hasReachedPlaylistTarget(job.playlistType)) {
          downloadTracker.removeJob(job.id);
          continue;
        }
        if (this._isPlaylistBlocked(job.playlistType)) {
          downloadTracker.deferPendingToBack(
            job.id,
            "Playlist mutation in progress",
            {
              keepRetryTier: true,
            },
          );
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
            console.error(
              `[WeeklyFlowWorker] Error processing job ${job.id}:`,
              error.message,
            );
            this._recordPlaylistTerminalFailure(job.playlistType, job);
            downloadTracker.setFailed(job.id, error.message);
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
    this.playlistReservePools.clear();
    this.playlistRunDiagnostics.clear();
    this.playlistFailureMemory.clear();
    this.playlistFinalizing.clear();
    this.reserveBuildsInFlight.clear();
    console.log("[WeeklyFlowWorker] Worker stopped");
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
      `[WeeklyFlowWorker] Processing job ${job.id}: ${job.artistName} - ${job.trackName} (${job.playlistType})`,
    );

    const perfStartCpu = process.cpuUsage();
    const perfStartHr = process.hrtime.bigint();
    const timingsMs = {
      completionCheck: 0,
    };

    this._assertJobCanContinue(job, runGeneration);

    try {
      let phaseStart = process.hrtime.bigint();
      const resolvedTrack = await resolveWeeklyFlowTrackContext(job);
      downloadTracker.updateMetadata(job.id, resolvedTrack);
      Object.assign(job, resolvedTrack);
      const { existingFileMode } = this.getWorkerSettings();
      if (existingFileMode !== "download") {
        const reuse = await reuseTrackForPlaylist(resolvedTrack, job.playlistType, {
          existingFileMode,
          weeklyFlowRoot: this.weeklyFlowRoot,
          existingJobId: job.id,
          excludeJobIds: [job.id],
        });
        if (reuse.reused) {
          this._dropOverflowPendingJobs(job.playlistType);
          this._recordCompletedTrack(
            Number(process.hrtime.bigint() - perfStartHr) / 1e6,
            0,
          );
          phaseStart = process.hrtime.bigint();
          this._assertJobCanContinue(job, runGeneration);
          await this.checkPlaylistComplete(job.playlistType);
          timingsMs.completionCheck +=
            Number(process.hrtime.bigint() - phaseStart) / 1e6;
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
      }
      if (!slskdClient.isConfigured()) {
        throw new Error("slskd not configured");
      }
      downloadTracker.enqueueSlskdPipeline(job.id);
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

  async checkPlaylistComplete(playlistType) {
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
            this.clearIncompleteRetry(playlistType);
            console.log(
              `[WeeklyFlowWorker] All jobs complete for ${playlistType}, ensuring playlists...`,
            );
            try {
              await fs.rm(path.join(this.weeklyFlowRoot, "_fallback"), {
                recursive: true,
                force: true,
              });
            } catch {}
            try {
              playlistManager.updateConfig(false);
              await playlistManager.ensurePlaylists();
              await playlistManager.scheduleScanLibrary(true);
              if (flowPlaylistConfig.isEnabled(playlistType)) {
                flowPlaylistConfig.scheduleNextRun(playlistType);
              }
            } catch (error) {
              console.error(
                `[WeeklyFlowWorker] Failed to ensure playlists for ${playlistType}:`,
                error.message,
              );
            }

            const flow = flowPlaylistConfig.getFlow(playlistType);
            const completed = done;
            const { notifyWeeklyFlowDone } = await import(
              "./notificationService.js"
            );
            notifyWeeklyFlowDone(
              playlistType,
              { completed, failed },
              path.join(playlistManager.libraryRoot, playlistType),
              flow ? flow.name : playlistType,
            ).catch((err) =>
              console.warn(
                "[WeeklyFlowWorker] Gotify notification failed:",
                err.message,
              ),
            );
            import("./slskdClient.js")
              .then(({ slskdClient, isSlskdCleanupAfterRunsEnabled }) => {
                if (!isSlskdCleanupAfterRunsEnabled()) return null;
                const globalStats = downloadTracker.getStats();
                if (globalStats.pending > 0 || globalStats.downloading > 0) {
                  return null;
                }
                return slskdClient.cleanupAfterRun();
              })
              .catch((err) =>
                console.warn(
                  "[WeeklyFlowWorker] slskd cleanup failed:",
                  err?.message || err,
                ),
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
      ...flowPlaylistConfig.getSharedPlaylists().map((playlist) => playlist.id),
    ]);
    for (const jobId of [...this.activeJobs.keys()]) {
      if (downloadTracker.getJob(jobId)) continue;
      this.activeJobs.delete(jobId);
    }
    for (const playlistId of [...this.blockedPlaylistTypes]) {
      if (activePlaylistIds.has(playlistId)) continue;
      this.blockedPlaylistTypes.delete(playlistId);
    }
    for (const map of [
      this.playlistReservePools,
      this.playlistRunDiagnostics,
      this.playlistFailureMemory,
    ]) {
      for (const playlistId of [...map.keys()]) {
        if (activePlaylistIds.has(playlistId)) continue;
        map.delete(playlistId);
      }
    }
    for (const playlistId of Object.keys(this._getRetryJobRegistry())) {
      if (activePlaylistIds.has(playlistId)) continue;
      this.clearIncompleteRetry(playlistId);
    }
    for (const set of [this.playlistFinalizing, this.reserveBuildsInFlight]) {
      for (const playlistId of [...set]) {
        if (activePlaylistIds.has(playlistId)) continue;
        set.delete(playlistId);
      }
    }
  }

  getStatus() {
    const settings = this.getWorkerSettings();
    const completedTracks = Number(this.downloadMetrics.completedTracks || 0);
    const playlistRuns = {};
    for (const playlistType of new Set([
      ...this.playlistReservePools.keys(),
      ...this.playlistRunDiagnostics.keys(),
      ...this.playlistFailureMemory.keys(),
    ])) {
      playlistRuns[playlistType] = this.getPlaylistRunStatus(playlistType);
    }
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
            ? Number(
                (
                  this.downloadMetrics.completedTrackAttempts / completedTracks
                ).toFixed(2),
              )
            : 0,
        avgSuccessLatencyMs:
          completedTracks > 0
            ? Math.round(
                this.downloadMetrics.completedTrackLatencyMs / completedTracks,
              )
            : 0,
      },
      playlistRuns,
      settings,
    };
  }
}

export const weeklyFlowWorker = new WeeklyFlowWorker();
