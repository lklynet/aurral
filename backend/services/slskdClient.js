import axios from "../../lib/axiosFetch.js";
import { randomUUID } from "crypto";
import { dbOps } from "../db/helpers/index.js";
import { withHonkerLock } from "./honkerDb.js";
import { logger } from "./logger.js";

const NORMALIZED_SEARCH_RESULTS = Symbol("normalizedSearchResults");
const DEFAULT_SEARCH_TIMEOUT_MS = 60000;
const DEFAULT_EMPTY_SEARCH_TIMEOUT_MS = 10000;
const DEFAULT_SEARCH_GRACE_PERIOD_MS = 20000;
const DEFAULT_FILE_LIMIT = 1000;
const DEFAULT_RESPONSE_LIMIT = 150;
const DEFAULT_MAX_PEER_QUEUE = 150;
const DEFAULT_MIN_PEER_SPEED = 51200;

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
      hint: "Optional - leave empty when slskd authentication is disabled (for example behind an authenticating reverse proxy).",
    }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Behavior",
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

let connectionCache = { checkedAt: 0, result: null, settingsKey: null };

function getSettingsKey({ url, apiKey }) {
  return `${url}\u0000${apiKey}`;
}

function cacheConnectionResult(settingsKey, result, config = null) {
  const activeSettings = getSettings(config);
  if (getSettingsKey(activeSettings) !== settingsKey) return;
  connectionCache = { checkedAt: Date.now(), result, settingsKey };
}

function getSettings(config = null) {
  const integrations = config
    ? { slskd: config }
    : dbOps.getSettings()?.integrations || {};
  const slskd = integrations.slskd || {};
  const url = String(slskd.url || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(slskd.apiKey || "").trim();
  return { url, apiKey, slskd };
}

export function getSlskdSearchFormatOptions(config = null) {
  const slskd = getSettings(config).slskd || {};
  const preferredFormat =
    String(slskd.preferredFormat || "").toLowerCase() === "mp3" ? "mp3" : "flac";
  return {
    preferredFormat,
    strictFormat: slskd.preferredFormatStrict === true,
  };
}

export function isSlskdCleanupAfterRunsEnabled(config = null) {
  const slskd = getSettings(config).slskd || {};
  return slskd.cleanupAfterRuns === true;
}

function buildClientFromCredentials(url, apiKey) {
  const trimmedUrl = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedUrl) {
    throw new Error("slskd not configured");
  }
  const headers = { Accept: "application/json" };
  if (trimmedKey) {
    headers["X-API-KEY"] = trimmedKey;
  }
  return axios.create({
    baseURL: trimmedUrl,
    timeout: 60000,
    headers,
    validateStatus: () => true,
  });
}

function buildClient(config = null) {
  const { url, apiKey } = getSettings(config);
  return buildClientFromCredentials(url, apiKey);
}

function calculateQuadraticDelay(progress) {
  const delay = 16 * progress ** 2 - 16 * progress + 5;
  return Math.min(5, Math.max(0.5, delay));
}

function readProperty(object, ...keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeArrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.$values)) return value.$values;
  if (value && typeof value === "object") {
    const values = Object.values(value);
    if (values.every((entry) => entry && typeof entry === "object")) {
      return values;
    }
  }
  return [];
}

export function isSearchComplete(data) {
  if (data?.isComplete === true || data?.IsComplete === true) return true;
  const state = String(data?.state || data?.State || "");
  return state.includes("Completed");
}

export function isSearchInProgress(data) {
  if (isSearchComplete(data)) return false;
  const state = String(data?.state || data?.State || "").trim();
  if (!state || state === "None") return true;
  if (state.includes("InProgress")) return true;
  return state === "Requested" || state === "Queued";
}

function readSearchResponses(searchData) {
  if (Array.isArray(searchData)) return searchData;
  const responses = readProperty(searchData, "responses", "Responses");
  return normalizeArrayPayload(responses);
}

