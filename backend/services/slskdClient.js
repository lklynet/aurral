import axios from "axios";
import { randomUUID } from "crypto";
import { dbOps } from "../config/db-helpers.js";
import { withHonkerLock } from "./honkerDb.js";
import { logger } from "./logger.js";

const DEFAULT_SEARCH_TIMEOUT_MS = 60000;
const DEFAULT_EMPTY_SEARCH_TIMEOUT_MS = 10000;
const DEFAULT_SEARCH_GRACE_PERIOD_MS = 20000;
const DEFAULT_FILE_LIMIT = 1000;
const DEFAULT_RESPONSE_LIMIT = 150;
const DEFAULT_MAX_PEER_QUEUE = 150;
const DEFAULT_MIN_PEER_SPEED = 51200;

let connectionCache = { checkedAt: 0, result: null };

function getSettings() {
  const integrations = dbOps.getSettings()?.integrations || {};
  const slskd = integrations.slskd || {};
  const url = String(slskd.url || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(slskd.apiKey || "").trim();
  return { url, apiKey, slskd };
}

export function getSlskdSearchFormatOptions() {
  const slskd = getSettings().slskd || {};
  const preferredFormat =
    String(slskd.preferredFormat || "").toLowerCase() === "mp3"
      ? "mp3"
      : "flac";
  return {
    preferredFormat,
    strictFormat: slskd.preferredFormatStrict === true,
  };
}

export function isSlskdCleanupAfterRunsEnabled() {
  const slskd = getSettings().slskd || {};
  return slskd.cleanupAfterRuns === true;
}

function buildClientFromCredentials(url, apiKey) {
  const trimmedUrl = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedUrl || !trimmedKey) {
    throw new Error("slskd not configured");
  }
  return axios.create({
    baseURL: trimmedUrl,
    timeout: 60000,
    headers: {
      "X-API-KEY": trimmedKey,
      Accept: "application/json",
    },
    validateStatus: () => true,
  });
}

function buildClient() {
  const { url, apiKey } = getSettings();
  return buildClientFromCredentials(url, apiKey);
}

export async function testSlskdWithCredentials(url, apiKey) {
  const trimmedUrl = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedUrl || !trimmedKey) {
    return {
      ok: false,
      configured: false,
      connected: false,
      message: "slskd URL and API key are required",
    };
  }
  const client = buildClientFromCredentials(trimmedUrl, trimmedKey);
  try {
    const [appRes, optionsRes] = await Promise.all([
      client.get("/api/v0/application"),
      client.get("/api/v0/options"),
    ]);
    if (appRes.status !== 200) {
      return {
        ok: false,
        configured: true,
        connected: false,
        message: `slskd returned HTTP ${appRes.status}`,
      };
    }
    const server = appRes.data?.server || {};
    const serverState = String(server.state || "");
    const soulseekConnected =
      server.isConnected === true || serverState.includes("Connected");
    const downloadPath =
      optionsRes.data?.directories?.downloads ||
      optionsRes.data?.directories?.download ||
      null;
    return {
      ok: true,
      configured: true,
      connected: soulseekConnected,
      soulseekConnected,
      warning: !soulseekConnected,
      serverState,
      downloadPath,
      message: soulseekConnected
        ? "slskd is connected"
        : `Aurral reached slskd, but Soulseek is ${serverState || "disconnected"}. Open slskd, log in, and connect to the Soulseek server.`,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      connected: false,
      message: error?.message || "Failed to reach slskd",
    };
  }
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

