import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { soulseekClient } from "./simpleSoulseekClient.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";
import { dbOps, userOps } from "../config/db-helpers.js";
import { resolveWeeklyFlowTrackContext } from "./weeklyFlowTrackResolver.js";
import { getListenHistoryProfile } from "./listeningHistory.js";
import {
  buildFlowSearchQueries,
  rankFlowSearchResults,
  selectRankedMatchAttempts,
  validateDownloadedTrack,
} from "./weeklyFlowSoulseekMatcher.js";
import {
  normalizeExistingFileMode,
  repairReusableTrackLinks,
  reuseTrackForPlaylist,
} from "./weeklyFlowFileReuse.js";
import { resolveWeeklyFlowRoot } from "./weeklyFlowPaths.js";

const DEFAULT_CONCURRENCY = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 3;
const DEFAULT_PREFERRED_FORMAT = "flac";
const DEFAULT_PREFERRED_FORMAT_STRICT = false;
const FLOW_WORKER_RETRY_CYCLE_OPTIONS_MINUTES = [15, 30, 60, 360, 720, 1440];
const DEFAULT_RETRY_CYCLE_MINUTES = 15;
const JOB_COOLDOWN_MS = 750;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 120000;
const AUTH_FAILURE_PAUSE_MS = 45000;
const CONNECTIVITY_FAILURE_PAUSE_MS = 15000;
const RETRYABLE_FAILURE_STREAK_THRESHOLD = 3;
const RETRYABLE_FAILURE_STREAK_PAUSE_MS = 180000;
const MAX_MATCH_CANDIDATES = 8;
const RETRY_MATCH_CANDIDATES = 14;
const MAX_RETRY_MATCH_CANDIDATES = 28;
const STRICT_FORMAT_MATCH_CANDIDATES = 40;
const STRICT_RETRY_MATCH_CANDIDATES = 28;
const MAX_DOWNLOAD_ATTEMPTS_PER_JOB = 7;
const MAX_DOWNLOAD_ATTEMPTS_PER_RETRY = 9;
const FALLBACK_MP3_REGEX = /^[^/\\]+-[a-f0-9]{8}\.mp3$/i;
const FALLBACK_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const REUSE_REPAIR_INTERVAL_MS = 30 * 60 * 1000;
const MAX_RETRIES_PER_JOB = 1;
const MAX_RETRIES_FOR_TIMEOUT_LOGIN = 1;
const MAX_RETRIES_FOR_QUEUED_DOWNLOAD = 2;
const MAX_RETRIES_FOR_OFFLINE_SOURCE = 3;
const QUEUED_RETRY_BASE_DELAY_MS = 15 * 1000;
const QUEUED_RETRY_MAX_DELAY_MS = 45 * 1000;
const FAST_FLAC_PRIMARY_ATTEMPTS = 2;
const NON_RETRYABLE_ERRORS = new Set([
  "No search results found",
  "No candidate files returned",
]);
const SUPPORTED_PREFERRED_FORMATS = new Set(["flac", "mp3"]);
const WORKER_STOPPED_CODE = "WORKER_STOPPED";
const PLAYLIST_MUTATION_CODE = "PLAYLIST_MUTATION_IN_PROGRESS";

export class WeeklyFlowWorker {
  constructor(
    weeklyFlowRoot = resolveWeeklyFlowRoot(),
  ) {
    this.weeklyFlowRoot = resolveWeeklyFlowRoot(weeklyFlowRoot);
    this.running = false;
    this.activeCount = 0;
    this.lastFallbackSweepAt = 0;
    this.lastReuseRepairAt = 0;
    this.reuseRepairCursor = 0;
    this.processLoop = null;
    this.processTimer = null;
    this.retryAttempts = new Map();
    this.retryNotBefore = new Map();
    this.retryableFailureStreak = 0;
    this.backupRefillRounds = new Map();
    this.currentJob = null;
    this.pausedUntil = 0;
    this.lastDequeuedPlaylistType = null;
    this.fallbackSweepInFlight = null;
    this.fallbackSweepTimer = null;
    this.reuseRepairInFlight = null;
    this.lastJobMetrics = null;
    this.sanitizeCache = new Map();
    this.incompleteRetryTimers = new Map();
    this.activeJobs = new Map();
    this.blockedPlaylistTypes = new Set();
    this.runGeneration = 0;
    this.playlistReservePools = new Map();
    this.playlistRunDiagnostics = new Map();
    this.playlistFailureMemory = new Map();
    this.playlistFinalizing = new Set();
    this.reserveBuildsInFlight = new Set();
    this.downloadMetrics = {
      queuedFailures: 0,
      offlineFailures: 0,
      validationRejects: 0,
      mp3FallbackActivations: 0,
      completedTracks: 0,
      completedTrackAttempts: 0,
      completedTrackLatencyMs: 0,
    };
  }

  _recordFailureMetric(message) {
    if (this._isSlowSourceError(message)) {
      this.downloadMetrics.queuedFailures += 1;
      return;
    }
    if (this._isOfflineSourceError(message)) {
      this.downloadMetrics.offlineFailures += 1;
      return;
    }
    if (String(message || "").toLowerCase().includes("validation failed")) {
      this.downloadMetrics.validationRejects += 1;
    }
  }

