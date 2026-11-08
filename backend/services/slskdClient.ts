import * as v from "valibot";
import { createHttpClient, type HttpOptions } from "../../lib/http.ts";
import { randomUUID } from "crypto";
import { dbOps } from "../db/helpers/index.ts";
import { withLock } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { readMany, readOne } from "./integrationData.ts";
import { asAppError } from "../../lib/errors.ts";
import type { StoredIntegrations } from "../db/helpers/settings.ts";

const NORMALIZED_SEARCH_RESULTS = Symbol("normalizedSearchResults");
const DEFAULT_SEARCH_TIMEOUT_MS = 60000;
const DEFAULT_EMPTY_SEARCH_TIMEOUT_MS = 10000;
const DEFAULT_SEARCH_GRACE_PERIOD_MS = 20000;
const DEFAULT_SEARCH_IDLE_TIMEOUT_MS = 15000;
const DEFAULT_FILE_LIMIT = 1000;
const DEFAULT_RESPONSE_LIMIT = 150;
const DEFAULT_MAX_PEER_QUEUE = 150;
const DEFAULT_MIN_PEER_SPEED = 51200;
const SEARCH_START_GAP_MS = 5000;
const SEARCH_STARTED_AT_SETTING = "slskdSearchStartedAt";
const SOULSEEK_LOGGED_OUT_CODE = "SLSKD_SOULSEEK_LOGGED_OUT";
export const SOULSEEK_LOGGED_OUT_MESSAGE = "slskd is not logged in to Soulseek";

type SlskdConfig = NonNullable<StoredIntegrations["slskd"]>;
type SlskdRequestOptions = Pick<HttpOptions, "timeoutMs" | "signal">;
type SlskdTransferRef = { username?: string | null; transferId?: string; id?: string };
type CodedError = Error & { code?: string };

const applicationSchema = v.looseObject({
  server: v.optional(
    v.looseObject({
      state: v.optional(v.string()),
      isConnected: v.optional(v.boolean()),
      isLoggedIn: v.optional(v.boolean()),
    }),
  ),
});

const optionsSchema = v.looseObject({
  directories: v.optional(v.looseObject({ downloads: v.nullish(v.string()) })),
});

const searchFileSchema = v.looseObject({
  filename: v.string(),
  size: v.optional(v.number()),
  bitRate: v.nullish(v.number()),
  length: v.nullish(v.number()),
  extension: v.nullish(v.string()),
  isLocked: v.optional(v.boolean()),
});

const searchResponseSchema = v.looseObject({
  username: v.string(),
  hasFreeUploadSlot: v.optional(v.boolean()),
  uploadSpeed: v.optional(v.number()),
  queueLength: v.optional(v.number()),
  files: v.optional(v.array(searchFileSchema)),
  lockedFiles: v.optional(v.array(searchFileSchema)),
});

const searchSchema = v.looseObject({
  id: v.optional(v.string()),
  state: v.optional(v.string()),
  isComplete: v.optional(v.boolean()),
  endedAt: v.nullish(v.string()),
  fileCount: v.optional(v.number()),
  responseCount: v.optional(v.number()),
  responses: v.optional(v.array(searchResponseSchema)),
});

const transferStateFlags = [
  "Requested",
  "Queued",
  "Initializing",
  "InProgress",
  "Completed",
  "Succeeded",
  "Cancelled",
  "TimedOut",
  "Errored",
  "Rejected",
  "Aborted",
  "Locally",
  "Remotely",
];

const transferStateSchema = v.union([
  v.string(),
  v.pipe(
    v.number(),
    v.transform(
      (state) => transferStateFlags.filter((_, bit) => state & (1 << bit)).join(", ") || "None",
    ),
  ),
]);

const transferSchema = v.looseObject({
  id: v.string(),
  username: v.optional(v.string()),
  filename: v.optional(v.string()),
  state: v.optional(transferStateSchema),
  exception: v.nullish(v.string()),
  bytesTransferred: v.nullish(v.number()),
  placeInQueue: v.nullish(v.number()),
});

const enqueueSchema = v.looseObject({
  enqueued: v.optional(v.array(transferSchema)),
  failed: v.optional(
    v.array(v.looseObject({ filename: v.nullish(v.string()), message: v.nullish(v.string()) })),
  ),
});

const eventSchema = v.looseObject({ type: v.string() });

const downloadEventTypes = new Set(["DownloadFileComplete", "DownloadDirectoryComplete"]);

const downloadEventSchema = v.variant("type", [
  v.looseObject({
    type: v.literal("DownloadFileComplete"),
    data: v.pipe(
      v.string(),
      v.parseJson(),
      v.looseObject({ transfer: transferSchema, localFilename: v.optional(v.string()) }),
    ),
  }),
  v.looseObject({
    type: v.literal("DownloadDirectoryComplete"),
    data: v.pipe(
      v.string(),
      v.parseJson(),
      v.looseObject({ username: v.string(), remoteDirectoryName: v.string() }),
    ),
  }),
]);

type SlskdSearchFileRecord = v.InferOutput<typeof searchFileSchema>;
type SlskdSearchResponse = v.InferOutput<typeof searchResponseSchema>;
export type SlskdTransfer = v.InferOutput<typeof transferSchema>;
export type SlskdDownloadEvent = v.InferOutput<typeof downloadEventSchema>;
type SlskdSearch = v.InferOutput<typeof searchSchema> & {
  [NORMALIZED_SEARCH_RESULTS]?: SlskdSearchFile[];
};
type SlskdSearchStatus = Pick<SlskdSearch, "state" | "isComplete">;