function normalizeSearchFile(
  file,
  user,
  response = null,
  fromLockedList = false,
) {
  const filename = String(
    readProperty(file, "filename", "Filename", "file", "File") || "",
  ).trim();
  const size = Number(
    readProperty(file, "size", "Size", "length", "Length") || 0,
  );
  const responseUser = readProperty(response, "username", "Username");
  const resolvedUser = String(
    user || responseUser || readProperty(file, "user", "User") || "",
  ).trim();
  const responseSlots = readProperty(
    response,
    "hasFreeUploadSlot",
    "HasFreeUploadSlot",
  );
  const locked =
    fromLockedList ||
    readProperty(file, "isLocked", "IsLocked", "locked", "Locked") === true;
  const bitRate = readProperty(file, "bitRate", "BitRate", "bitrate") ?? null;
  return {
    user: resolvedUser,
    file: filename,
    size,
    slots: Number(
      readProperty(file, "slots", "Slots", "freeUploadSlots") ??
        (responseSlots === true ? 1 : 0),
    ),
    speed: Number(
      readProperty(file, "uploadSpeed", "UploadSpeed", "speed", "Speed") ??
        readProperty(response, "uploadSpeed", "UploadSpeed") ??
        0,
    ),
    bitRate,
    bitrate: bitRate,
    extension: readProperty(file, "extension", "Extension") ?? null,
    locked,
    isLocked: locked,
  };
}

function readBatchFailures(data) {
  return normalizeArrayPayload(readProperty(data, "failures", "Failures"));
}

function readBatchTransfers(data) {
  const batch = readProperty(data, "batch", "Batch") || data;
  return normalizeArrayPayload(readProperty(batch, "transfers", "Transfers"));
}

function readLegacyEnqueued(data) {
  return normalizeArrayPayload(readProperty(data, "enqueued", "Enqueued"));
}

function shouldFallbackToLegacyDownloadEndpoint(response) {
  if (![400, 404, 405].includes(Number(response?.status))) return false;
  const message =
    typeof response?.data === "string"
      ? response.data
      : JSON.stringify(response?.data || "");
  return (
    response.status === 404 ||
    message.includes("QueueDownloadRequest") ||
    message.includes("IEnumerable")
  );
}

