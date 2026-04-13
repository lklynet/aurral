import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { soulseekClient } from "./simpleSoulseekClient.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";
import { dbOps } from "../config/db-helpers.js";

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
const MAX_MATCH_CANDIDATES = 3;
const RETRY_MATCH_CANDIDATES = 10;
const MAX_RETRY_MATCH_CANDIDATES = 20;
const STRICT_FORMAT_MATCH_CANDIDATES = 30;
const STRICT_RETRY_MATCH_CANDIDATES = 20;
const MAX_DOWNLOAD_ATTEMPTS_PER_JOB = 4;
const MAX_DOWNLOAD_ATTEMPTS_PER_RETRY = 6;
const QUEUED_TIMEOUT_FIRST_ATTEMPT_MS = 4500;
const QUEUED_TIMEOUT_RETRY_ATTEMPT_MS = 3000;
const FALLBACK_MP3_REGEX = /^[^/\\]+-[a-f0-9]{8}\.mp3$/i;
const FALLBACK_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_RETRIES_PER_JOB = 1;
const MAX_RETRIES_FOR_TIMEOUT_LOGIN = 1;
const MAX_BACKUP_REFILL_ROUNDS = 3;
const NON_RETRYABLE_ERRORS = new Set([
  "No search results found",
  "No candidate files returned",
  "User not exist",
  "User offline",
]);
const SUPPORTED_PREFERRED_FORMATS = new Set(["flac", "mp3"]);
const WORKER_STOPPED_CODE = "WORKER_STOPPED";
const PLAYLIST_MUTATION_CODE = "PLAYLIST_MUTATION_IN_PROGRESS";