interface SlskdConnectionStatus {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  message: string;
  soulseekConnected?: boolean;
  warning?: boolean;
  serverState?: string;
  downloadPath?: string | null;
  downloadPathDenied?: boolean;
}

interface SlskdSearchOptions {
  id?: string;
  deadline?: number;
  signal?: AbortSignal;
  shouldCancel?: () => boolean;
  startedAt?: number;
  queued?: boolean;
  timeoutMs?: number;
  searchTimeoutMs?: number;
  emptyTimeoutMs?: number;
  gracePeriodMs?: number;
  cleanupTimeoutMs?: number;
  fileLimit?: number;
  filterResponses?: boolean;
  maximumPeerQueueLength?: number;
  minimumPeerUploadSpeed?: number;
  minimumResponseFileCount?: number;
  responseLimit?: number;
  earlyExitWhen?: (data: SlskdSearch) => boolean;
  onSearchCreated?: (id: string) => void;
  onSearchSettled?: (id: string) => void;
}

type SlskdSearchPoll =
  | { done: true; data: SlskdSearch | null }
  | { done: false; data: SlskdSearch; waitMs: number };

export const slskdSettings = Object.freeze({
  key: "slskd",
  label: "slskd",
  subtitle: "Soulseek",
  enabledDefault: false,
  testRequiresEnabled: false,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable slskd", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:5030",
    }),
    Object.freeze({
      key: "apiKey",
      label: "API key",
      type: "password",
      secret: true,
      section: "Connection",
      hint: "Leave blank if slskd authentication is disabled.",
    }),
    Object.freeze({
      key: "priority",
      label: "Track priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Behavior",
    }),
    Object.freeze({
      key: "albumPriority",
      label: "Album priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Behavior",
      hint: "Empty uses track priority.",
    }),
    Object.freeze({
      key: "cleanupAfterRuns",
      label: "Clean up after runs",
      type: "toggle",
      section: "Behavior",
    }),
  ]),
  defaults: Object.freeze({
    enabled: false,
    url: "",
    apiKey: "",
    priority: 10,
    cleanupAfterRuns: false,
  }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

let connectionCache: {
  checkedAt: number;
  result: SlskdConnectionStatus | null;
  settingsKey: string | null;
} = { checkedAt: 0, result: null, settingsKey: null };

function getSettingsKey({ url, apiKey }: { url: string; apiKey: string }) {
  return `${url}\u0000${apiKey}`;
}

function cacheConnectionResult(
  settingsKey: string,
  result: SlskdConnectionStatus,
  config: SlskdConfig | null = null,
) {
  const activeSettings = getSettings(config);
  if (getSettingsKey(activeSettings) !== settingsKey) return;
  connectionCache = { checkedAt: Date.now(), result, settingsKey };
}

function getSettings(config: SlskdConfig | null = null) {
  const integrations: StoredIntegrations = config
    ? { slskd: config }
    : dbOps.getSettings()?.integrations || {};
  const slskd: SlskdConfig = integrations.slskd || {};
  const url = String(slskd.url || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(slskd.apiKey || "").trim();
  return { url, apiKey, slskd };
}

export function getSlskdSearchFormatOptions(config: SlskdConfig | null = null) {
  const slskd = getSettings(config).slskd || {};
  const preferredFormat =
    String(slskd.preferredFormat || "").toLowerCase() === "mp3" ? "mp3" : "flac";
  return {
    preferredFormat,
    strictFormat: slskd.preferredFormatStrict === true,
  };
}

export function isSlskdCleanupAfterRunsEnabled(config: SlskdConfig | null = null) {
  const slskd = getSettings(config).slskd || {};
  return slskd.cleanupAfterRuns === true;
}

function buildClientFromCredentials(url: string, apiKey: string) {
  const trimmedUrl = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedUrl) {
    throw new Error("slskd not configured");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (trimmedKey) {
    headers["X-API-KEY"] = trimmedKey;
  }
  return createHttpClient({
    baseUrl: trimmedUrl,
    timeoutMs: 60000,
    headers,
    okStatus: () => true,
  });
}

function buildClient(config: SlskdConfig | null = null) {
  const { url, apiKey } = getSettings(config);
  return buildClientFromCredentials(url, apiKey);
}

function calculateQuadraticDelay(progress: number) {
  const delay = 16 * progress ** 2 - 16 * progress + 5;
  return Math.min(5, Math.max(0.5, delay));
}

export function isSearchComplete(data: SlskdSearchStatus | null | undefined) {
  if (data?.isComplete === true) return true;
  return String(data?.state || "").includes("Completed");
}

function isSearchQueued(data: SlskdSearchStatus | null | undefined) {
  const state = String(data?.state || "").trim();
  return state === "Requested" || state === "Queued";
}

export function isSearchInProgress(data: SlskdSearchStatus | null | undefined) {
  if (isSearchComplete(data)) return false;
  const state = String(data?.state || "").trim();
  if (!state || state === "None") return true;
  if (state.includes("InProgress")) return true;
  return state === "Requested" || state === "Queued";
}

function normalizeSearchFile(
  file: SlskdSearchFileRecord,
  response: SlskdSearchResponse,
  fromLockedList: boolean,
) {
  const locked = fromLockedList || file.isLocked === true;
  const bitRate = file.bitRate ?? null;
  return {
    user: response.username.trim(),
    file: file.filename.trim(),
    size: file.size ?? 0,
    slots: response.hasFreeUploadSlot === true ? 1 : 0,
    speed: response.uploadSpeed ?? 0,
    queueLength: response.queueLength ?? 0,
    bitRate,
    bitrate: bitRate,
    length: file.length && file.length > 0 ? file.length : null,
    extension: file.extension || null,
    locked,
    isLocked: locked,
  };
}

type SlskdSearchFile = ReturnType<typeof normalizeSearchFile>;

function summarizeBatchFailures(failures: v.InferOutput<typeof enqueueSchema>["failed"]) {
  const messages = (failures ?? [])
    .map((failure) =>
      [failure.filename?.trim(), failure.message?.trim()].filter(Boolean).join(": "),
    )
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : "all files failed";
}

function searchStillQueuedError() {
  return new Error("slskd is busy: the search is still waiting in its queue");
}

function soulseekLoggedOutError(detail: string) {
  const error: CodedError = new Error(`${SOULSEEK_LOGGED_OUT_MESSAGE}: ${detail}`);
  error.code = SOULSEEK_LOGGED_OUT_CODE;
  return error;
}

export function isSoulseekLoggedOutError(error: unknown) {
  return asAppError(error)?.code === SOULSEEK_LOGGED_OUT_CODE;
}

function isSoulseekLoggedIn(server: v.InferOutput<typeof applicationSchema>["server"]) {
  if (typeof server?.isLoggedIn === "boolean") return server.isLoggedIn;
  return String(server?.state || "")
    .split(",")
    .map((flag) => flag.trim())
    .includes("LoggedIn");
}

function createSearchCancellation(shouldCancel?: () => boolean, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted || shouldCancel?.()) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer =
    typeof shouldCancel === "function"
      ? setInterval(() => {
          if (shouldCancel()) abort();
        }, 100)
      : null;
  timer?.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearInterval(timer);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

function untilDeadline(deadline: number, signal?: AbortSignal) {
  if (!Number.isFinite(deadline)) return signal;
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function waitSearchDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) return resolve();
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", finish);
      resolve();
    }, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function waitForSearchStartSlot(signal: AbortSignal) {
  const lastStartedAt = dbOps.getJSONSetting(SEARCH_STARTED_AT_SETTING, v.number()) ?? 0;
  const waitMs =
    lastStartedAt > 0
      ? Math.min(SEARCH_START_GAP_MS, lastStartedAt + SEARCH_START_GAP_MS - Date.now())
      : 0;
  if (waitMs > 0) await waitSearchDelay(waitMs, signal);
  if (signal.aborted) throw new Error("slskd search cancelled");
}

async function withSearchLock<T>(
  name: string,
  operation: () => Promise<T>,
  { deadline, signal }: { deadline?: number; signal: AbortSignal },
): Promise<T> {
  const lockDeadline = Number(deadline) || Date.now() + 300000;
  while (true) {
    if (signal.aborted) throw new Error("slskd search cancelled");
    const remaining = lockDeadline - Date.now();
    if (remaining <= 0) throw new Error("slskd search deadline expired");
    try {
      return await withLock(
        name,
        () => {
          if (signal.aborted) throw new Error("slskd search cancelled");
          if (Date.now() >= lockDeadline) throw new Error("slskd search deadline expired");
          return operation();
        },
        { waitTimeoutMs: Math.min(250, remaining) },
      );
    } catch (error) {
      if (asAppError(error)?.message !== `Timed out waiting for lock: ${name}`) throw error;
    }
  }
}

// Follows one slskd search a poll at a time. waitForSearch loops over it;
// the download pipeline polls it once per step so a search never holds the
// pipeline while Soulseek peers answer.
class SearchMonitor {
  declare client: SlskdClient;
  declare searchId: string;
  declare onSearchSettled: ((id: string) => void) | undefined;
  declare cleanupTimeoutMs: number | undefined;
  declare emptyTimeoutMs: number;
  declare activeTimeoutMs: number;
  declare gracePeriodMs: number;
  declare hardDeadline: number;
  declare startedAt: number;
  declare graceStartsAt: number;
  declare deadline: number;
  declare queued: boolean;
  declare totalFiles: number;
  declare hasSeenFiles: boolean;
  declare latest: SlskdSearch | null;
  declare collected: Map<string, SlskdSearchFile>;
  declare eligibilityAssessed: boolean;
  declare lastEligibility: boolean;

  constructor(client: SlskdClient, searchId: string, options: SlskdSearchOptions = {}) {
    this.client = client;
    this.searchId = searchId;
    this.onSearchSettled = options.onSearchSettled;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs;
    this.emptyTimeoutMs = Math.max(
      0,
      Number(options.emptyTimeoutMs ?? DEFAULT_EMPTY_SEARCH_TIMEOUT_MS),
    );
    this.activeTimeoutMs =
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SEARCH_TIMEOUT_MS;
    this.gracePeriodMs = Math.max(
      0,
      Number(options.gracePeriodMs ?? DEFAULT_SEARCH_GRACE_PERIOD_MS),
    );
    this.hardDeadline = Number(options.deadline) || Infinity;
    this.startWindows(Number(options.startedAt) || Date.now());
    this.queued = options.queued !== false;
    this.totalFiles = 0;
    this.hasSeenFiles = false;
    this.latest = null;
    this.collected = new Map();
    this.eligibilityAssessed = false;
    this.lastEligibility = false;
  }

  startWindows(startedAt: number) {
    this.startedAt = startedAt;
    this.graceStartsAt = startedAt + this.activeTimeoutMs;
    this.deadline = Math.min(this.hardDeadline, this.graceStartsAt + this.gracePeriodMs);
  }

  cutoff() {
    return this.hasSeenFiles
      ? this.deadline
      : Math.min(this.deadline, this.startedAt + this.emptyTimeoutMs);
  }

  async stop() {
    try {
      const deleted = await this.client.deleteSearch(this.searchId, {
        timeoutMs: Math.max(1, Number(this.cleanupTimeoutMs) || 20000),
      });
      if (deleted) this.onSearchSettled?.(this.searchId);
      else logger.warn("slskd", "Could not stop owned search", { searchId: this.searchId });
    } catch (error) {
      logger.warn("slskd", "Could not stop owned search", {
        searchId: this.searchId,
        reason: asAppError(error)?.message,
      });
    }
  }

  // slskd returns a running search's responses only once it ends, so a search
  // cut off by its deadline is stopped and read instead of discarded.
  async collect(cancelled: () => boolean | undefined, signal?: AbortSignal) {
    const latest = this.latest;
    if (!latest || !this.hasSeenFiles || isSearchComplete(latest)) return this.finish(latest);
    const stopped = await this.client.stopSearch(this.searchId, { signal }).catch(() => false);
    const hydrated = stopped
      ? await this.client
          .hydrateCompletedSearch(this.searchId, latest, { signal })
          .catch(() => latest)
      : latest;
    if (cancelled()) {
      await this.stop();
      return { done: true, data: null } as const;
    }
    for (const file of this.client.flattenSearchResults(hydrated)) {
      this.collected.set(`${file.user}\0${file.file}`, file);
    }
    const data = { ...hydrated };
    Object.defineProperty(data, NORMALIZED_SEARCH_RESULTS, { value: [...this.collected.values()] });
    return this.finish(data);
  }

  async finish(data: SlskdSearch | null): Promise<{ done: true; data: SlskdSearch | null }> {
    if (isSearchComplete(data) && !this.client.isCleanupAfterRunsEnabled()) {
      this.onSearchSettled?.(this.searchId);
    } else {
      await this.stop();
    }
    return { done: true, data };
  }

  async poll({
    earlyExitWhen,
    shouldCancel,
    signal,
  }: Pick<
    SlskdSearchOptions,
    "earlyExitWhen" | "shouldCancel" | "signal"
  > = {}): Promise<SlskdSearchPoll> {
    const cancelled = () => signal?.aborted || shouldCancel?.();
    try {
      if (cancelled()) {
        await this.stop();
        return { done: true, data: null };
      }
      const cutoff = this.queued || !this.latest ? this.hardDeadline : this.cutoff();
      if (Date.now() >= cutoff) {
        if (this.queued) throw searchStillQueuedError();
        return this.collect(cancelled, signal);
      }
      let data: SlskdSearch;
      try {
        data = await this.client.getSearch(this.searchId, {
          signal: untilDeadline(cutoff, signal),
        });
      } catch (error) {
        if (cancelled()) {
          await this.stop();
          return { done: true, data: null };
        }
        if (Date.now() >= cutoff) {
          if (this.queued) throw searchStillQueuedError();
          return this.collect(cancelled, signal);
        }
        throw error;
      }
      if (cancelled()) {
        await this.stop();
        return { done: true, data: null };
      }
      // slskd runs a few searches at once and queues the rest. A queued search
      // has not asked anyone yet, so its windows start once it runs.
      const wasQueued = this.queued;
      this.queued = isSearchQueued(data);
      if (this.queued) {
        if (Date.now() >= this.hardDeadline) throw searchStillQueuedError();
        return {
          done: false,
          data,
          waitMs: Math.min(2000, Math.max(1, this.hardDeadline - Date.now())),
        };
      }
      if (wasQueued) this.startWindows(Date.now());
      const files = this.client.flattenSearchResults(data);
      let eligibilityChanged = false;
      for (const file of files) {
        const key = `${file.user}\0${file.file}`;
        const previous = this.collected.get(key);
        if (
          !previous ||
          (Object.keys(file) as (keyof SlskdSearchFile)[]).some(
            (field) => !Object.is(file[field], previous[field]),
          )
        ) {
          this.collected.set(key, file);
          eligibilityChanged = true;
        }
      }
      data = { ...data };
      Object.defineProperty(data, NORMALIZED_SEARCH_RESULTS, {
        value: [...this.collected.values()],
      });
      this.latest = data;
      this.totalFiles = Math.max(this.totalFiles, data.fileCount ?? 0, files.length);
      this.hasSeenFiles ||= this.totalFiles > 0;
      if (earlyExitWhen && (!this.eligibilityAssessed || eligibilityChanged)) {
        this.lastEligibility = earlyExitWhen(data);
        this.eligibilityAssessed = true;
      }
      if (this.lastEligibility || !isSearchInProgress(data)) {
        let hydrated = isSearchComplete(data)
          ? await this.client.hydrateCompletedSearch(this.searchId, data, {
              deadline: this.deadline,
              shouldCancel,
              signal,
            })
          : data;
        if (cancelled()) {
          await this.stop();
          return { done: true, data: null };
        }
        if (hydrated !== data) {
          for (const file of this.client.flattenSearchResults(hydrated)) {
            this.collected.set(`${file.user}\0${file.file}`, file);
          }
          hydrated = { ...hydrated };
          Object.defineProperty(hydrated, NORMALIZED_SEARCH_RESULTS, {
            value: [...this.collected.values()],
          });
        }
        return this.finish(hydrated);
      }
      const nextCutoff = this.cutoff();
      if (Date.now() >= nextCutoff) return this.collect(cancelled, signal);
      const progress = Math.min(1, this.totalFiles / DEFAULT_FILE_LIMIT);
      const grace = Date.now() >= this.graceStartsAt;
      return {
        done: false,
        data,
        waitMs: Math.min(
          (grace ? 1 : calculateQuadraticDelay(progress)) * 1000,
          nextCutoff - Date.now(),
        ),
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
}

export class SlskdClient {
  declare key: string;
  declare name: string;
  declare _config: SlskdConfig | null;

  constructor(config: SlskdConfig | null = null) {
    this.key = "slskd";
    this.name = "slskd";
    this._config = config;
  }

  updateConfig(config: SlskdConfig | null = null) {
    this._config = config;
  }

  isCleanupAfterRunsEnabled() {
    return isSlskdCleanupAfterRunsEnabled(this._config);
  }

  isConfigured() {
    const { url, slskd } = getSettings(this._config);
    return slskd.enabled !== false && !!url;
  }

  async testConnection({ force = false } = {}): Promise<SlskdConnectionStatus> {
    const { url, apiKey } = getSettings(this._config);
    if (!url) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "slskd URL is required",
      };
    }
    const settingsKey = getSettingsKey({ url, apiKey });
    if (
      !force &&
      connectionCache.settingsKey === settingsKey &&
      connectionCache.result &&
      Date.now() - connectionCache.checkedAt < 30000
    ) {
      return connectionCache.result;
    }
    const client = buildClient(this._config);
    try {
      const [appRes, optionsRes] = await Promise.all([
        client.get("/api/v0/application"),
        client.get("/api/v0/options"),
      ]);
      if (appRes.status !== 200) {
        const result = {
          ok: false,
          configured: true,
          connected: false,
          message: `slskd returned HTTP ${appRes.status}`,
        };
        cacheConnectionResult(settingsKey, result, this._config);
        return result;
      }
      const { server } = readOne(applicationSchema, appRes.data, {
        service: "slskd",
        endpoint: "/api/v0/application",
      });
      const serverState = String(server?.state || "");
      const soulseekConnected = isSoulseekLoggedIn(server);
      const options =
        optionsRes.status === 200
          ? readOne(optionsSchema, optionsRes.data, {
              service: "slskd",
              endpoint: "/api/v0/options",
            })
          : null;
      const downloadPath = options?.directories?.downloads?.trim() || null;
      const downloadPathDenied = optionsRes.status === 401 || optionsRes.status === 403;
      const result = {
        ok: true,
        configured: true,
        connected: soulseekConnected,
        soulseekConnected,
        warning: !soulseekConnected || downloadPathDenied,
        serverState,
        downloadPath,
        downloadPathDenied,
        message: soulseekConnected
          ? downloadPathDenied
            ? "slskd won't share its download folder with this API key. Give the key the administrator role in slskd."
            : "slskd is connected"
          : server?.isConnected === true
            ? "slskd is connected to Soulseek but not logged in. Soulseek downloads wait until it logs in."
            : "slskd is reachable, but it is not connected to Soulseek. Open slskd and connect to the Soulseek server.",
      };
      cacheConnectionResult(settingsKey, result, this._config);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: asAppError(error)?.message || "Failed to reach slskd",
      };
      cacheConnectionResult(settingsKey, result, this._config);
      return result;
    }
  }

  getStatus() {
    const { url, apiKey } = getSettings(this._config);
    const configured = !!url;
    const cached =
      connectionCache.settingsKey === getSettingsKey({ url, apiKey })
        ? connectionCache.result
        : null;
    return {
      configured,
      connected: configured && cached?.connected === true,
      downloadPath: cached?.downloadPath || null,
      serverState: cached?.serverState || null,
    };
  }

  async getDownloadDirectory({ force = false } = {}) {
    const status = await this.testConnection({ force });
    const downloadPath = String(status?.downloadPath || "").trim();
    return downloadPath || null;
  }

  async createSearch(searchText: string, options: SlskdSearchOptions = {}) {
    const control = createSearchCancellation(options.shouldCancel, options.signal);
    const id = String(options.id || randomUUID());
    const client = buildClient(this._config);
    const searchTimeoutMs = Math.max(
      5000,
      Math.floor(Number(options.searchTimeoutMs || DEFAULT_SEARCH_IDLE_TIMEOUT_MS)),
    );
    const body = {
      id,
      searchText: String(searchText || "").trim(),
      fileLimit: Number(options.fileLimit || DEFAULT_FILE_LIMIT),
      filterResponses: options.filterResponses !== false,
      maximumPeerQueueLength: Number(options.maximumPeerQueueLength || DEFAULT_MAX_PEER_QUEUE),
      minimumPeerUploadSpeed: Number(options.minimumPeerUploadSpeed || DEFAULT_MIN_PEER_SPEED),
      minimumResponseFileCount: Number(options.minimumResponseFileCount || 1),
      responseLimit: Number(options.responseLimit || DEFAULT_RESPONSE_LIMIT),
    };
    const lockOptions = { deadline: options.deadline, signal: control.signal };
    let creationUncertain = false;
    try {
      return await withSearchLock(
        "slskd-search-create",
        async () => {
          for (let attempt = 0; attempt <= 3; attempt++) {
            await waitForSearchStartSlot(control.signal);
            const response = await withSearchLock(
              "slskd-api",
              async () => {
                const remaining = Number(options.deadline)
                  ? options.deadline! - Date.now()
                  : Infinity;
                if (remaining < 5000) throw new Error("slskd search deadline expired");
                dbOps.setJSONSetting(SEARCH_STARTED_AT_SETTING, Date.now());
                options.onSearchCreated?.(id);
                creationUncertain = true;
                let result;
                try {
                  result = await client.post(
                    "/api/v0/searches",
                    {
                      ...body,
                      searchTimeout: Math.min(searchTimeoutMs, remaining),
                    },
                    { timeoutMs: Math.min(60000, remaining), signal: control.signal },
                  );
                } catch (error) {
                  options.onSearchCreated?.(id);
                  throw error;
                }
                if ([200, 201].includes(result.status)) options.onSearchCreated?.(id);
                else if ([409, 429].includes(result.status)) {
                  creationUncertain = false;
                  options.onSearchSettled?.(id);
                }
                return result;
              },
              lockOptions,
            );
            if ([200, 201].includes(response.status)) return { id, searchText: body.searchText };
            if (response.status === 429 && attempt < 3) {
              const remaining = Number(options.deadline)
                ? options.deadline! - Date.now()
                : Infinity;
              await waitSearchDelay(Math.min(30000 * 2 ** attempt, remaining), control.signal);
              continue;
            }
            if (response.status === 409)
              throw soulseekLoggedOutError(
                `search refused (409) ${String(response.data || "")}`.trim(),
              );
            throw new Error(
              `slskd search failed: HTTP ${response.status} ${String(response.data || "")}`,
            );
          }
          throw new Error("slskd search busy after retries");
        },
        lockOptions,
      );
    } catch (error) {
      if (creationUncertain) {
        options.onSearchCreated?.(id);
        try {
          if (
            await this.deleteSearch(id, {
              timeoutMs: Math.max(1, Number(options.cleanupTimeoutMs) || 20000),
            })
          ) {
            options.onSearchSettled?.(id);
          }
        } catch (cleanupError) {
          logger.warn("slskd", "Could not stop owned search after creation failed", {
            searchId: id,
            reason: asAppError(cleanupError)?.message,
          });
        }
      }
      throw error;
    } finally {
      control.dispose();
    }
  }

  async getSearch(searchId: string, options: SlskdRequestOptions = {}): Promise<SlskdSearch> {
    const client = buildClient(this._config);
    const response = await client.get(`/api/v0/searches/${searchId}`, {
      query: { includeResponses: true },
      ...options,
    });
    if (response.status !== 200) {
      throw new Error(`slskd search status failed: HTTP ${response.status}`);
    }
    return readOne(searchSchema, response.data, {
      service: "slskd",
      endpoint: `/api/v0/searches/${searchId}`,
    });
  }

  async getSearchResponses(searchId: string, options: SlskdRequestOptions = {}) {
    const client = buildClient(this._config);
    const endpoint = `/api/v0/searches/${searchId}/responses`;
    const response = await client.get(endpoint, options);
    if (response.status !== 200) return [];
    return readMany(searchResponseSchema, response.data, { service: "slskd", endpoint });
  }

  async hydrateCompletedSearch(
    searchId: string,
    data: SlskdSearch,
    {
      deadline = Date.now() + 15000,
      shouldCancel,
      signal,
    }: Pick<SlskdSearchOptions, "deadline" | "shouldCancel" | "signal"> = {},
  ) {
    const responseCount = data.responseCount ?? 0;
    const fileCount = data.fileCount ?? 0;
    if (responseCount <= 0 && fileCount <= 0) return data;
    const collectedCount = this.flattenSearchResults(data).length;
    const hasEveryResponse = (responses: number) => responseCount > 0 && responses >= responseCount;
    if (
      collectedCount > 0 &&
      (fileCount <= 0 ||
        collectedCount >= fileCount ||
        hasEveryResponse(data.responses?.length ?? 0))
    )
      return data;
    const collected = new Map(
      this.flattenSearchResults(data).map((file) => [`${file.user}\0${file.file}`, file] as const),
    );
    const hydrationDeadline = Math.min(deadline, Date.now() + 15000);
    while (Date.now() < hydrationDeadline && !signal?.aborted && !shouldCancel?.()) {
      const requestSignal = untilDeadline(hydrationDeadline, signal);
      const [status, payload] = await Promise.allSettled([
        this.getSearch(searchId, { signal: requestSignal }),
        this.getSearchResponses(searchId, { signal: requestSignal }),
      ]);
      const refreshed = status.status === "fulfilled" ? status.value : data;
      for (const file of this.flattenSearchResults(refreshed))
        collected.set(`${file.user}\0${file.file}`, file);
      if (payload.status === "fulfilled") {
        for (const file of this.flattenSearchResults(payload.value))
          collected.set(`${file.user}\0${file.file}`, file);
      }
      data = { ...refreshed };
      Object.defineProperty(data, NORMALIZED_SEARCH_RESULTS, { value: [...collected.values()] });
      if (
        hasEveryResponse(
          Math.max(
            refreshed.responses?.length ?? 0,
            payload.status === "fulfilled" ? payload.value.length : 0,
          ),
        ) ||
        (fileCount > 0 ? collected.size >= fileCount : collected.size > collectedCount)
      )
        return data;
      if (Date.now() >= hydrationDeadline || signal?.aborted || shouldCancel?.()) break;
      const failed = [status, payload].find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      await waitSearchDelay(Math.min(500, hydrationDeadline - Date.now()), signal);
    }
    if (signal?.aborted || shouldCancel?.()) return data;
    logger.warn("slskd", "slskd search completed with counts but no file payloads", {
      searchId,
      responseCount,
      fileCount,
    });
    return data;
  }

  monitorSearch(searchId: string, options: SlskdSearchOptions = {}) {
    return new SearchMonitor(this, searchId, options);
  }

  async waitForSearch(
    searchId: string,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    options: SlskdSearchOptions = {},
  ) {
    const { earlyExitWhen, shouldCancel, signal: externalSignal } = options;
    const control = createSearchCancellation(shouldCancel, externalSignal);
    const monitor = this.monitorSearch(searchId, { ...options, timeoutMs });
    try {
      while (true) {
        const result = await monitor.poll({ earlyExitWhen, shouldCancel, signal: control.signal });
        if (result.done) return result.data;
        await waitSearchDelay(result.waitMs, control.signal);
      }
    } finally {
      control.dispose();
    }
  }

  flattenSearchResults(
    searchData:
      | Pick<SlskdSearch, "responses" | typeof NORMALIZED_SEARCH_RESULTS>
      | SlskdSearchResponse[]
      | null
      | undefined,
  ): SlskdSearchFile[] {
    if (!searchData) return [];
    if (!Array.isArray(searchData) && searchData[NORMALIZED_SEARCH_RESULTS])
      return searchData[NORMALIZED_SEARCH_RESULTS];
    const results = [];
    const seen = new Set<string>();
    for (const response of Array.isArray(searchData) ? searchData : (searchData.responses ?? [])) {
      const fileLists = [
        { files: response.files ?? [], locked: false },
        { files: response.lockedFiles ?? [], locked: true },
      ];
      for (const fileList of fileLists) {
        for (const file of fileList.files) {
          const normalized = normalizeSearchFile(file, response, fileList.locked);
          if (!normalized.user || !normalized.file) continue;
          const key = `${normalized.user}\0${normalized.file}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(normalized);
        }
      }
    }
    return results;
  }

  async searchQuery(searchText: string, options: SlskdSearchOptions = {}) {
    const timeoutMs =
      Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : DEFAULT_SEARCH_TIMEOUT_MS + DEFAULT_SEARCH_GRACE_PERIOD_MS;
    const deadline = Number(options.deadline) || Date.now() + timeoutMs;
    const created = await this.createSearch(searchText, { ...options, deadline });
    const completed = await this.waitForSearch(created.id, timeoutMs, { ...options, deadline });
    return this.flattenSearchResults(completed);
  }

  async enqueueBatch({
    username,
    files,
  }: {
    username: string;
    files: { filename?: string | null; file?: string | null; size?: number }[];
  }) {
    return withLock("slskd-api", async () => {
      const client = buildClient(this._config);
      const normalizedUsername = String(username || "").trim();
      const requests = (Array.isArray(files) ? files : []).map((file) => ({
        filename: String(file.filename || file.file || "").trim(),
        size: Number(file.size || 0),
      }));
      let retryCount = 0;
      let delaySeconds = 30;
      while (retryCount <= 3) {
        const endpoint = `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}`;
        const response = await client.post(endpoint, requests);
        if ([200, 201, 207].includes(response.status)) {
          const { enqueued: transfers = [], failed = [] } = readOne(enqueueSchema, response.data, {
            service: "slskd",
            endpoint,
          });
          if (requests.length > 0 && failed.length >= requests.length && transfers.length === 0) {
            throw new Error(`slskd enqueue failed: ${summarizeBatchFailures(failed)}`);
          }
          return {
            transferId: transfers[0]?.id || null,
            username: normalizedUsername,
            transfers,
          };
        }
        if (response.status === 429 && retryCount < 3) {
          await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
          retryCount += 1;
          delaySeconds *= 2;
          continue;
        }
        const detail = `HTTP ${response.status} ${String(response.data || "")}`;
        if (/must be connected and logged in/i.test(detail))
          throw soulseekLoggedOutError(`enqueue refused (${detail})`);
        throw new Error(`slskd enqueue failed: ${detail}`);
      }
      throw new Error("slskd enqueue busy after retries");
    });
  }

  async getTransfer(username: string | null | undefined, id: string) {
    const client = buildClient(this._config);
    const endpoint = `/api/v0/transfers/downloads/${encodeURIComponent(String(username))}/${id}`;
    const response = await client.get(endpoint);
    if (response.status !== 200) return null;
    return readOne(transferSchema, response.data, { service: "slskd", endpoint });
  }

  async deleteTransfer(username: string | null | undefined, id: string, { remove = true } = {}) {
    const normalizedUsername = String(username || "").trim();
    const normalizedId = String(id || "").trim();
    if (!normalizedUsername || !normalizedId) return false;
    const client = buildClient(this._config);
    const response = await client.delete(
      `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(normalizedId)}`,
      {
        query: remove ? { remove: true } : undefined,
      },
    );
    return [200, 202, 204, 404].includes(response.status);
  }

  async getEvents(offset = 0, limit = 50) {
    const client = buildClient(this._config);
    const response = await client.get("/api/v0/events", {
      query: { offset, limit },
    });
    if (response.status !== 200) {
      return { events: [], count: 0, totalCount: 0 };
    }
    const source = { service: "slskd", endpoint: "/api/v0/events" };
    const records = readMany(eventSchema, response.data, source);
    return {
      events: readMany(
        downloadEventSchema,
        records.filter((event) => downloadEventTypes.has(event.type)),
        source,
      ),
      count: records.length,
      totalCount: Number(response.headers["x-total-count"] || 0),
    };
  }

  async listSearches() {
    const client = buildClient(this._config);
    const response = await client.get("/api/v0/searches");
    if (response.status !== 200) return [];
    return readMany(searchSchema, response.data, {
      service: "slskd",
      endpoint: "/api/v0/searches",
    });
  }

  async stopSearch(searchId: string, options: SlskdRequestOptions = {}) {
    const endpoint = `/api/v0/searches/${encodeURIComponent(searchId)}`;
    const response = await buildClient(this._config).put(endpoint, undefined, {
      signal: untilDeadline(Date.now() + 10000, options.signal),
    });
    return response.status < 400;
  }

  async deleteSearch(searchId: string, options: SlskdRequestOptions = {}) {
    const id = String(searchId || "").trim();
    if (!id) return false;
    const client = buildClient(this._config);
    const endpoint = `/api/v0/searches/${encodeURIComponent(id)}`;
    const signal = untilDeadline(
      Date.now() + Math.max(1, Number(options.timeoutMs) || 20000),
      options.signal,
    );
    try {
      const cancelled = await client.put(endpoint, undefined, { signal });
      if (cancelled.status === 404) return true;
      if (cancelled.status >= 400) return false;
      while (!signal?.aborted) {
        const response = await client.get(endpoint, {
          signal,
          query: { includeResponses: false },
        });
        if (response.status === 404) return true;
        if (response.status !== 200) return false;
        if (readOne(searchSchema, response.data, { service: "slskd", endpoint }).endedAt) {
          const deleted = await client.delete(endpoint, { signal });
          return [200, 204, 404].includes(deleted.status);
        }
        await waitSearchDelay(250, signal);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
    return false;
  }

  async removeCompletedDownloads() {
    const client = buildClient(this._config);
    const response = await client.delete("/api/v0/transfers/downloads/all/completed");
    return [200, 204, 404].includes(response.status);
  }

  async cleanupAfterRun(
    options: { ownedOnly?: boolean; searchIds?: string[]; transfers?: SlskdTransferRef[] } = {},
  ) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "not configured" };
    }
    return withLock("slskd-api", async () => {
      let searchesRemoved = 0;
      let transfersRemoved = 0;
      const cleanedSearchIds: string[] = [];
      const ownedOnly = options.ownedOnly !== false;
      const explicitSearchIds = Array.isArray(options.searchIds) ? options.searchIds : [];
      const explicitTransfers = Array.isArray(options.transfers) ? options.transfers : [];
      let searchIds = explicitSearchIds.map((entry) => String(entry || "").trim()).filter(Boolean);
      let transfers = explicitTransfers;
      let markCleaned: (() => void) | null = null;

      if (ownedOnly && searchIds.length === 0 && transfers.length === 0) {
        try {
          const { getSlskdCleanupTargets, markSlskdCleanupTargetsCleaned } =
            await import("./slskdTransferHistory.ts");
          const targets = getSlskdCleanupTargets();
          searchIds = targets.searchIds;
          transfers = targets.transfers;
          markCleaned = markSlskdCleanupTargetsCleaned;
        } catch (error) {
          logger.warn("slskd", "Failed to read scoped slskd cleanup targets", {
            error: asAppError(error)?.message || String(error),
          });
        }
      }

      if (!ownedOnly) {
        const searches = await this.listSearches();
        searchIds = searches
          .filter((search) => !isSearchInProgress(search))
          .flatMap((search) => (search.id ? [search.id] : []));
      }

      for (const searchId of [...new Set(searchIds)]) {
        if (await this.deleteSearch(searchId)) {
          searchesRemoved += 1;
          cleanedSearchIds.push(searchId);
        }
      }

      for (const transfer of transfers) {
        const username = String(transfer?.username || "").trim();
        const transferId = String(transfer?.transferId || transfer?.id || "").trim();
        if (!username || !transferId) continue;
        if (await this.deleteTransfer(username, transferId, { remove: true })) {
          transfersRemoved += 1;
        }
      }

      const downloadsRemoved = ownedOnly
        ? transfersRemoved > 0
        : await this.removeCompletedDownloads();

      if (
        typeof markCleaned === "function" &&
        cleanedSearchIds.length === new Set(searchIds).size
      ) {
        markCleaned();
      }
      logger.info("slskd", "Cleaned up slskd after run", {
        ownedOnly,
        searchesRemoved,
        transfersRemoved,
        downloadsRemoved,
      });
      return {
        searchesRemoved,
        transfersRemoved,
        downloadsRemoved,
        cleanedSearchIds,
      };
    });
  }
}

export const slskdClient = new SlskdClient();