function normalizeSearchFile(file, user, response = null, fromLockedList = false) {
  const filename = String(readProperty(file, "filename", "Filename", "file", "File") || "").trim();
  const size = Number(readProperty(file, "size", "Size") || 0);
  const responseUser = readProperty(response, "username", "Username");
  const resolvedUser = String(
    user || responseUser || readProperty(file, "user", "User") || "",
  ).trim();
  const responseSlots = readProperty(response, "hasFreeUploadSlot", "HasFreeUploadSlot");
  const locked =
    fromLockedList || readProperty(file, "isLocked", "IsLocked", "locked", "Locked") === true;
  const bitRate = readProperty(file, "bitRate", "BitRate", "bitrate") ?? null;
  const advertisedLength = Number(readProperty(file, "length", "Length"));
  const length =
    Number.isFinite(advertisedLength) && advertisedLength > 0 ? advertisedLength : null;
  return {
    user: resolvedUser,
    file: filename,
    size,
    slots: Number(
      readProperty(file, "slots", "Slots", "freeUploadSlots") ?? (responseSlots === true ? 1 : 0),
    ),
    speed: Number(
      readProperty(file, "uploadSpeed", "UploadSpeed", "speed", "Speed") ??
        readProperty(response, "uploadSpeed", "UploadSpeed") ??
        0,
    ),
    bitRate,
    bitrate: bitRate,
    length,
    extension: readProperty(file, "extension", "Extension") ?? null,
    locked,
    isLocked: locked,
  };
}

function readBatchFailures(data) {
  return normalizeArrayPayload(readProperty(data, "failed", "Failed", "failures", "Failures"));
}

function readLegacyEnqueued(data) {
  return normalizeArrayPayload(readProperty(data, "enqueued", "Enqueued"));
}