  _recordMp3FallbackActivation() {
    this.downloadMetrics.mp3FallbackActivations += 1;
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

  pruneOrphanedJobState() {
    for (const jobId of [...this.retryAttempts.keys()]) {
      if (!downloadTracker.getJob(jobId)) {
        this.retryAttempts.delete(jobId);
      }
    }
    for (const jobId of [...this.retryNotBefore.keys()]) {
      if (!downloadTracker.getJob(jobId)) {
        this.retryNotBefore.delete(jobId);
      }
    }
  }

  clearIncompleteRetry(playlistType) {
    const timer = this.incompleteRetryTimers.get(playlistType);
    if (timer) {
      clearTimeout(timer);
      this.incompleteRetryTimers.delete(playlistType);
    }
  }

  _rescheduleIncompleteRetries(
    delayMs = this._getIncompleteRetryDelayMs(),
  ) {
    const playlistTypes = [...this.incompleteRetryTimers.keys()];
    if (playlistTypes.length === 0) return 0;
    for (const playlistType of playlistTypes) {
      this.clearIncompleteRetry(playlistType);
    }
    for (const playlistType of playlistTypes) {
      this._scheduleIncompleteRetry(playlistType, delayMs);
    }
    return playlistTypes.length;
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
    const raw = settings?.weeklyFlowWorker || {};
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
    const worker = current?.weeklyFlowWorker || {};
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
      weeklyFlowWorker: {
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
    const scheduled = new Set(this.incompleteRetryTimers.keys());
    const out = {};
    for (const id of Array.isArray(playlistIds) ? playlistIds : []) {
      const key = String(id || "").trim();
      if (!key) continue;
      out[key] = scheduled.has(key);
    }
    return out;
  }

  _isAuthFailure(message) {
    const text = String(message || "").toLowerCase();
    return text.includes("timeout login") || text.includes("invalidpass");
  }

  _isConnectivityFailure(message) {
    const text = String(message || "").toLowerCase();
    return (
      text.includes("download timeout") ||
      text.includes("download stalled") ||
      text.includes("econnreset") ||
      text.includes("etimedout") ||
      text.includes("socket hang up")
    );
  }

  _isSlowSourceError(message) {
    const text = String(message || "").toLowerCase();
    return (
      text.includes("download queued") ||
      text.includes("download stalled (no bytes received)")
    );
  }

  _isOfflineSourceError(message) {
    const lower = String(message || "").toLowerCase();
    return lower.includes("user not exist") || lower.includes("user offline");
  }

  _isNonRetryableError(message) {
    const text = String(message || "").trim();
    if (!text) return false;
    if (NON_RETRYABLE_ERRORS.has(text)) return true;
    return false;
  }

  _getRetryLimitForError(message) {
    if (this._isSlowSourceError(message)) return MAX_RETRIES_FOR_QUEUED_DOWNLOAD;
    if (this._isOfflineSourceError(message)) return MAX_RETRIES_FOR_OFFLINE_SOURCE;
    if (this._isAuthFailure(message)) return MAX_RETRIES_FOR_TIMEOUT_LOGIN;
    return MAX_RETRIES_PER_JOB;
  }

  _getRetryDelayMs(attempt, message) {
    if (this._isSlowSourceError(message)) {
      return Number(attempt) <= 1
        ? QUEUED_RETRY_BASE_DELAY_MS
        : QUEUED_RETRY_MAX_DELAY_MS;
    }
    if (this._isOfflineSourceError(message)) {
      return Math.min(
        RETRY_MAX_DELAY_MS,
        5000 * 2 ** Math.max(0, Number(attempt) - 1),
      );
    }
    const exp = Math.max(0, Number(attempt) - 1);
    const base = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exp);
    if (this._isAuthFailure(message)) {
      return Math.max(base, AUTH_FAILURE_PAUSE_MS);
    }
    if (this._isConnectivityFailure(message)) {
      return Math.max(base, CONNECTIVITY_FAILURE_PAUSE_MS);
    }
    return base;
  }

  _pauseWorker(ms) {
    const until = Date.now() + Math.max(0, Number(ms) || 0);
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  _recordRetryableFailure() {
    this.retryableFailureStreak += 1;
    if (this.retryableFailureStreak >= RETRYABLE_FAILURE_STREAK_THRESHOLD) {
      this._pauseWorker(RETRYABLE_FAILURE_STREAK_PAUSE_MS);
      this.retryableFailureStreak = 0;
    }
  }

  _resetFailureStreak() {
    this.retryableFailureStreak = 0;
  }

  _normalizeConcurrency(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(
      MAX_CONCURRENCY,
      Math.max(MIN_CONCURRENCY, Math.floor(parsed)),
    );
  }

  _normalizePreferredFormat(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (SUPPORTED_PREFERRED_FORMATS.has(normalized)) {
      return normalized;
    }
    return DEFAULT_PREFERRED_FORMAT;
  }

  _normalizePreferredFormatStrict(value) {
    return value === true ? true : DEFAULT_PREFERRED_FORMAT_STRICT;
  }

  _normalizeRetryCycleMinutes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_RETRY_CYCLE_MINUTES;
    const normalized = Math.floor(parsed);
    if (FLOW_WORKER_RETRY_CYCLE_OPTIONS_MINUTES.includes(normalized)) {
      return normalized;
    }
    return DEFAULT_RETRY_CYCLE_MINUTES;
  }

  _normalizeExistingFileMode(value) {
    return normalizeExistingFileMode(value);
  }

  _getIncompleteRetryDelayMs() {
    const { retryCycleMinutes } = this.getWorkerSettings();
    return Math.max(1000, retryCycleMinutes * 60 * 1000);
  }
  _getAdaptiveMatchLimit(preferredFormatStrict, retryAttempt) {
    if (preferredFormatStrict) {
      if (retryAttempt >= 2) return STRICT_FORMAT_MATCH_CANDIDATES;
      if (retryAttempt >= 1) return STRICT_RETRY_MATCH_CANDIDATES;
      return RETRY_MATCH_CANDIDATES;
    }
    if (retryAttempt >= 2) return MAX_RETRY_MATCH_CANDIDATES;
    if (retryAttempt >= 1) return RETRY_MATCH_CANDIDATES;
    return MAX_MATCH_CANDIDATES;
  }

  _getNextReadyPendingJob(lastPlaylistType = null) {
    const now = Date.now();
    return downloadTracker.getNextPendingMatching((job) => {
      const notBefore = Number(this.retryNotBefore.get(job.id) || 0);
      return notBefore <= now;
    }, lastPlaylistType);
  }

  _getNextPendingWakeDelayMs() {
    const now = Date.now();
    let nextDelay = null;
    for (const job of downloadTracker.getByStatus("pending")) {
      const notBefore = Number(this.retryNotBefore.get(job.id) || 0);
      if (notBefore <= now) return 0;
      const delay = Math.max(250, notBefore - now);
      nextDelay = nextDelay == null ? delay : Math.min(nextDelay, delay);
    }
    return nextDelay;
  }

  getWorkerSettings() {
    const settings = dbOps.getSettings();
    const raw = settings?.weeklyFlowWorker || {};
    return {
      concurrency: this._normalizeConcurrency(raw.concurrency),
      preferredFormat: this._normalizePreferredFormat(raw.preferredFormat),
      preferredFormatStrict: this._normalizePreferredFormatStrict(
        raw.preferredFormatStrict,
      ),
      retryCycleMinutes: this._normalizeRetryCycleMinutes(
        raw.retryCycleMinutes,
      ),
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
      preferredFormat:
        nextSettings.preferredFormat === undefined
          ? base.preferredFormat
          : this._normalizePreferredFormat(nextSettings.preferredFormat),
      preferredFormatStrict:
        nextSettings.preferredFormatStrict === undefined
          ? base.preferredFormatStrict
          : this._normalizePreferredFormatStrict(
              nextSettings.preferredFormatStrict,
            ),
      retryCycleMinutes:
        nextSettings.retryCycleMinutes === undefined
          ? base.retryCycleMinutes
          : this._normalizeRetryCycleMinutes(nextSettings.retryCycleMinutes),
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
      weeklyFlowWorker: normalized,
    });
    if (normalized.retryCycleMinutes !== base.retryCycleMinutes) {
      this._rescheduleIncompleteRetries(
        Math.max(1000, normalized.retryCycleMinutes * 60 * 1000),
      );
    }
    return normalized;
  }