export class WeeklyFlowWorker {
  constructor(
    weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads",
  ) {
    this.weeklyFlowRoot = path.isAbsolute(weeklyFlowRoot)
      ? weeklyFlowRoot
      : path.resolve(process.cwd(), weeklyFlowRoot);
    this.running = false;
    this.activeCount = 0;
    this.lastFallbackSweepAt = 0;
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
    this.lastJobMetrics = null;
    this.sanitizeCache = new Map();
    this.incompleteRetryTimers = new Map();
    this.activeJobs = new Map();
    this.blockedPlaylistTypes = new Set();
    this.runGeneration = 0;
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

  _isNonRetryableError(message) {
    const text = String(message || "").trim();
    if (!text) return false;
    if (NON_RETRYABLE_ERRORS.has(text)) return true;
    const lower = text.toLowerCase();
    return lower.includes("user not exist") || lower.includes("user offline");
  }

  _getRetryLimitForError(message) {
    if (this._isAuthFailure(message)) return MAX_RETRIES_FOR_TIMEOUT_LOGIN;
    return MAX_RETRIES_PER_JOB;
  }

  _getRetryDelayMs(attempt, message) {
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
    const sourceTracks = await playlistSource
      .getTracksForFlow({ ...flow, size: shortfall })
      .catch(() => []);
    if (!Array.isArray(sourceTracks) || sourceTracks.length === 0) return 0;
    const existingKeys = new Set(
      downloadTracker
        .getByPlaylistType(playlistType)
        .map((job) => this._trackKeyFromJob(job))
        .filter(Boolean),
    );
    const unique = [];
    for (const track of sourceTracks) {
      const key = this._trackKeyFromTrack(track);
      if (!key || existingKeys.has(key)) continue;
      existingKeys.add(key);
      unique.push(track);
      if (unique.length >= shortfall) break;
    }
    if (unique.length === 0) return 0;
    return downloadTracker.addJobs(unique, playlistType).length;
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

  async start() {
    if (this.running) {
      return;
    }

    this.runGeneration += 1;
    this.running = true;
    console.log("[WeeklyFlowWorker] Starting worker...");
    await this.moveFallbackMp3sToDir(true);
    this.fallbackSweepTimer = setInterval(() => {
      if (!this.running) return;
      this.scheduleFallbackSweep(false);
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
        const job = downloadTracker.getNextPending(
          this.lastDequeuedPlaylistType,
        );
        if (!job) break;
        this.lastDequeuedPlaylistType = job.playlistType;
        if (this._hasReachedPlaylistTarget(job.playlistType)) {
          downloadTracker.removeJob(job.id);
          continue;
        }
        const loopNow = Date.now();
        const notBefore = Number(this.retryNotBefore.get(job.id) || 0);
        if (notBefore > loopNow) {
          const waitMs = Math.max(1000, notBefore - loopNow);
          this._scheduleProcessIn(waitMs);
          break;
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
              this._recordRetryableFailure();
              const retryDelayMs = this._getRetryDelayMs(retryAttempt, message);
              this.retryNotBefore.set(job.id, Date.now() + retryDelayMs);
              if (this._isAuthFailure(message)) {
                this._pauseWorker(AUTH_FAILURE_PAUSE_MS);
              } else if (this._isConnectivityFailure(message)) {
                this._pauseWorker(CONNECTIVITY_FAILURE_PAUSE_MS);
              }
              downloadTracker.setPending(
                job.id,
                `${message} (retry ${retryAttempt}/${retryLimit} in ${Math.ceil(retryDelayMs / 1000)}s)`,
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
            downloadTracker.setFailed(job.id, error.message);
            await this.checkPlaylistComplete(job.playlistType);
          })
          .finally(() => {
            this.activeJobs.delete(job.id);
            this.activeCount--;
            if (this.activeCount <= 0) {
              this.currentJob = null;
            }
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
      const initialResults = await soulseekClient.search(
        job.artistName,
        job.trackName,
        { forceFresh: true },
      );
      this._assertJobCanContinue(job, runGeneration);
      timingsMs.search += Number(process.hrtime.bigint() - phaseStart) / 1e6;
      if (!initialResults || initialResults.length === 0) {
        throw new Error("No search results found");
      }

      let selectedMatch = null;
      let selectedExt = ".mp3";
      let downloadedSourcePath = null;
      let lastError = null;

      await new Promise((r) => setImmediate(r));
      await fs.mkdir(stagingDir, { recursive: true });
      stagingPrepared = true;
      this._assertJobCanContinue(job, runGeneration);
      const stagingFile = `${job.artistName} - ${job.trackName}`;
      const stagingFilePath = path.join(stagingDir, stagingFile);

      phaseStart = process.hrtime.bigint();
      const { preferredFormat, preferredFormatStrict } =
        this.getWorkerSettings();
      const preferredExt = preferredFormat === "mp3" ? ".mp3" : ".flac";
      const secondaryExt = preferredFormat === "mp3" ? ".flac" : ".mp3";
      const strictSourcePool = preferredFormatStrict
        ? initialResults.filter((candidate) => {
            if (typeof candidate?.file !== "string" || !candidate.file.trim()) {
              return false;
            }
            return path.extname(candidate.file).toLowerCase() === preferredExt;
          })
        : null;
      const sourcePool = preferredFormatStrict
        ? strictSourcePool
        : initialResults;
      const matchLimit = this._getAdaptiveMatchLimit(
        preferredFormatStrict,
        retryAttempt,
      );
      const rankedCandidates = soulseekClient.pickBestMatches(
        sourcePool,
        job.trackName,
        matchLimit,
      );
      const candidatePool =
        Array.isArray(rankedCandidates) && rankedCandidates.length > 0
          ? rankedCandidates
          : Array.isArray(sourcePool)
            ? sourcePool
            : [];
      const candidates = candidatePool
        .filter((candidate) => {
          return typeof candidate?.file === "string" && candidate.file.trim();
        })
        .slice(0, matchLimit);
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
        const rankedCandidates = candidates
          .map((candidate, index) => ({
            candidate,
            index,
            ext: path.extname(candidate?.file || "").toLowerCase(),
          }))
          .sort((a, b) => {
            const rankA =
              a.ext === preferredExt ? 0 : a.ext === secondaryExt ? 1 : 2;
            const rankB =
              b.ext === preferredExt ? 0 : b.ext === secondaryExt ? 1 : 2;
            if (rankA !== rankB) return rankA - rankB;
            return a.index - b.index;
          });
        const orderedCandidates = preferredFormatStrict
          ? rankedCandidates.filter((entry) => entry.ext === preferredExt)
          : rankedCandidates;
        const maxDownloadAttempts =
          retryAttempt > 0
            ? MAX_DOWNLOAD_ATTEMPTS_PER_RETRY
            : MAX_DOWNLOAD_ATTEMPTS_PER_JOB;
        const attemptCandidates = orderedCandidates.slice(
          0,
          maxDownloadAttempts,
        );
        if (orderedCandidates.length === 0) {
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
          const extFromSoulseek = path.extname(candidate.candidate.file || "");
          const ext =
            extFromSoulseek &&
            /^\.(flac|mp3|m4a|ogg|wav)$/i.test(extFromSoulseek)
              ? extFromSoulseek
              : ".mp3";
          try {
            const downloadStart = process.hrtime.bigint();
            downloadedSourcePath = await soulseekClient.download(
              candidate.candidate,
              stagingFilePath,
              (progressPct) => {
                if (!this.currentJob || this.currentJob.id !== job.id) return;
                this.currentJob.progressPct = Math.max(
                  0,
                  Math.min(100, Number(progressPct) || 0),
                );
              },
              {
                queuedTimeoutMs:
                  attemptIndex === 0
                    ? QUEUED_TIMEOUT_FIRST_ATTEMPT_MS
                    : QUEUED_TIMEOUT_RETRY_ATTEMPT_MS,
              },
            );
            this._assertJobCanContinue(job, runGeneration);
            timingsMs.download +=
              Number(process.hrtime.bigint() - downloadStart) / 1e6;
            if (this.currentJob && this.currentJob.id === job.id) {
              this.currentJob.progressPct = 100;
            }
            selectedMatch = candidate.candidate;
            selectedExt = ext;
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
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

      const artistDir = this._sanitizePathPart(job.artistName);
      const albumFromApi = this._normalizeAlbumName(job.albumName);
      const albumFromPath = this._parseAlbumFromPath(selectedMatch.file);
      const resolvedAlbum = albumFromApi || albumFromPath || "Unknown Album";
      const albumDir = this._sanitizePathPart(resolvedAlbum);
      const finalDir = path.join(
        this.weeklyFlowRoot,
        "aurral-weekly-flow",
        job.playlistType,
        artistDir,
        albumDir,
      );
      const finalFileName = `${this._sanitizePathPart(job.trackName)}${finalExt}`;
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
    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    const { total, pending, downloading, done, failed } = stats;
    const allSettled = total > 0 && pending === 0 && downloading === 0;
    const hasDone = done > 0;

    const target = this._getPlaylistTargetCount(playlistType);
    if (allSettled && target && done < target) {
      const shortfall = target - done;
      const rounds = Number(this.backupRefillRounds.get(playlistType) || 0);
      if (rounds < MAX_BACKUP_REFILL_ROUNDS) {
        const enqueued = await this._enqueueBackupJobs(playlistType, shortfall);
        this.backupRefillRounds.set(playlistType, rounds + 1);
        if (enqueued > 0) {
          this.wake();
          return;
        }
      }
      if (failed > 0 || flowPlaylistConfig.getFlow(playlistType)) {
        this._scheduleIncompleteRetry(playlistType);
        return;
      }
      this.backupRefillRounds.delete(playlistType);
    }

    if (allSettled && hasDone) {
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
      if (!downloadTracker.getNextPending()) {
        this.stop();
      }
    }
  }

  getStatus() {
    const settings = this.getWorkerSettings();
    return {
      running: this.running,
      processing: this.activeCount > 0,
      activeCount: this.activeCount,
      stats: downloadTracker.getStats(),
      currentJob: this.currentJob,
      lastJobMetrics: this.lastJobMetrics,
      settings,
    };
  }
}

export const weeklyFlowWorker = new WeeklyFlowWorker();