function summarizeBatchFailures(failures) {
  const messages = normalizeArrayPayload(failures)
    .map((failure) => {
      if (typeof failure === "string") return failure.trim();
      const filename = String(readProperty(failure, "filename", "Filename") || "").trim();
      const message = String(readProperty(failure, "message", "Message") || "").trim();
      return [filename, message].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : "all files failed";
}

function readId(value) {
  return readProperty(value, "id", "Id");
}

function createSearchCancellation(shouldCancel, externalSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted || shouldCancel?.()) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = typeof shouldCancel === "function" ? setInterval(() => {
    if (shouldCancel()) abort();
  }, 100) : null;
  timer?.unref();
  return {
    signal: controller.signal,
    dispose: () => { clearInterval(timer); externalSignal?.removeEventListener("abort", abort); },
  };
}

function waitSearchDelay(ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    if (signal?.aborted) return resolve();
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", finish);
      resolve();
    }, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function withSearchLock(name, operation, { deadline, signal }) {
  const lockDeadline = Number(deadline) || Date.now() + 300000;
  while (true) {
    if (signal.aborted) throw new Error("slskd search cancelled");
    const remaining = lockDeadline - Date.now();
    if (remaining <= 0) throw new Error("slskd search deadline expired");
    try {
      return await withHonkerLock(name, () => {
        if (signal.aborted) throw new Error("slskd search cancelled");
        if (Date.now() >= lockDeadline) throw new Error("slskd search deadline expired");
        return operation();
      }, { waitTimeoutMs: Math.min(250, remaining) });
    } catch (error) {
      if (error.message !== `Timed out waiting for Honker lock: ${name}`) throw error;
    }
  }
}

export class SlskdClient {
  constructor(config = null) {
    this.key = "slskd";
    this.name = "slskd";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  isCleanupAfterRunsEnabled() {
    return isSlskdCleanupAfterRunsEnabled(this._config);
  }

  isConfigured() {
    const { url, slskd } = getSettings(this._config);
    return slskd.enabled !== false && !!url;
  }

  async testConnection({ force = false } = {}) {
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
      const server = appRes.data?.server || {};
      const serverState = String(server.state || "");
      const soulseekConnected = server.isConnected === true || serverState.includes("Connected");
      const rawDownloadPath =
        optionsRes.data?.directories?.downloads || optionsRes.data?.directories?.download;
      const downloadPath = Array.isArray(rawDownloadPath) ? String(rawDownloadPath[0] || "").trim() || null : String(rawDownloadPath || "").trim() || null;
      const result = {
        ok: true,
        configured: true,
        connected: soulseekConnected,
        soulseekConnected,
        warning: !soulseekConnected,
        serverState,
        downloadPath,
        message: soulseekConnected
          ? "slskd is connected"
          : "slskd is reachable, but it is not connected to Soulseek. Open slskd and connect to the Soulseek server.",
      };
      cacheConnectionResult(settingsKey, result, this._config);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach slskd",
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

  async createSearch(searchText, options = {}) {
    const control = createSearchCancellation(options.shouldCancel, options.signal);
    const id = String(options.id || randomUUID());
    const client = buildClient(this._config);
    const searchTimeoutMs = Math.max(5000, Math.floor(Number(options.searchTimeoutMs || DEFAULT_SEARCH_TIMEOUT_MS)));
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
      return await withSearchLock("slskd-search-create", async () => {
        for (let attempt = 0; attempt <= 3; attempt++) {
          const response = await withSearchLock("slskd-api", async () => {
            const remaining = Number(options.deadline) ? options.deadline - Date.now() : Infinity;
            if (remaining < 5000) throw new Error("slskd search deadline expired");
            options.onSearchCreated?.(id);
            creationUncertain = true;
            let result;
            try {
              result = await client.post("/api/v0/searches", {
                ...body, searchTimeout: Math.min(searchTimeoutMs, remaining),
              }, { timeout: Math.min(60000, remaining), signal: control.signal });
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
          }, lockOptions);
          if ([200, 201].includes(response.status)) return { id, searchText: body.searchText };
          if (response.status === 429 && attempt < 3) {
            const remaining = Number(options.deadline) ? options.deadline - Date.now() : Infinity;
            await waitSearchDelay(Math.min(30000 * 2 ** attempt, remaining), control.signal);
            continue;
          }
          if (response.status === 409) throw new Error("slskd Soulseek connection unavailable (409)");
          throw new Error(`slskd search failed: HTTP ${response.status} ${String(response.data || "")}`);
        }
        throw new Error("slskd search busy after retries");
      }, lockOptions);
    } catch (error) {
      if (creationUncertain) {
        options.onSearchCreated?.(id);
        try {
          if (await this.deleteSearch(id, { timeout: Math.max(1, Number(options.cleanupTimeoutMs) || 20000) })) {
            options.onSearchSettled?.(id);
          }
        } catch (cleanupError) {
          logger.warn("slskd", "Could not stop owned search after creation failed", { searchId: id, reason: cleanupError?.message });
        }
      }
      throw error;
    } finally {
      control.dispose();
    }
  }

  async getSearch(searchId, options = {}) {
    const client = buildClient(this._config);
    const response = await client.get(`/api/v0/searches/${searchId}`, {
      params: { includeResponses: true },
      ...options,
    });
    if (response.status !== 200) {
      throw new Error(`slskd search status failed: HTTP ${response.status}`);
    }
    return response.data;
  }

  async getSearchResponses(searchId, options = {}) {
    const client = buildClient(this._config);
    const response = await client.get(`/api/v0/searches/${searchId}/responses`, options);
    if (response.status !== 200) return [];
    return readSearchResponses(response.data);
  }

  async hydrateCompletedSearch(searchId, data, { deadline = Date.now() + 15000, shouldCancel, signal } = {}) {
    const responseCount = Number(data?.responseCount || data?.ResponseCount || 0);
    const fileCount = Number(data?.fileCount || data?.FileCount || 0);
    if (responseCount <= 0 && fileCount <= 0) return data;
    const collectedCount = this.flattenSearchResults(data).length;
    if (collectedCount > 0 && (fileCount <= 0 || collectedCount >= fileCount)) return data;
    const collected = new Map(this.flattenSearchResults(data).map((file) => [`${file.user}\0${file.file}`, file]));
    const hydrationDeadline = Math.min(deadline, Date.now() + 15000);
    while (Date.now() < hydrationDeadline && !signal?.aborted && !shouldCancel?.()) {
      const timeout = Math.max(1, Math.min(60000, hydrationDeadline - Date.now()));
      const [status, payload] = await Promise.allSettled([
        this.getSearch(searchId, { timeout, signal }),
        this.getSearchResponses(searchId, { timeout, signal }),
      ]);
      const refreshed = status.status === "fulfilled" ? status.value : data;
      for (const file of this.flattenSearchResults(refreshed)) collected.set(`${file.user}\0${file.file}`, file);
      if (payload.status === "fulfilled") {
        for (const file of this.flattenSearchResults(payload.value)) collected.set(`${file.user}\0${file.file}`, file);
      }
      data = { ...refreshed };
      Object.defineProperty(data, NORMALIZED_SEARCH_RESULTS, { value: [...collected.values()] });
      if (fileCount > 0 ? collected.size >= fileCount : collected.size > collectedCount) return data;
      if (Date.now() >= hydrationDeadline || signal?.aborted || shouldCancel?.()) break;
      const failed = [status, payload].find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      await waitSearchDelay(Math.min(500, hydrationDeadline - Date.now()), signal);
    }
    if (signal?.aborted || shouldCancel?.()) return data;
    logger.warn("slskd", "slskd search completed with counts but no file payloads", { searchId, responseCount, fileCount });
    return data;
  }

  async waitForSearch(searchId, timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS, options = {}) {
    const { earlyExitWhen, shouldCancel, signal: externalSignal, onSearchSettled } = options;
    const control = createSearchCancellation(shouldCancel, externalSignal);
    const signal = control.signal;
    const emptyTimeoutMs = Math.max(0, Number(options.emptyTimeoutMs ?? DEFAULT_EMPTY_SEARCH_TIMEOUT_MS));
    const activeTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_SEARCH_TIMEOUT_MS;
    const gracePeriodMs = Math.max(0, Number(options.gracePeriodMs ?? DEFAULT_SEARCH_GRACE_PERIOD_MS));
    const start = Date.now();
    const deadline = Math.min(Number(options.deadline) || Infinity, start + activeTimeoutMs + gracePeriodMs);
    let totalFiles = 0;
    let hasSeenFiles = false;
    let latest = null;
    const collected = new Map();
    let eligibilityAssessed = false;
    let lastEligibility = false;
    const stopSearch = async () => {
      try {
        const deleted = await this.deleteSearch(searchId, { timeout: Math.max(1, Number(options.cleanupTimeoutMs) || 20000) });
        if (deleted) onSearchSettled?.(searchId);
        else logger.warn("slskd", "Could not stop owned search", { searchId });
      } catch (error) {
        logger.warn("slskd", "Could not stop owned search", { searchId, reason: error?.message });
      }
    };
    const finish = async (data) => {
      if (isSearchComplete(data) && !this.isCleanupAfterRunsEnabled()) {
        onSearchSettled?.(searchId);
      } else {
        await stopSearch();
      }
      return data;
    };
    try {
      while (true) {
        if (signal.aborted || shouldCancel?.()) { await stopSearch(); return null; }
        const cutoff = hasSeenFiles ? deadline : Math.min(deadline, start + emptyTimeoutMs);
        if (Date.now() >= cutoff) return await finish(latest);
        let data;
        try {
          data = await this.getSearch(searchId, { timeout: Math.max(1, Math.min(60000, cutoff - Date.now())), signal });
        } catch (error) {
          if (signal.aborted || shouldCancel?.()) { await stopSearch(); return null; }
          if (Date.now() >= cutoff) return await finish(latest);
          throw error;
        }
        if (signal.aborted || shouldCancel?.()) { await stopSearch(); return null; }
        const files = this.flattenSearchResults(data);
        let eligibilityChanged = false;
        for (const file of files) {
          const key = `${file.user}\0${file.file}`;
          const previous = collected.get(key);
          if (!previous || Object.keys(file).some((field) => !Object.is(file[field], previous[field]))) {
            collected.set(key, file);
            eligibilityChanged = true;
          }
        }
        if (collected.size > files.length) {
          const responses = new Map();
          for (const file of collected.values()) {
            const response = responses.get(file.user) || { username: file.user, files: [] };
            response.files.push(file);
            responses.set(file.user, response);
          }
          data = { ...data, responses: [...responses.values()] };
        }
        data = { ...data };
        Object.defineProperty(data, NORMALIZED_SEARCH_RESULTS, { value: [...collected.values()] });
        latest = data;
        const fileCount = Number(data?.fileCount || data?.FileCount || 0);
        totalFiles = Math.max(totalFiles, fileCount, files.length);
        hasSeenFiles ||= totalFiles > 0;
        if (earlyExitWhen && (!eligibilityAssessed || eligibilityChanged)) {
          lastEligibility = earlyExitWhen(data);
          eligibilityAssessed = true;
        }
        if (lastEligibility || !isSearchInProgress(data)) {
          let hydrated = isSearchComplete(data)
            ? await this.hydrateCompletedSearch(searchId, data, { deadline, shouldCancel, signal })
            : data;
          if (signal.aborted || shouldCancel?.()) { await stopSearch(); return null; }
          if (hydrated !== data) {
            for (const file of this.flattenSearchResults(hydrated)) collected.set(`${file.user}\0${file.file}`, file);
            hydrated = { ...hydrated };
            Object.defineProperty(hydrated, NORMALIZED_SEARCH_RESULTS, { value: [...collected.values()] });
          }
          return await finish(hydrated);
        }
        const nextCutoff = hasSeenFiles ? deadline : Math.min(deadline, start + emptyTimeoutMs);
        if (Date.now() >= nextCutoff) return await finish(latest);
        const progress = Math.min(1, totalFiles / DEFAULT_FILE_LIMIT);
        const grace = Date.now() >= start + activeTimeoutMs;
        const waitMs = Math.min((grace ? 1 : calculateQuadraticDelay(progress)) * 1000, nextCutoff - Date.now());
        await waitSearchDelay(waitMs, signal);
      }
    } catch (error) {
      await stopSearch();
      throw error;
    } finally {
      control.dispose();
    }
  }

  async settleSearch(searchId, { cancel = false, maxWaitMs = 120000 } = {}) {
    const id = String(searchId || "").trim();
    if (!id) return null;
    if (cancel) {
      await this.deleteSearch(id);
      return null;
    }
    const deadline = Date.now() + Math.max(1000, Number(maxWaitMs) || 120000);
    let lastData = null;
    while (Date.now() < deadline) {
      lastData = await this.getSearch(id);
      if (!isSearchInProgress(lastData)) {
        return lastData;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await this.deleteSearch(id);
    return lastData;
  }

  flattenSearchResults(searchData) {
    if (searchData?.[NORMALIZED_SEARCH_RESULTS]) return searchData[NORMALIZED_SEARCH_RESULTS];
    const results = [];
    const seen = new Set();
    for (const response of readSearchResponses(searchData)) {
      const user = String(readProperty(response, "username", "Username") || "").trim();
      const fileLists = [
        {
          files: readProperty(response, "files", "Files"),
          locked: false,
        },
        {
          files: readProperty(response, "lockedFiles", "LockedFiles"),
          locked: true,
        },
      ];
      for (const fileList of fileLists) {
        const files = normalizeArrayPayload(fileList.files);
        for (const file of files) {
          const normalized = normalizeSearchFile(file, user, response, fileList.locked);
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

  async searchQuery(searchText, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs)
      : DEFAULT_SEARCH_TIMEOUT_MS + DEFAULT_SEARCH_GRACE_PERIOD_MS;
    const deadline = Number(options.deadline) || Date.now() + timeoutMs;
    const created = await this.createSearch(searchText, {
      ...options, deadline, searchTimeoutMs: Math.min(Number(options.searchTimeoutMs) || timeoutMs, deadline - Date.now()),
    });
    const completed = await this.waitForSearch(created.id, timeoutMs, { ...options, deadline });
    return this.flattenSearchResults(completed);
  }

  async enqueueBatch({ username, files }) {
    return withHonkerLock("slskd-api", async () => {
      const client = buildClient(this._config);
      const normalizedUsername = String(username || "").trim();
      const requests = (Array.isArray(files) ? files : []).map((file) => ({
        filename: String(file.filename || file.file || "").trim(),
        size: Number(file.size || 0),
      }));
      let retryCount = 0;
      let delaySeconds = 30;
      while (retryCount <= 3) {
        const response = await client.post(
          `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}`,
          requests,
        );
        if ([200, 201, 207].includes(response.status)) {
          const failures = readBatchFailures(response.data);
          const transfers = readLegacyEnqueued(response.data);
          if (requests.length > 0 && failures.length >= requests.length && transfers.length === 0) {
            throw new Error(`slskd enqueue failed: ${summarizeBatchFailures(failures)}`);
          }
          const firstTransfer = transfers[0] || null;
          return {
            batchId: null,
            legacy: true,
            transferId: readId(firstTransfer) || null,
            username: normalizedUsername,
            transfers,
            response: response.data,
          };
        }
        if (response.status === 429 && retryCount < 3) {
          await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
          retryCount += 1;
          delaySeconds *= 2;
          continue;
        }
        throw new Error(
          `slskd enqueue failed: HTTP ${response.status} ${String(response.data || "")}`,
        );
      }
      throw new Error("slskd enqueue busy after retries");
    });
  }

  async getTransfer(username, id) {
    const client = buildClient(this._config);
    const response = await client.get(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${id}`,
    );
    if (response.status !== 200) return null;
    return response.data;
  }

  async deleteTransfer(username, id, { remove = true } = {}) {
    const normalizedUsername = String(username || "").trim();
    const normalizedId = String(id || "").trim();
    if (!normalizedUsername || !normalizedId) return false;
    const client = buildClient(this._config);
    const response = await client.delete(
      `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(normalizedId)}`,
      {
        params: remove ? { remove: true } : undefined,
      },
    );
    return [200, 202, 204, 404].includes(response.status);
  }

  async listDownloads() {
    const client = buildClient(this._config);
    const response = await client.get("/api/v0/transfers/downloads");
    if (response.status !== 200) return [];
    return Array.isArray(response.data) ? response.data : [];
  }

  async getEvents(offset = 0, limit = 50) {
    const client = buildClient(this._config);
    const response = await client.get("/api/v0/events", {
      params: { offset, limit },
    });
    if (response.status !== 200) {
      return { events: [], totalCount: 0 };
    }
    const totalCount = Number(response.headers["x-total-count"] || 0);
    return {
      events: Array.isArray(response.data) ? response.data : [],
      totalCount,
    };
  }

  async listSearches() {
    const client = buildClient(this._config);
    const response = await client.get("/api/v0/searches");
    if (response.status !== 200) return [];
    return normalizeArrayPayload(response.data);
  }

  async deleteSearch(searchId, options = {}) {
    const id = String(searchId || "").trim();
    if (!id) return false;
    const client = buildClient(this._config);
    const response = await client.delete(`/api/v0/searches/${encodeURIComponent(id)}`, options);
    return [200, 204, 404].includes(response.status);
  }

  async removeCompletedDownloads() {
    const client = buildClient(this._config);
    const response = await client.delete("/api/v0/transfers/downloads/all/completed");
    return [200, 204, 404].includes(response.status);
  }

  async cleanupAfterRun(options = {}) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "not configured" };
    }
    return withHonkerLock("slskd-api", async () => {
      let searchesRemoved = 0;
      let transfersRemoved = 0;
      const cleanedSearchIds = [];
      const ownedOnly = options.ownedOnly !== false;
      const explicitSearchIds = Array.isArray(options.searchIds) ? options.searchIds : [];
      const explicitTransfers = Array.isArray(options.transfers) ? options.transfers : [];
      let searchIds = explicitSearchIds.map((entry) => String(entry || "").trim()).filter(Boolean);
      let transfers = explicitTransfers;
      let markCleaned = null;

      if (ownedOnly && searchIds.length === 0 && transfers.length === 0) {
        try {
          const { getSlskdCleanupTargets, markSlskdCleanupTargetsCleaned } =
            await import("./slskdTransferHistory.js");
          const targets = getSlskdCleanupTargets();
          searchIds = targets.searchIds;
          transfers = targets.transfers;
          markCleaned = markSlskdCleanupTargetsCleaned;
        } catch (error) {
          logger.warn("slskd", "Failed to read scoped slskd cleanup targets", {
            error: error?.message || String(error),
          });
        }
      }

      if (!ownedOnly) {
        const searches = await this.listSearches();
        searchIds = searches
          .filter((search) => !isSearchInProgress(search))
          .map((search) => readId(search))
          .filter(Boolean);
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

      if (typeof markCleaned === "function") {
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