function summarizeBatchFailures(failures) {
  const messages = normalizeArrayPayload(failures)
    .map((failure) => {
      const filename = String(
        readProperty(failure, "filename", "Filename") || "",
      ).trim();
      const message = String(
        readProperty(failure, "message", "Message") || "",
      ).trim();
      return [filename, message].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : "all files failed";
}

function readId(value) {
  return readProperty(value, "id", "Id");
}

export class SlskdClient {
  isConfigured() {
    const { url, apiKey } = getSettings();
    return !!(url && apiKey);
  }

  async testConnection({ force = false } = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "slskd URL and API key are required",
      };
    }
    if (
      !force &&
      connectionCache.result &&
      Date.now() - connectionCache.checkedAt < 30000
    ) {
      return connectionCache.result;
    }
    const client = buildClient();
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
        connectionCache = { checkedAt: Date.now(), result };
        return result;
      }
      const server = appRes.data?.server || {};
      const serverState = String(server.state || "");
      const soulseekConnected =
        server.isConnected === true || serverState.includes("Connected");
      const downloadPath =
        optionsRes.data?.directories?.downloads ||
        optionsRes.data?.directories?.download ||
        null;
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
          : `Aurral reached slskd, but Soulseek is ${serverState || "disconnected"}. Open slskd, log in, and connect to the Soulseek server.`,
      };
      connectionCache = { checkedAt: Date.now(), result };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach slskd",
      };
      connectionCache = { checkedAt: Date.now(), result };
      return result;
    }
  }

  getStatus() {
    const configured = this.isConfigured();
    const cached = connectionCache.result;
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
    return withHonkerLock("slskd-api", async () => {
      const client = buildClient();
      const id = String(options.id || randomUUID());
      const searchTimeoutMs = Math.max(
        5000,
        Math.floor(
          Number(options.searchTimeoutMs || DEFAULT_SEARCH_TIMEOUT_MS),
        ),
      );
      const body = {
        id,
        searchText: String(searchText || "").trim(),
        fileLimit: Number(options.fileLimit || DEFAULT_FILE_LIMIT),
        filterResponses: options.filterResponses !== false,
        maximumPeerQueueLength: Number(
          options.maximumPeerQueueLength || DEFAULT_MAX_PEER_QUEUE,
        ),
        minimumPeerUploadSpeed: Number(
          options.minimumPeerUploadSpeed || DEFAULT_MIN_PEER_SPEED,
        ),
        minimumResponseFileCount: Number(options.minimumResponseFileCount || 1),
        responseLimit: Number(options.responseLimit || DEFAULT_RESPONSE_LIMIT),
        searchTimeout: searchTimeoutMs,
      };
      let retryCount = 0;
      let delaySeconds = 30;
      while (retryCount <= 3) {
        const response = await client.post("/api/v0/searches", body);
        if (response.status === 201 || response.status === 200) {
          return { id, searchText: body.searchText };
        }
        if (response.status === 429 && retryCount < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, delaySeconds * 1000),
          );
          retryCount += 1;
          delaySeconds *= 2;
          continue;
        }
        if (response.status === 409) {
          throw new Error("slskd Soulseek connection unavailable (409)");
        }
        throw new Error(
          `slskd search failed: HTTP ${response.status} ${String(response.data || "")}`,
        );
      }
      throw new Error("slskd search busy after retries");
    });
  }

  async getSearch(searchId) {
    const client = buildClient();
    const response = await client.get(`/api/v0/searches/${searchId}`, {
      params: { includeResponses: true },
    });
    if (response.status !== 200) {
      throw new Error(`slskd search status failed: HTTP ${response.status}`);
    }
    return response.data;
  }

  async getSearchResponses(searchId) {
    const client = buildClient();
    const response = await client.get(`/api/v0/searches/${searchId}/responses`);
    if (response.status !== 200) return [];
    return readSearchResponses(response.data);
  }

  async hydrateCompletedSearch(searchId, data) {
    const responseCount = Number(
      data?.responseCount || data?.ResponseCount || 0,
    );
    const fileCount = Number(data?.fileCount || data?.FileCount || 0);
    if (responseCount <= 0 && fileCount <= 0) return data;
    if (this.flattenSearchResults(data).length > 0) return data;

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshed = await this.getSearch(searchId);
      if (this.flattenSearchResults(refreshed).length > 0) {
        return refreshed;
      }
      const responses = await this.getSearchResponses(searchId);
      if (responses.length > 0) {
        return { ...refreshed, responses };
      }
    }

    const responses = await this.getSearchResponses(searchId);
    if (responses.length > 0) {
      return { ...data, responses };
    }
    logger.slskd(
      "warn",
      "slskd search completed with counts but no file payloads",
      {
        searchId,
        responseCount,
        fileCount,
      },
    );
    return data;
  }

  async waitForSearch(
    searchId,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    options = {},
  ) {
    const earlyExitWhen =
      typeof options.earlyExitWhen === "function"
        ? options.earlyExitWhen
        : null;
    const emptyTimeoutMs = Math.max(
      0,
      Number(options.emptyTimeoutMs ?? DEFAULT_EMPTY_SEARCH_TIMEOUT_MS),
    );
    const activeTimeoutMs =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : DEFAULT_SEARCH_TIMEOUT_MS;
    const gracePeriodMs = Math.max(
      0,
      Number(options.gracePeriodMs ?? DEFAULT_SEARCH_GRACE_PERIOD_MS),
    );
    const start = Date.now();
    let grace = false;
    let graceUntil = 0;
    let totalFiles = 0;
    let hasSeenFiles = false;
    while (true) {
      const data = await this.getSearch(searchId);
      const flattenedCount = this.flattenSearchResults(data).length;
      const fileCount = Number(data?.fileCount || data?.FileCount || 0);
      totalFiles = Math.max(totalFiles, fileCount, flattenedCount);
      if (totalFiles > 0) {
        hasSeenFiles = true;
      }
      if (earlyExitWhen?.(data)) {
        return await this.hydrateCompletedSearch(searchId, data);
      }
      if (isSearchComplete(data)) {
        return await this.hydrateCompletedSearch(searchId, data);
      }
      if (!isSearchInProgress(data)) {
        return await this.hydrateCompletedSearch(searchId, data);
      }
      const elapsed = Date.now() - start;
      if (!hasSeenFiles && elapsed >= emptyTimeoutMs) {
        return await this.hydrateCompletedSearch(searchId, data);
      }
      if (hasSeenFiles && elapsed > activeTimeoutMs && !grace) {
        grace = true;
        graceUntil = Date.now() + gracePeriodMs;
      } else if (hasSeenFiles && grace && Date.now() > graceUntil) {
        return await this.hydrateCompletedSearch(searchId, data);
      }
      const progress = Math.min(1, totalFiles / DEFAULT_FILE_LIMIT);
      let waitMs = (grace ? 1 : calculateQuadraticDelay(progress)) * 1000;
      if (!hasSeenFiles) {
        const remainingEmptyMs = emptyTimeoutMs - elapsed;
        if (remainingEmptyMs <= 0) {
          return await this.hydrateCompletedSearch(searchId, data);
        }
        waitMs = Math.min(waitMs, remainingEmptyMs);
      } else if (!grace) {
        const remainingActiveMs = activeTimeoutMs - elapsed;
        if (remainingActiveMs > 0) {
          waitMs = Math.min(waitMs, remainingActiveMs);
        }
      } else {
        const remainingGraceMs = graceUntil - Date.now();
        if (remainingGraceMs > 0) {
          waitMs = Math.min(waitMs, remainingGraceMs);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
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
    const results = [];
    const seen = new Set();
    for (const response of readSearchResponses(searchData)) {
      const user = String(
        readProperty(response, "username", "Username") || "",
      ).trim();
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
          const normalized = normalizeSearchFile(
            file,
            user,
            response,
            fileList.locked,
          );
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
    const created = await this.createSearch(searchText, options);
    const completed = await this.waitForSearch(
      created.id,
      Number(options.timeoutMs || DEFAULT_SEARCH_TIMEOUT_MS),
    );
    await this.settleSearch(created.id);
    return this.flattenSearchResults(completed);
  }

  async enqueueBatch({ username, files, options = {} }) {
    return withHonkerLock("slskd-api", async () => {
      const client = buildClient();
      const normalizedUsername = String(username || "").trim();
      const body = {
        id: options.batchId || randomUUID(),
        searchId: options.searchId || null,
        username: normalizedUsername,
        files: (Array.isArray(files) ? files : []).map((file) => ({
          filename: String(file.filename || file.file || "").trim(),
          size: Number(file.size || 0),
        })),
        options: {
          externalId: options.externalId || null,
        },
      };
      let retryCount = 0;
      let delaySeconds = 30;
      while (retryCount <= 3) {
        const response = await client.post(
          "/api/v0/transfers/downloads/batches",
          body,
        );
        if (shouldFallbackToLegacyDownloadEndpoint(response)) {
          const legacyResponse = await client.post(
            `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}`,
            body.files,
          );
          if (![200, 201, 207].includes(legacyResponse.status)) {
            throw new Error(
              `slskd legacy enqueue failed: HTTP ${legacyResponse.status} ${String(
                legacyResponse.data || "",
              )}`,
            );
          }
          const enqueued = readLegacyEnqueued(legacyResponse.data);
          const failures = readBatchFailures(legacyResponse.data);
          if (body.files.length > 0 && enqueued.length === 0) {
            throw new Error(
              `slskd legacy enqueue failed: ${summarizeBatchFailures(failures)}`,
            );
          }
          const firstTransfer = enqueued[0] || null;
          return {
            batchId: null,
            legacy: true,
            transferId: readId(firstTransfer) || null,
            username: normalizedUsername,
            transfers: enqueued,
            response: legacyResponse.data,
          };
        }
        if ([200, 201, 207].includes(response.status)) {
          const failures = readBatchFailures(response.data);
          const transfers = readBatchTransfers(response.data);
          if (
            body.files.length > 0 &&
            failures.length >= body.files.length &&
            transfers.length === 0
          ) {
            throw new Error(
              `slskd batch enqueue failed: ${summarizeBatchFailures(failures)}`,
            );
          }
          const batch = readProperty(response.data, "batch", "Batch") || {};
          return {
            batchId: readId(batch) || body.id,
            legacy: false,
            transferId: readId(transfers[0]) || null,
            username: normalizedUsername,
            transfers,
            response: response.data,
          };
        }
        if (response.status === 429 && retryCount < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, delaySeconds * 1000),
          );
          retryCount += 1;
          delaySeconds *= 2;
          continue;
        }
        throw new Error(`slskd batch enqueue failed: HTTP ${response.status}`);
      }
      throw new Error("slskd batch enqueue busy after retries");
    });
  }

  async getBatch(batchId) {
    const client = buildClient();
    const response = await client.get(
      `/api/v0/transfers/downloads/batches/${batchId}`,
    );
    if (response.status !== 200) {
      return null;
    }
    return response.data;
  }

  async getTransfer(username, id) {
    const client = buildClient();
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
    const client = buildClient();
    const response = await client.delete(
      `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(normalizedId)}`,
      {
        params: remove ? { remove: true } : undefined,
      },
    );
    return [200, 202, 204, 404].includes(response.status);
  }

  async listDownloads() {
    const client = buildClient();
    const response = await client.get("/api/v0/transfers/downloads");
    if (response.status !== 200) return [];
    return Array.isArray(response.data) ? response.data : [];
  }

  async getEvents(offset = 0, limit = 50) {
    const client = buildClient();
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
    const client = buildClient();
    const response = await client.get("/api/v0/searches");
    if (response.status !== 200) return [];
    return normalizeArrayPayload(response.data);
  }

  async deleteSearch(searchId) {
    const id = String(searchId || "").trim();
    if (!id) return false;
    const client = buildClient();
    const response = await client.delete(
      `/api/v0/searches/${encodeURIComponent(id)}`,
    );
    return [200, 204, 404].includes(response.status);
  }

  async removeCompletedDownloads() {
    const client = buildClient();
    const response = await client.delete(
      "/api/v0/transfers/downloads/all/completed",
    );
    return [200, 204, 404].includes(response.status);
  }

  async cleanupAfterRun(options = {}) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "not configured" };
    }
    return withHonkerLock("slskd-api", async () => {
      let searchesRemoved = 0;
      let transfersRemoved = 0;
      const ownedOnly = options.ownedOnly !== false;
      const explicitSearchIds = Array.isArray(options.searchIds)
        ? options.searchIds
        : [];
      const explicitTransfers = Array.isArray(options.transfers)
        ? options.transfers
        : [];
      let searchIds = explicitSearchIds
        .map((entry) => String(entry || "").trim())
        .filter(Boolean);
      let transfers = explicitTransfers;
      let markCleaned = null;

      if (ownedOnly && searchIds.length === 0 && transfers.length === 0) {
        try {
          const {
            getSlskdCleanupTargets,
            markSlskdCleanupTargetsCleaned,
          } = await import("./slskdTransferHistory.js");
          const targets = getSlskdCleanupTargets();
          searchIds = targets.searchIds;
          transfers = targets.transfers;
          markCleaned = markSlskdCleanupTargetsCleaned;
        } catch (error) {
          logger.slskd("warn", "Failed to read scoped slskd cleanup targets", {
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
        }
      }

      for (const transfer of transfers) {
        const username = String(transfer?.username || "").trim();
        const transferId = String(
          transfer?.transferId || transfer?.id || "",
        ).trim();
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
      logger.slskd("info", "Cleaned up slskd after run", {
        ownedOnly,
        searchesRemoved,
        transfersRemoved,
        downloadsRemoved,
      });
      return { searchesRemoved, transfersRemoved, downloadsRemoved };
    });
  }
}

export const slskdClient = new SlskdClient();