  _getPlaylistTargetCount(playlistType) {
    const flow = flowPlaylistConfig.getFlow(playlistType);
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
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

  _recordPlaylistCandidateFailure(playlistType, job, message, candidate = null) {
    const state = this._getPlaylistFailureState(playlistType);
    const text = String(message || "").toLowerCase();
    const user = String(candidate?.raw?.user || candidate?.user || "")
      .trim()
      .toLowerCase();
    if (user) {
      if (this._isSlowSourceError(text)) {
        state.queuedUsers.add(user);
      }
      if (this._isOfflineSourceError(text)) {
        state.failedUsers.add(user);
      }
    }
    if (String(text).includes("validation failed")) {
      const key = this._trackKeyFromJob(job);
      if (key) state.failedTrackKeys.add(key);
    }
  }

  _recordPlaylistTerminalFailure(playlistType, job, message) {
    const state = this._getPlaylistFailureState(playlistType);
    state.terminalFailures += 1;
    const key = this._trackKeyFromJob(job);
    if (key) {
      state.failedTrackKeys.add(key);
    }
    const lower = String(message || "").toLowerCase();
    if (this._isOfflineSourceError(lower)) {
      const user = String(job?.lastFailedUser || "").trim().toLowerCase();
      if (user) state.failedUsers.add(user);
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
      reserveTracks: Array.isArray(plan?.reserveTracks)
        ? plan.reserveTracks.length
        : 0,
    };
  }

  _consumeReserveTracks(playlistType, shortfall) {
    const key = String(playlistType || "").trim();
    const reserves = this.playlistReservePools.get(key) || [];
    if (!key || reserves.length === 0 || shortfall <= 0) return [];
    const existingTrackKeys = new Set(
      downloadTracker
        .getByPlaylistType(key)
        .map((job) => this._trackKeyFromJob(job))
        .filter(Boolean),
    );
    const existingArtistKeys = new Set(
      downloadTracker
        .getByPlaylistType(key)
        .map((job) => this._artistKeyFromJob(job))
        .filter(Boolean),
    );
    const picked = [];
    const remaining = [];
    for (const track of reserves) {
      const trackKey = this._trackKeyFromTrack(track);
      const artistKey = this._artistKeyFromTrack(track);
      if (
        picked.length < shortfall &&
        trackKey &&
        !existingTrackKeys.has(trackKey) &&
        (!artistKey || !existingArtistKeys.has(artistKey))
      ) {
        picked.push(track);
        existingTrackKeys.add(trackKey);
        if (artistKey) existingArtistKeys.add(artistKey);
      } else {
        remaining.push(track);
      }
    }
    this.playlistReservePools.set(key, remaining);
    return picked;
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
        this.retryAttempts.delete(job.id);
        this.retryNotBefore.delete(job.id);
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
      this.retryAttempts.delete(job.id);
      this.retryNotBefore.delete(job.id);
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
    if (this.incompleteRetryTimers.has(playlistType)) return;
    const waitMs = Math.max(
      1000,
      Math.floor(Number(delayMs) || this._getIncompleteRetryDelayMs()),
    );
    const timer = setTimeout(() => {
      this.incompleteRetryTimers.delete(playlistType);
      this.retryIncompletePlaylist(playlistType).catch((error) => {
        console.error(
          `[WeeklyFlowWorker] Failed incomplete retry for ${playlistType}:`,
          error.message,
        );
        this._scheduleIncompleteRetry(playlistType);
      });
    }, waitMs);
    this.incompleteRetryTimers.set(playlistType, timer);
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

    let changed = 0;
    if (flow) {
      const shortfall = Math.max(0, target - Number(stats.done || 0));
      if (shortfall > 0) {
        changed += await this._enqueueBackupJobs(playlistType, shortfall);
      }
    }
    changed += this._requeueFailedJobs(
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

  async _enqueueBackupJobs(playlistType, shortfall) {
    const target = this._getPlaylistTargetCount(playlistType);
    const flow = flowPlaylistConfig.getFlow(playlistType);
    if (!target || !flow || shortfall <= 0) return 0;
    let added = 0;
    const reserveTracks = this._consumeReserveTracks(playlistType, shortfall);
    if (reserveTracks.length > 0) {
      added += downloadTracker.addJobs(reserveTracks, playlistType).length;
    }
    const remainingShortfall = Math.max(0, shortfall - added);
    if (remainingShortfall <= 0) {
      return added;
    }
    const rounds = Number(this.backupRefillRounds.get(playlistType) || 0);
    const requestSize = Math.max(remainingShortfall, Math.min(target, Math.max(remainingShortfall * 2, 8)));
    const existingKeys = new Set(
      downloadTracker
        .getByPlaylistType(playlistType)
        .map((job) => this._trackKeyFromJob(job))
        .filter(Boolean),
    );
    const existingArtistKeys = new Set(
      downloadTracker
        .getByPlaylistType(playlistType)
        .map((job) => this._artistKeyFromJob(job))
        .filter(Boolean),
    );
    const failures = this._getPlaylistFailureState(playlistType);
    for (const failedTrackKey of failures.failedTrackKeys) {
      existingKeys.add(failedTrackKey);
    }
    this.reserveBuildsInFlight.add(String(playlistType));
    const plan = await playlistSource
      .buildFlowRunPlan(
        { ...flow, size: requestSize },
        {
          reserveSize: Math.max(Math.ceil(target * 0.25), 4),
          excludeArtistKeys: existingArtistKeys,
          excludeTrackKeys: existingKeys,
          listenHistoryProfile: this._getFlowListenHistoryProfile(flow),
        },
      )
      .catch(() => null)
      .finally(() => {
        this.reserveBuildsInFlight.delete(String(playlistType));
      });
    const unique = Array.isArray(plan?.primaryTracks) ? plan.primaryTracks : [];
    const reserve = Array.isArray(plan?.reserveTracks) ? plan.reserveTracks : [];
    if (plan) {
      const currentReserve = this.playlistReservePools.get(String(playlistType)) || [];
      this.playlistReservePools.set(
        String(playlistType),
        [
          ...currentReserve,
          ...reserve.filter((track) => {
            const key = this._trackKeyFromTrack(track);
            const artistKey = this._artistKeyFromTrack(track);
            if (!key || existingKeys.has(key)) return false;
            if (artistKey && existingArtistKeys.has(artistKey)) return false;
            existingKeys.add(key);
            if (artistKey) existingArtistKeys.add(artistKey);
            return true;
          }),
        ],
      );
      this.playlistRunDiagnostics.set(String(playlistType), plan?.diagnostics || null);
    }
    if (unique.length === 0) return added;
    added += downloadTracker.addJobs(unique, playlistType).length;
    if (added > 0) {
      console.log(
        `[WeeklyFlowWorker] Enqueued ${added} replacement tracks for ${playlistType} (shortfall ${shortfall})`,
      );
    }
    return added;
  }

  async moveFallbackMp3sToDir(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFallbackSweepAt < FALLBACK_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastFallbackSweepAt = now;
    const cwd = process.cwd();
    if (path.resolve(cwd) === path.resolve(this.weeklyFlowRoot)) return;
    const fallbackDir = path.join(this.weeklyFlowRoot, "_fallback");
    try {
      const entries = await fs.readdir(cwd, { withFileTypes: true });
      const toMove = entries.filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith(".mp3") &&
          FALLBACK_MP3_REGEX.test(e.name),
      );
      if (toMove.length === 0) return;
      await fs.mkdir(fallbackDir, { recursive: true });
      for (const e of toMove) {
        const src = path.join(cwd, e.name);
        const dest = path.join(fallbackDir, e.name);
        try {
          await fs.rename(src, dest);
        } catch {}
      }
    } catch {}
  }

  scheduleFallbackSweep(force = false) {
    if (this.fallbackSweepInFlight) return;
    this.fallbackSweepInFlight = this.moveFallbackMp3sToDir(force)
      .catch(() => {})
      .finally(() => {
        this.fallbackSweepInFlight = null;
      });
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
    console.log("[WeeklyFlowWorker] Starting worker...");
    await this.moveFallbackMp3sToDir(true);
    this.scheduleReuseLinkRepair(true);
    this.fallbackSweepTimer = setInterval(() => {
      if (!this.running) return;
      this.scheduleFallbackSweep(false);
      this.scheduleReuseLinkRepair(false);
    }, FALLBACK_SWEEP_INTERVAL_MS);

    this.processLoop = () => {
      if (!this.running) return;
      const now = Date.now();
      if (this.pausedUntil > now) {
        this._scheduleProcessIn(this.pausedUntil - now);
        return;
      }
      const { concurrency } = this.getWorkerSettings();
      while (this.activeCount < concurrency) {
        const job = this._getNextReadyPendingJob(
          this.lastDequeuedPlaylistType,
        );
        if (!job) {
          const waitMs = this._getNextPendingWakeDelayMs();
          if (waitMs != null) {
            this._scheduleProcessIn(waitMs);
          }
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
              this.retryAttempts.delete(job.id);
              this.retryNotBefore.delete(job.id);
              return;
            }
            const attempts = Number(this.retryAttempts.get(job.id) || 0);
            const message = String(error?.message || "");
            const retryable = !this._isNonRetryableError(message);
            const retryLimit = this._getRetryLimitForError(message);
            if (retryable && attempts < retryLimit) {
              const retryAttempt = attempts + 1;
              this.retryAttempts.set(job.id, retryAttempt);
              const slowSourceError = this._isSlowSourceError(message);
              if (!slowSourceError) {
                this._recordRetryableFailure();
              }
              const retryDelayMs = this._getRetryDelayMs(retryAttempt, message);
              this.retryNotBefore.set(job.id, Date.now() + retryDelayMs);
              console.warn(
                `[WeeklyFlowWorker] Requeueing job ${job.id}: ${message} (attempt ${retryAttempt}/${retryLimit} in ${Math.ceil(retryDelayMs / 1000)}s)`,
              );
              if (this._isAuthFailure(message)) {
                this._pauseWorker(AUTH_FAILURE_PAUSE_MS);
              } else if (!slowSourceError && this._isConnectivityFailure(message)) {
                this._pauseWorker(CONNECTIVITY_FAILURE_PAUSE_MS);
              }
              downloadTracker.setPending(
                job.id,
                slowSourceError
                  ? `Remote source slow; retrying in ${Math.ceil(retryDelayMs / 1000)}s (attempt ${retryAttempt}/${retryLimit})`
                  : `${message} (retry ${retryAttempt}/${retryLimit} in ${Math.ceil(retryDelayMs / 1000)}s)`,
                {
                  asRetryCycle: true,
                },
              );
              return;
            }
            this._resetFailureStreak();
            this.retryAttempts.delete(job.id);
            this.retryNotBefore.delete(job.id);
            console.error(
              `[WeeklyFlowWorker] Error processing job ${job.id}:`,
              error.message,
            );
            this._recordPlaylistTerminalFailure(
              job.playlistType,
              job,
              error.message,
            );
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
    if (this.fallbackSweepTimer) {
      clearInterval(this.fallbackSweepTimer);
      this.fallbackSweepTimer = null;
    }
    this.processLoop = null;
    this.retryAttempts.clear();
    this.retryNotBefore.clear();
    this.retryableFailureStreak = 0;
    this.backupRefillRounds.clear();
    this.pausedUntil = 0;
    this.lastDequeuedPlaylistType = null;
    this.currentJob = null;
    this.sanitizeCache.clear();
    this.playlistReservePools.clear();
    this.playlistRunDiagnostics.clear();
    this.playlistFailureMemory.clear();
    this.playlistFinalizing.clear();
    this.reserveBuildsInFlight.clear();
    soulseekClient.disconnect().catch(() => {});
    console.log("[WeeklyFlowWorker] Worker stopped");
    return true;
  }

  stop() {
    const stopped = this._requestStop();
    if (!stopped) {
      return;
    }
    downloadTracker.resetDownloadingToPending();
    this.pruneOrphanedJobState();
  }

  async stopAndDrain() {
    this._requestStop();
    await this.waitForIdle();
    downloadTracker.resetDownloadingToPending();
    this.pruneOrphanedJobState();
  }

  _normalizeAlbumName(value) {
    const text = String(value || "")
      .replace(/\u0000/g, "")
      .trim();
    return text || null;
  }

  _parseAlbumFromPath(filePath) {
    if (!filePath || typeof filePath !== "string") return null;
    const normalized = filePath.replace(/\\/g, "/").trim();
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return this._normalizeAlbumName(parts[parts.length - 2]);
  }

  _sanitizePathPart(value) {
    const key = String(value || "");
    if (this.sanitizeCache.has(key)) {
      return this.sanitizeCache.get(key);
    }
    const sanitized = key.replace(/[<>:"/\\|?*]/g, "_").trim();
    if (this.sanitizeCache.size < 1000) {
      this.sanitizeCache.set(key, sanitized);
    }
    return sanitized;
  }

  async processJob(job, runGeneration = this.runGeneration) {
    console.log(
      `[WeeklyFlowWorker] Processing job ${job.id}: ${job.artistName} - ${job.trackName} (${job.playlistType})`,
    );

    const stagingDir = path.join(this.weeklyFlowRoot, "_staging", job.id);
    const stagingPath = path.join(
      stagingDir,
      `${job.artistName} - ${job.trackName}.tmp`,
    );
    const perfStartCpu = process.cpuUsage();
    const perfStartHr = process.hrtime.bigint();
    const timingsMs = {
      search: 0,
      download: 0,
      finalize: 0,
      completionCheck: 0,
      cleanupOnError: 0,
    };
    let stagingPrepared = false;

    downloadTracker.setDownloading(job.id, stagingPath);
    this._assertJobCanContinue(job, runGeneration);

    try {
      let phaseStart = process.hrtime.bigint();
      const retryAttempt = Number(this.retryAttempts.get(job.id) || 0);
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
          this._resetFailureStreak();
          this.retryAttempts.delete(job.id);
          this.retryNotBefore.delete(job.id);
          this.backupRefillRounds.delete(job.playlistType);
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
              search: Math.round(timingsMs.search),
              download: Math.round(timingsMs.download),
              finalize: Math.round(timingsMs.finalize),
              completionCheck: Math.round(timingsMs.completionCheck),
              cleanupOnError: Math.round(timingsMs.cleanupOnError),
            },
          };
          return;
        }
      }
      const searchQueries = buildFlowSearchQueries(resolvedTrack);
      if (searchQueries.length === 0) {
        throw new Error("No search queries could be built");
      }
      console.log(
        `[WeeklyFlowWorker] Search plan for ${job.id}: ${searchQueries.join(" | ")}`,
      );
      const { preferredFormat, preferredFormatStrict } =
        this.getWorkerSettings();
      const matchLimit = this._getAdaptiveMatchLimit(
        preferredFormatStrict,
        retryAttempt,
      );
      const aggregatedResults = [];
      const seenResults = new Set();
      let rankedMatches = [];
      for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex += 1) {
        this._assertJobCanContinue(job, runGeneration);
        const query = searchQueries[queryIndex];
        const searchResults = await soulseekClient.searchQuery(query, {
          forceFresh: retryAttempt > 0,
        });
        for (const result of Array.isArray(searchResults) ? searchResults : []) {
          const file = String(result?.file || "").trim();
          const user = String(result?.user || "").trim();
          if (!file || !user) continue;
          const key = `${user}\0${file}`;
          if (seenResults.has(key)) continue;
          seenResults.add(key);
          aggregatedResults.push(result);
        }
        rankedMatches = rankFlowSearchResults(aggregatedResults, resolvedTrack, {
          preferredFormat,
          strictFormat: preferredFormatStrict,
          isUserBlacklisted: (user) => soulseekClient.isUserBlacklisted(user),
          getUserQueuePenalty: (user) => soulseekClient.getUserQueuePenalty(user),
        });
        const distinctTopUsers = new Set(
          rankedMatches
            .slice(0, Math.max(3, Math.min(matchLimit, 6)))
            .map((entry) => String(entry?.raw?.user || "").trim().toLowerCase())
            .filter(Boolean),
        ).size;
        if (
          rankedMatches.length >= Math.min(matchLimit, 3) &&
          rankedMatches[0]?.isLikelyMatch &&
          distinctTopUsers >= 2
        ) {
          break;
        }
        if (queryIndex >= 2 && rankedMatches.length > 0) {
          break;
        }
      }
      this._assertJobCanContinue(job, runGeneration);
      timingsMs.search += Number(process.hrtime.bigint() - phaseStart) / 1e6;
      if (aggregatedResults.length === 0) {
        throw new Error("No search results found");
      }
      console.log(
        `[WeeklyFlowWorker] Search results for ${job.id}: ${aggregatedResults.length} files, ${rankedMatches.length} ranked candidates`,
      );

      let selectedMatch = null;
      let selectedExt = ".mp3";
      let downloadedSourcePath = null;
      let lastError = null;
      let attemptedCandidates = 0;
      let mp3FallbackActivated = false;
      const rejectedUsersForJob = new Set();

      await new Promise((r) => setImmediate(r));
      await fs.mkdir(stagingDir, { recursive: true });
      stagingPrepared = true;
      this._assertJobCanContinue(job, runGeneration);
      const stagingFile = `${resolvedTrack.artistName} - ${resolvedTrack.trackName}`;
      const stagingFilePath = path.join(stagingDir, stagingFile);

      phaseStart = process.hrtime.bigint();
      const maxDownloadAttempts =
        retryAttempt > 0
          ? MAX_DOWNLOAD_ATTEMPTS_PER_RETRY
          : MAX_DOWNLOAD_ATTEMPTS_PER_JOB;
      const candidatePoolSize = Math.max(
        matchLimit,
        maxDownloadAttempts * 3,
      );
      const buildRankedPool = (format, strictFormat) =>
        rankFlowSearchResults(aggregatedResults, resolvedTrack, {
          preferredFormat: format,
          strictFormat,
          isUserBlacklisted: (user) => soulseekClient.isUserBlacklisted(user),
          getUserQueuePenalty: (user) => soulseekClient.getUserQueuePenalty(user),
        }).slice(0, candidatePoolSize);
      const primaryRankedMatches = buildRankedPool(
        preferredFormat,
        preferredFormatStrict,
      );
      const mixedRankedMatches =
        preferredFormat === "flac"
          ? buildRankedPool("mp3", false)
          : primaryRankedMatches;
      const filteredPrimary = primaryRankedMatches.filter(
        (candidate) => candidate.preDownloadValid !== false,
      );
      const filteredMixed = mixedRankedMatches.filter(
        (candidate) => candidate.preDownloadValid !== false,
      );
      const rejectedForPreDownload = Math.max(
        0,
        primaryRankedMatches.length - filteredPrimary.length,
      );
      if (rejectedForPreDownload > 0) {
        console.log(
          `[WeeklyFlowWorker] Pre-download rejected ${rejectedForPreDownload} weak candidates for ${job.id}`,
        );
      }
      const initialCandidates =
        preferredFormat === "flac" && retryAttempt <= 0
          ? selectRankedMatchAttempts(
              filteredPrimary.filter((candidate) => candidate.ext === ".flac"),
              Math.min(maxDownloadAttempts, FAST_FLAC_PRIMARY_ATTEMPTS),
            )
          : selectRankedMatchAttempts(
              preferredFormat === "flac" ? filteredMixed : filteredPrimary,
              maxDownloadAttempts,
            );
      const attemptedKeys = new Set(
        initialCandidates.map(
          (candidate) =>
            `${String(candidate?.raw?.user || "").trim().toLowerCase()}\0${String(candidate?.raw?.file || "").trim().toLowerCase()}`,
        ),
      );
      const fallbackCandidates =
        preferredFormat === "flac"
          ? selectRankedMatchAttempts(filteredMixed, maxDownloadAttempts).filter(
              (candidate) => {
                const key = `${String(candidate?.raw?.user || "").trim().toLowerCase()}\0${String(candidate?.raw?.file || "").trim().toLowerCase()}`;
                if (!key || attemptedKeys.has(key)) return false;
                attemptedKeys.add(key);
                return true;
              },
            )
          : [];
      const viablePoolSize = filteredMixed.length;
      const candidates =
        initialCandidates.length > 0 ? [...initialCandidates] : [...fallbackCandidates];
      if (candidates.length === 0) {
        if (preferredFormatStrict) {
          lastError = new Error(
            `No ${preferredFormat.toUpperCase()} candidate files returned`,
          );
        } else {
          lastError = new Error("No candidate files returned");
        }
        timingsMs.search += Number(process.hrtime.bigint() - phaseStart) / 1e6;
      } else {
        const attemptCandidates =
          preferredFormat === "flac" && retryAttempt <= 0
            ? [...candidates, ...fallbackCandidates.filter((candidate) => !candidates.includes(candidate))]
            : candidates;
        if (attemptCandidates.length === 0) {
          lastError = new Error(
            `No ${preferredFormat.toUpperCase()} candidate files returned`,
          );
        }
        for (
          let attemptIndex = 0;
          attemptIndex < attemptCandidates.length;
          attemptIndex += 1
        ) {
          this._assertJobCanContinue(job, runGeneration);
          const candidate = attemptCandidates[attemptIndex];
          if (
            preferredFormat === "flac" &&
            retryAttempt <= 0 &&
            !mp3FallbackActivated &&
            (initialCandidates.length === 0 || attemptIndex >= initialCandidates.length)
          ) {
            mp3FallbackActivated = true;
            this._recordMp3FallbackActivation();
            console.log(
              `[WeeklyFlowWorker] MP3 fallback activated for ${job.id} after ${attemptedCandidates} fast FLAC attempts`,
            );
          }
          if (soulseekClient.isUserBlacklisted(candidate.raw?.user)) {
            continue;
          }
          const candidateUser = String(candidate.raw?.user || "")
            .trim()
            .toLowerCase();
          if (candidateUser && rejectedUsersForJob.has(candidateUser)) {
            continue;
          }
          if (
            viablePoolSize > 0 &&
            viablePoolSize <= 2 &&
            Number(candidate.raw?.slots || 0) <= 0
          ) {
            continue;
          }
          attemptedCandidates += 1;
          const extFromSoulseek = path.extname(candidate.raw?.file || "");
          const ext =
            extFromSoulseek &&
            /^\.(flac|mp3|m4a|ogg|wav)$/i.test(extFromSoulseek)
              ? extFromSoulseek
              : ".mp3";
          console.log(
            `[WeeklyFlowWorker] Candidate ${attemptedCandidates}/${attemptCandidates.length} for ${job.id}: user=${String(candidate.raw?.user || "").trim()} ext=${ext} slots=${Number(candidate.raw?.slots || 0)} speed=${Number(candidate.raw?.speed || 0)} score=${Math.round(Number(candidate.score || 0))}`,
          );
          try {
            const downloadStart = process.hrtime.bigint();
            downloadedSourcePath = await soulseekClient.download(
              candidate.raw,
              stagingFilePath,
              (progressPct) => {
                if (!this.currentJob || this.currentJob.id !== job.id) return;
                this.currentJob.progressPct = Math.max(
                  0,
                  Math.min(100, Number(progressPct) || 0),
                );
              },
            );
            this._assertJobCanContinue(job, runGeneration);
            timingsMs.download +=
              Number(process.hrtime.bigint() - downloadStart) / 1e6;
            if (this.currentJob && this.currentJob.id === job.id) {
              this.currentJob.progressPct = 100;
            }
            const validation = await validateDownloadedTrack(
              downloadedSourcePath,
              candidate,
              resolvedTrack,
            );
            if (!validation.valid) {
              await fs.rm(downloadedSourcePath, { force: true }).catch(() => {});
              downloadedSourcePath = null;
              lastError = new Error(
                `Downloaded track validation failed: ${validation.reason}`,
              );
              this._recordFailureMetric(lastError.message);
              if (candidateUser) {
                rejectedUsersForJob.add(candidateUser);
                job.lastFailedUser = candidateUser;
              }
              this._recordPlaylistCandidateFailure(
                job.playlistType,
                job,
                lastError.message,
                candidate,
              );
              console.warn(
                `[WeeklyFlowWorker] Candidate rejected for ${job.id}: user=${String(candidate.raw?.user || "").trim()} file=${String(candidate.raw?.file || "").trim()} reason=${validation.reason}`,
              );
              continue;
            }
            selectedMatch = candidate;
            selectedExt = ext;
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            this._recordFailureMetric(err?.message || "");
            if (candidateUser) {
              rejectedUsersForJob.add(candidateUser);
              job.lastFailedUser = candidateUser;
            }
            this._recordPlaylistCandidateFailure(
              job.playlistType,
              job,
              err?.message || "",
              candidate,
            );
            console.warn(
              `[WeeklyFlowWorker] Candidate failed for ${job.id}: user=${String(candidate.raw?.user || "").trim()} file=${String(candidate.raw?.file || "").trim()} reason=${String(err?.message || err || "unknown")}`,
            );
          }
        }
        if (
          !selectedMatch &&
          viablePoolSize > 0 &&
          viablePoolSize <= 2
        ) {
          lastError = new Error("No candidate files returned");
        }
        timingsMs.search += Number(process.hrtime.bigint() - phaseStart) / 1e6;
      }
      if (!selectedMatch) {
        throw lastError || new Error("No suitable match found");
      }

      const sourcePath =
        typeof downloadedSourcePath === "string" && downloadedSourcePath
          ? downloadedSourcePath
          : null;
      if (!sourcePath) {
        throw new Error("Download completed but no file found");
      }
      const downloadedExt = path.extname(sourcePath).toLowerCase();
      const finalExt =
        downloadedExt && /^\.(flac|mp3|m4a|ogg|wav)$/i.test(downloadedExt)
          ? downloadedExt
          : selectedExt;

      const artistDir = this._sanitizePathPart(resolvedTrack.artistName);
      const albumFromApi = this._normalizeAlbumName(resolvedTrack.albumName);
      const albumFromCandidate = this._normalizeAlbumName(
        selectedMatch?.resolvedAlbumName,
      );
      const albumFromPath = this._parseAlbumFromPath(selectedMatch?.raw?.file);
      const resolvedAlbum =
        albumFromApi || albumFromCandidate || albumFromPath || "Unknown Album";
      const albumDir = this._sanitizePathPart(
        resolvedAlbum,
      );
      const finalDir = path.join(
        this.weeklyFlowRoot,
        "aurral-weekly-flow",
        job.playlistType,
        artistDir,
        albumDir,
      );
      const finalFileName = `${this._sanitizePathPart(resolvedTrack.trackName)}${finalExt}`;
      const finalPath = path.join(finalDir, finalFileName);

      phaseStart = process.hrtime.bigint();
      this._assertJobCanContinue(job, runGeneration);
      await fs.mkdir(finalDir, { recursive: true });
      await fs.rename(sourcePath, finalPath);
      await fs.rm(stagingDir, { recursive: true, force: true });
      this._assertJobCanContinue(job, runGeneration);

      downloadTracker.setDone(job.id, finalPath, resolvedAlbum);
      this._resetFailureStreak();
      this.retryAttempts.delete(job.id);
      this.retryNotBefore.delete(job.id);
      this.backupRefillRounds.delete(job.playlistType);
      this._dropOverflowPendingJobs(job.playlistType);
      this._recordCompletedTrack(
        Number(process.hrtime.bigint() - perfStartHr) / 1e6,
        attemptedCandidates,
      );
      console.log(`[WeeklyFlowWorker] Job ${job.id} completed: ${finalPath}`);
      timingsMs.finalize += Number(process.hrtime.bigint() - phaseStart) / 1e6;

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
          search: Math.round(timingsMs.search),
          download: Math.round(timingsMs.download),
          finalize: Math.round(timingsMs.finalize),
          completionCheck: Math.round(timingsMs.completionCheck),
          cleanupOnError: Math.round(timingsMs.cleanupOnError),
        },
      };
    } catch (error) {
      if (stagingPrepared) {
        try {
          const cleanupStart = process.hrtime.bigint();
          await fs.rm(stagingDir, { recursive: true, force: true });
          timingsMs.cleanupOnError +=
            Number(process.hrtime.bigint() - cleanupStart) / 1e6;
        } catch (cleanupError) {
          console.warn(
            `[WeeklyFlowWorker] Failed to cleanup staging dir: ${cleanupError.message}`,
          );
        }
      }
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
          search: Math.round(timingsMs.search),
          download: Math.round(timingsMs.download),
          finalize: Math.round(timingsMs.finalize),
          completionCheck: Math.round(timingsMs.completionCheck),
          cleanupOnError: Math.round(timingsMs.cleanupOnError),
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

    const target = this._getPlaylistTargetCount(playlistType);
    if (allSettled && target && done < target) {
      const shortfall = target - done;
      const rounds = Number(this.backupRefillRounds.get(playlistType) || 0) + 1;
      this.backupRefillRounds.set(playlistType, rounds);
      const enqueued = await this._enqueueBackupJobs(playlistType, shortfall);
      if (enqueued > 0) {
        this.wake();
        return;
      }
      this._scheduleIncompleteRetry(playlistType);
      return;
    }

    if (allSettled && hasDone) {
      if (this.playlistFinalizing.has(playlistKey)) {
        return;
      }
      this.playlistFinalizing.add(playlistKey);
      this.clearIncompleteRetry(playlistType);
      this.backupRefillRounds.delete(playlistType);
      console.log(
        `[WeeklyFlowWorker] All jobs complete for ${playlistType}, ensuring smart playlists...`,
      );
      try {
        await fs.rm(path.join(this.weeklyFlowRoot, "_fallback"), {
          recursive: true,
          force: true,
        });
      } catch {}
      try {
        playlistManager.updateConfig(false);
        await playlistManager.ensureSmartPlaylists();
        await playlistManager.scanLibrary();
        if (flowPlaylistConfig.isEnabled(playlistType)) {
          flowPlaylistConfig.scheduleNextRun(playlistType);
        }
      } catch (error) {
        console.error(
          `[WeeklyFlowWorker] Failed to ensure smart playlists for ${playlistType}:`,
          error.message,
        );
      }

      const flow = flowPlaylistConfig.getFlow(playlistType);
      const completed = done;
      const { notifyWeeklyFlowDone } = await import("./notificationService.js");
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
      this.playlistFinalizing.delete(playlistKey);
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
        queuedFailures: this.downloadMetrics.queuedFailures,
        offlineFailures: this.downloadMetrics.offlineFailures,
        validationRejects: this.downloadMetrics.validationRejects,
        mp3FallbackActivations:
          this.downloadMetrics.mp3FallbackActivations,
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
