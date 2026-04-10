import { randomBytes } from "crypto";
import { dbOps } from "../config/db-helpers.js";
import path from "path";
import fs from "fs/promises";
import { PassThrough } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const slskStack = require("slsk-client/lib/stack");
const SOULSEEK_USERNAME_ADJECTIVES = [
  "amber",
  "atlas",
  "brisk",
  "cedar",
  "cinder",
  "coast",
  "drift",
  "ember",
  "fable",
  "harbor",
  "juniper",
  "lilac",
  "maple",
  "meadow",
  "mellow",
  "nova",
  "pebble",
  "ripple",
  "sable",
  "solace",
  "spruce",
  "velvet",
];
const SOULSEEK_USERNAME_NOUNS = [
  "bird",
  "brook",
  "cloud",
  "field",
  "grove",
  "leaf",
  "light",
  "moon",
  "pine",
  "reef",
  "ridge",
  "river",
  "shadow",
  "shore",
  "song",
  "spark",
  "stone",
  "trail",
  "wave",
  "wind",
];

const pickRandom = (items) =>
  items[Math.floor((randomBytes(2).readUInt16BE(0) / 65536) * items.length)];

const generateSoulseekUsername = () => {
  const adjective = pickRandom(SOULSEEK_USERNAME_ADJECTIVES);
  const noun = pickRandom(SOULSEEK_USERNAME_NOUNS);
  const suffix = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, "0");
  return `${adjective}${noun}${suffix}`;
};

const generateSoulseekPassword = () => randomBytes(16).toString("hex");

const resolveSharedDownloadsFolder = () => {
  const basePath = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads";
  const resolvedBase = path.isAbsolute(basePath)
    ? basePath
    : path.resolve(process.cwd(), basePath);
  if (path.basename(resolvedBase) === "aurral-weekly-flow") {
    return resolvedBase;
  }
  return path.join(resolvedBase, "aurral-weekly-flow");
};

const patchSlskDownloadPeerFile = () => {
  if (globalThis.__aurralSlskDownloadPatchApplied) return;
  const downloadPeerFileModulePath =
    require.resolve("slsk-client/lib/peer/download-peer-file.js");
  const net = require("net");
  const fsNode = require("fs");
  const MessageFactory = require("slsk-client/lib/message-factory.js");
  const getFilePathName = (user, file) => {
    const parts = String(file || "").split("\\");
    return `/tmp/slsk/${user}_${parts[parts.length - 1]}`;
  };
  const patchedDownloadPeerFile = (host, port, token, user, noPierce) => {
    const conn = net.createConnection(
      {
        host,
        port,
      },
      () => {
        if (noPierce) {
          conn.write(
            MessageFactory.to.peer
              .peerInit(slskStack.currentLogin, "F", token)
              .getBuff(),
          );
          setTimeout(() => {
            if (conn.destroyed) return;
            conn.write(Buffer.from("00000000" + "00000000", "hex"));
          }, 1000);
        } else {
          conn.write(MessageFactory.to.peer.pierceFw(token).getBuff());
        }
      },
    );

    let receivedHandshake = false;
    let requestToken = noPierce ? token : undefined;
    let tok = null;
    let down = null;
    let filePath = null;
    let writeStream = null;
    let receivedBytes = 0;
    let streamErrored = false;
    let settled = false;
    const clearStackDownloadState = () => {
      if (requestToken != null) {
        delete slskStack.downloadTokens[requestToken];
      }
      if (tok?.user && tok?.file) {
        delete slskStack.download[`${tok.user}_${tok.file}`];
      }
    };
    const closeReadableStream = () => {
      if (down?.stream) {
        down.stream.push(null);
      }
    };
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      clearStackDownloadState();
      closeReadableStream();
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      if (!down || typeof down.cb !== "function") return;
      down.cb(error);
      down.cb = null;
    };
    const ensureWriteStream = () => {
      if (!tok || !down || writeStream || streamErrored) return;
      filePath = down.path || getFilePathName(tok.user, tok.file);
      const dir = path.dirname(filePath);
      fsNode.mkdirSync(dir, { recursive: true });
      writeStream = fsNode.createWriteStream(filePath);
      writeStream.on("error", (error) => {
        streamErrored = true;
        conn.destroy();
        finishWithError(error);
      });
    };

    conn.on("data", (data) => {
      if (!noPierce && !receivedHandshake) {
        requestToken = data.toString("hex", 0, 4);
        conn.write(Buffer.from("00000000" + "00000000", "hex"));
        receivedHandshake = true;
        return;
      }
      if (!tok) {
        tok = slskStack.downloadTokens[requestToken];
        down = tok ? slskStack.download[tok.user + "_" + tok.file] : null;
      }
      if (!tok || !down) return;

      if (down.stream) {
        down.stream.push(data);
      }
      ensureWriteStream();
      if (!streamErrored && writeStream) {
        const canContinue = writeStream.write(data);
        if (!canContinue) {
          conn.pause();
          writeStream.once("drain", () => {
            if (!conn.destroyed) conn.resume();
          });
        }
      }
      receivedBytes += data.length;
      if (receivedBytes >= Number(tok.size || 0)) {
        conn.end();
      }
    });

    conn.on("close", () => {
      if (settled) return;
      if (!tok || !down) return;
      closeReadableStream();
      if (streamErrored) return;
      const expectedBytes = Number(tok.size || 0);
      if (expectedBytes > 0 && receivedBytes < expectedBytes) {
        finishWithError(
          new Error(
            `Incomplete download (${receivedBytes}/${expectedBytes} bytes)`,
          ),
        );
        return;
      }
      const onComplete = () => {
        if (settled) return;
        settled = true;
        clearStackDownloadState();
        down.path =
          filePath || down.path || getFilePathName(tok.user, tok.file);
        down.bytesReceived = receivedBytes;
        if (typeof down.cb === "function") {
          down.cb(null, down);
          down.cb = null;
        }
      };
      if (writeStream) {
        writeStream.end(onComplete);
      } else {
        onComplete();
      }
    });

    conn.on("error", (error) => {
      if (!conn.destroyed) conn.destroy();
      finishWithError(error);
    });
  };

  require.cache[downloadPeerFileModulePath] = {
    id: downloadPeerFileModulePath,
    filename: downloadPeerFileModulePath,
    loaded: true,
    exports: patchedDownloadPeerFile,
  };
  globalThis.__aurralSlskDownloadPatchApplied = true;
};

patchSlskDownloadPeerFile();
const slsk = require("slsk-client");

export class SimpleSoulseekClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.connectPromise = null;
    this.config = null;
    this.connectionRefCount = 0;
    this.idleDisconnectTimer = null;
    this.searchCache = new Map();
    this.searchCacheTTLMs = 5 * 60 * 1000;
    this.searchCacheMaxEntries = 200;
    this.noResultsCache = new Map();
    this.noResultsCacheTTLMs = 30 * 60 * 1000;
    this.userFailures = new Map();
    this.userBlacklistThreshold = 3;
    this.userBlacklistTTLMs = 30 * 60 * 1000;
    this.userQueueEvents = new Map();
    this.userQueuePenaltyTTLMs = 20 * 60 * 1000;
    this.metrics = {
      connectCalls: 0,
      connectSuccesses: 0,
      disconnectCalls: 0,
      downloadStarts: 0,
      downloadSuccesses: 0,
      downloadFailures: 0,
      lastConnectAt: null,
      lastDisconnectAt: null,
    };
    this.updateConfig();
  }

  ensureCredentials() {
    const settings = dbOps.getSettings();
    const dbConfig = settings.integrations?.soulseek || {};
    const envUsername = process.env.SOULSEEK_USERNAME || "";
    const envPassword = process.env.SOULSEEK_PASSWORD || "";
    const hasEnv = !!(envUsername || envPassword);
    let username = envUsername || dbConfig.username || "";
    let password = envPassword || dbConfig.password || "";
    const looksAuto =
      typeof dbConfig.username === "string" &&
      dbConfig.username.startsWith("aurral_");
    let autoGenerated =
      !hasEnv && (dbConfig.autoGenerated === true || looksAuto);

    if (!username || !password) {
      username = username || generateSoulseekUsername();
      password = password || generateSoulseekPassword();
      autoGenerated = true;
      const current = dbOps.getSettings();
      const integrations = {
        ...(current.integrations || {}),
        soulseek: { username, password, autoGenerated: true },
      };
      dbOps.updateSettings({ ...current, integrations });
    }

    return { username, password, autoGenerated };
  }

  getConnectionSettings() {
    const settings = dbOps.getSettings();
    const seedDownloads = settings?.weeklyFlowWorker?.seedDownloads !== false;
    return {
      seedDownloads,
      sharedFolders: seedDownloads ? [resolveSharedDownloadsFolder()] : [],
    };
  }

  updateConfig() {
    const { username, password, autoGenerated } = this.ensureCredentials();
    const { seedDownloads, sharedFolders } = this.getConnectionSettings();
    this.config = {
      username,
      password,
      autoGenerated,
      seedDownloads,
      sharedFolders,
    };
  }

  isConfigured() {
    this.updateConfig();
    return !!(this.config.username && this.config.password);
  }

  async connect(retryInvalidPass = true) {
    if (this.connected && this.client) {
      return true;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.metrics.connectCalls += 1;

    if (!this.isConfigured()) {
      throw new Error("Soulseek credentials not configured");
    }
    for (const sharedFolder of this.config.sharedFolders || []) {
      await fs.mkdir(sharedFolder, { recursive: true });
    }

    this.connectPromise = new Promise((resolve, reject) => {
      slsk.connect(
        {
          user: this.config.username,
          pass: this.config.password,
          sharedFolders: this.config.sharedFolders || [],
        },
        async (err, client) => {
          if (err) {
            this.connected = false;
            this.client = null;
            if (
              retryInvalidPass &&
              this.config?.autoGenerated &&
              this.isInvalidPass(err)
            ) {
              try {
                await this.regenerateCredentials();
                this.connectPromise = null;
                const ok = await this.connect(false);
                resolve(ok);
                return;
              } catch {
                reject(err);
                return;
              }
            }
            reject(err);
            return;
          }
          this.client = client;
          this.connected = true;
          this.metrics.connectSuccesses += 1;
          this.metrics.lastConnectAt = Date.now();
          resolve(true);
        },
      );
    });
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  isInvalidPass(error) {
    const message = error?.message || "";
    return String(message).includes("INVALIDPASS");
  }

  async regenerateCredentials() {
    const username = generateSoulseekUsername();
    const password = generateSoulseekPassword();
    const current = dbOps.getSettings();
    const integrations = {
      ...(current.integrations || {}),
      soulseek: { username, password, autoGenerated: true },
    };
    dbOps.updateSettings({ ...current, integrations });
    const { seedDownloads, sharedFolders } = this.getConnectionSettings();
    this.config = {
      username,
      password,
      autoGenerated: true,
      seedDownloads,
      sharedFolders,
    };
    return { username, password };
  }

  async disconnect() {
    if (this.idleDisconnectTimer) {
      clearTimeout(this.idleDisconnectTimer);
      this.idleDisconnectTimer = null;
    }
    this.connectionRefCount = 0;
    this.connectPromise = null;
    this.searchCache.clear();
    this.noResultsCache.clear();
    this.metrics.disconnectCalls += 1;
    this.metrics.lastDisconnectAt = Date.now();
    if (this.client && this.connected) {
      try {
        this.client.destroy();
      } catch (err) {}
      try {
        slsk.disconnect();
      } catch (err) {}
      this.client = null;
      this.connected = false;
    }
    try {
      const { default: stack } = await import("slsk-client/lib/stack.js");
      stack.search = {};
      stack.download = {};
      stack.downloadTokens = {};
      stack.peerSearchMatches = {};
      stack.peerSearchRequests = [];
      stack.login = undefined;
      stack.currentLogin = undefined;
    } catch (err) {}
  }

  isConnected() {
    return this.connected && this.client !== null;
  }

  _getSearchTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_SEARCH_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 1000) return raw;
    return 10000;
  }

  _getDownloadTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_DOWNLOAD_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 15000) return raw;
    return 120000;
  }

  _getDownloadStartupTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_DOWNLOAD_START_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 3000) return raw;
    return 12000;
  }

  _getDownloadStallTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_DOWNLOAD_STALL_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 5000) return raw;
    return 15000;
  }

  _getMatchScanLimit() {
    const raw = Number(process.env.SOULSEEK_MATCH_SCAN_LIMIT);
    if (Number.isFinite(raw) && raw >= 20) {
      return Math.min(Math.floor(raw), 1000);
    }
    return 40;
  }

  _getConnectionKeepAliveMs() {
    const raw = Number(process.env.SOULSEEK_CONNECTION_KEEPALIVE_MS);
    if (Number.isFinite(raw) && raw >= 5000) return Math.floor(raw);
    return 30000;
  }

  _getQueuedTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_QUEUED_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 3000) return Math.floor(raw);
    return 8000;
  }

  _getQueuedFirstTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_QUEUED_TIMEOUT_FIRST_MS);
    if (Number.isFinite(raw) && raw >= 2500) return Math.floor(raw);
    return Math.min(this._getQueuedTimeoutMs(), 5000);
  }

  _getQueuedRetryTimeoutMs() {
    const raw = Number(process.env.SOULSEEK_QUEUED_TIMEOUT_RETRY_MS);
    if (Number.isFinite(raw) && raw >= 2500) return Math.floor(raw);
    return Math.max(2500, this._getQueuedFirstTimeoutMs() - 1000);
  }

  _getQueuedTimeoutForAttempt(attemptIndex) {
    const index = Number.isFinite(Number(attemptIndex))
      ? Math.max(0, Math.floor(Number(attemptIndex)))
      : 0;
    if (index <= 0) return this._getQueuedFirstTimeoutMs();
    return this._getQueuedRetryTimeoutMs();
  }

  _getCachedSearch(query) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return null;
    const entry = this.searchCache.get(key);
    if (!entry) return null;
    if (Date.now() - Number(entry.timestamp || 0) > this.searchCacheTTLMs) {
      this.searchCache.delete(key);
      return null;
    }
    return Array.isArray(entry.results) ? entry.results : null;
  }

  _setCachedSearch(query, results) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    if (this.searchCache.size >= this.searchCacheMaxEntries) {
      const oldest = this.searchCache.keys().next().value;
      if (typeof oldest === "string") {
        this.searchCache.delete(oldest);
      }
    }
    this.searchCache.set(key, {
      results: Array.isArray(results) ? results : [],
      timestamp: Date.now(),
    });
  }

  _setCachedNoResults(query) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    this.noResultsCache.set(key, Date.now());
  }

  _hasCachedNoResults(query) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return false;
    const ts = Number(this.noResultsCache.get(key) || 0);
    if (!ts) return false;
    if (Date.now() - ts > this.noResultsCacheTTLMs) {
      this.noResultsCache.delete(key);
      return false;
    }
    return true;
  }

  _clearCachedNoResults(query) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    this.noResultsCache.delete(key);
  }

  _deleteCachedSearch(query) {
    const key = String(query || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    this.searchCache.delete(key);
  }

  _isUserBlacklisted(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return false;
    const entry = this.userFailures.get(key);
    if (!entry) return false;
    if (Date.now() - Number(entry.lastFailure || 0) > this.userBlacklistTTLMs) {
      this.userFailures.delete(key);
      return false;
    }
    return Number(entry.count || 0) >= this.userBlacklistThreshold;
  }

  _recordUserFailure(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    const entry = this.userFailures.get(key) || { count: 0, lastFailure: 0 };
    entry.count = Number(entry.count || 0) + 1;
    entry.lastFailure = Date.now();
    this.userFailures.set(key, entry);
  }

  _resetUserFailure(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    this.userFailures.delete(key);
  }

  _recordUserQueued(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    const now = Date.now();
    const entry = this.userQueueEvents.get(key) || {
      count: 0,
      lastQueuedAt: 0,
    };
    if (now - Number(entry.lastQueuedAt || 0) > this.userQueuePenaltyTTLMs) {
      entry.count = 0;
    }
    entry.count = Number(entry.count || 0) + 1;
    entry.lastQueuedAt = now;
    this.userQueueEvents.set(key, entry);
  }

  _resetUserQueued(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return;
    this.userQueueEvents.delete(key);
  }

  _getUserQueuePenalty(user) {
    const key = String(user || "")
      .trim()
      .toLowerCase();
    if (!key) return 0;
    const entry = this.userQueueEvents.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (now - Number(entry.lastQueuedAt || 0) > this.userQueuePenaltyTTLMs) {
      this.userQueueEvents.delete(key);
      return 0;
    }
    const basePenalty = Math.min(5, Number(entry.count || 0)) * 40;
    const recentBoost =
      now - Number(entry.lastQueuedAt || 0) < 5 * 60 * 1000 ? 80 : 0;
    return basePenalty + recentBoost;
  }

  _isUserOfflineError(message) {
    const text = String(message || "").toLowerCase();
    return text.includes("user not exist") || text.includes("user offline");
  }

  _isQueuedError(message) {
    return String(message || "")
      .toLowerCase()
      .includes("download queued");
  }

  _disconnectOnTransferFailure() {
    if (this.connectionRefCount > 1) {
      return;
    }
    this.disconnect().catch(() => {});
  }

  async acquireConnection() {
    if (this.idleDisconnectTimer) {
      clearTimeout(this.idleDisconnectTimer);
      this.idleDisconnectTimer = null;
    }
    this.connectionRefCount += 1;
    try {
      await this.connect();
    } catch (error) {
      this.connectionRefCount = Math.max(0, this.connectionRefCount - 1);
      throw error;
    }
  }

  releaseConnection() {
    this.connectionRefCount = Math.max(0, this.connectionRefCount - 1);
    if (this.connectionRefCount !== 0) {
      return;
    }
    if (this.idleDisconnectTimer) {
      clearTimeout(this.idleDisconnectTimer);
      this.idleDisconnectTimer = null;
    }
    this.idleDisconnectTimer = setTimeout(() => {
      this.idleDisconnectTimer = null;
      this.disconnect().catch(() => {});
    }, this._getConnectionKeepAliveMs());
  }

  async search(artistName, trackName, options = {}) {
    const query = `${artistName} ${trackName}`;
    const forceFresh = options?.forceFresh === true;
    if (!forceFresh) {
      if (this._hasCachedNoResults(query)) {
        return [];
      }
      const cached = this._getCachedSearch(query);
      if (cached) {
        return cached;
      }
    } else {
      this._deleteCachedSearch(query);
      this._clearCachedNoResults(query);
    }
    await this.acquireConnection();
    try {
      const results = await new Promise((resolve, reject) => {
        this.client.search(
          {
            req: query,
            timeout: this._getSearchTimeoutMs(),
          },
          (err, results) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(results || []);
          },
        );
      });
      if (Array.isArray(results) && results.length === 0) {
        this._setCachedNoResults(query);
      } else {
        this._clearCachedNoResults(query);
      }
      this._setCachedSearch(query, results);
      return results;
    } finally {
      this.releaseConnection();
    }
  }

  pickBestMatch(results, trackName) {
    const matches = this.pickBestMatches(results, trackName, 1);
    return matches[0] || null;
  }

  pickBestMatches(results, trackName, limit = 5) {
    if (!Array.isArray(results) || results.length === 0) {
      return [];
    }
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 5;
    const scanLimit = this._getMatchScanLimit();
    const notBlacklisted = results.filter(
      (item) => !this._isUserBlacklisted(item?.user),
    );
    const candidates = notBlacklisted.length > 0 ? notBlacklisted : results;
    const source =
      candidates.length > scanLimit
        ? candidates.slice(0, scanLimit)
        : candidates;
    const trackNameLower = String(trackName || "")
      .toLowerCase()
      .trim();
    const qualityOrder = { ".flac": 0, ".mp3": 1, ".m4a": 2, ".ogg": 3 };
    const score = (item) => {
      const file = String(item?.file || "").toLowerCase();
      const ext = path.extname(file).toLowerCase();
      const quality = qualityOrder[ext] ?? 99;
      const hasTrack = trackNameLower ? file.includes(trackNameLower) : false;
      const freeSlots = Number(item?.slots || 0);
      const speed = Number(item?.speed || 0);
      const fileSize = Number(item?.size || 0);
      const sizePenalty =
        fileSize > 0 ? Math.max(0, 500000 - fileSize) : 500000;
      const slotScore = freeSlots > 0 ? 0 : 1000;
      const speedScore =
        speed > 0 ? Math.floor(100 - Math.min(speed / 10000, 100)) : 50;
      const queuePenalty = this._getUserQueuePenalty(item?.user);
      return {
        hasTrack: hasTrack ? 0 : 1,
        slotScore,
        quality,
        queuePenalty,
        speedScore,
        sizePenalty,
      };
    };
    const compareScore = (sa, sb) => {
      if (sa.hasTrack !== sb.hasTrack) return sa.hasTrack - sb.hasTrack;
      if (sa.slotScore !== sb.slotScore) return sa.slotScore - sb.slotScore;
      if (sa.queuePenalty !== sb.queuePenalty)
        return sa.queuePenalty - sb.queuePenalty;
      if (sa.quality !== sb.quality) return sa.quality - sb.quality;
      if (sa.speedScore !== sb.speedScore) return sa.speedScore - sb.speedScore;
      if (sa.sizePenalty !== sb.sizePenalty)
        return sa.sizePenalty - sb.sizePenalty;
      return 0;
    };
    const top = [];
    const topScores = [];
    for (const item of source) {
      const itemScore = score(item);
      let insertAt = top.length;
      for (let i = 0; i < top.length; i += 1) {
        if (compareScore(itemScore, topScores[i]) < 0) {
          insertAt = i;
          break;
        }
      }
      if (insertAt >= max && top.length >= max) continue;
      top.splice(insertAt, 0, item);
      topScores.splice(insertAt, 0, itemScore);
      if (top.length > max) {
        top.pop();
        topScores.pop();
      }
    }
    return top;
  }

  async downloadWithFallbacks(
    results,
    trackName,
    destinationPath,
    onProgress = null,
    maxAttempts = 3,
  ) {
    const attempts = Number.isFinite(Number(maxAttempts))
      ? Math.max(1, Math.floor(Number(maxAttempts)))
      : 3;
    const candidates = this.pickBestMatches(results, trackName, attempts);
    if (candidates.length === 0) {
      throw new Error("No candidate files returned");
    }
    const absPath = path.resolve(destinationPath);
    let lastError = null;
    for (
      let attemptIndex = 0;
      attemptIndex < candidates.length;
      attemptIndex += 1
    ) {
      const candidate = candidates[attemptIndex];
      await fs.rm(absPath, { force: true }).catch(() => {});
      try {
        return await this.download(candidate, absPath, onProgress, {
          queuedTimeoutMs: this._getQueuedTimeoutForAttempt(attemptIndex),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error || "");
        if (this._isUserOfflineError(message)) {
          this._recordUserFailure(candidate?.user);
        }
        lastError = error;
      }
    }
    throw (
      lastError ||
      new Error(`All ${candidates.length} download attempts failed`)
    );
  }

  async downloadBatch(tracks, concurrency = 3, onTrackComplete = null) {
    const source = Array.isArray(tracks) ? tracks : [];
    if (source.length === 0) {
      return { successes: [], failures: [] };
    }
    const maxConcurrency = Number.isFinite(Number(concurrency))
      ? Math.max(1, Math.floor(Number(concurrency)))
      : 3;
    const successes = [];
    const failures = [];
    let active = 0;
    const queue = [];
    const acquire = () =>
      new Promise((resolve) => {
        if (active < maxConcurrency) {
          active += 1;
          resolve();
          return;
        }
        queue.push(resolve);
      });
    const release = () => {
      active = Math.max(0, active - 1);
      if (queue.length === 0) return;
      active += 1;
      const next = queue.shift();
      if (next) next();
    };

    await Promise.all(
      source.map(async (track, index) => {
        await acquire();
        try {
          const results = await this.search(track.artistName, track.trackName);
          const filePath = await this.downloadWithFallbacks(
            results,
            track.trackName,
            track.destPath,
          );
          successes.push(filePath);
          if (typeof onTrackComplete === "function") {
            onTrackComplete(index, true);
          }
        } catch (error) {
          const normalizedError =
            error instanceof Error ? error : new Error(String(error));
          failures.push({ track, error: normalizedError });
          if (typeof onTrackComplete === "function") {
            onTrackComplete(index, false);
          }
        } finally {
          release();
        }
      }),
    );

    return { successes, failures };
  }

  async download(result, destinationPath, onProgress = null, options = {}) {
    this.metrics.downloadStarts += 1;
    await this.acquireConnection();

    const absPath = path.resolve(destinationPath);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });

    const DOWNLOAD_TIMEOUT_MS = this._getDownloadTimeoutMs();
    const DOWNLOAD_STARTUP_TIMEOUT_MS = this._getDownloadStartupTimeoutMs();
    const DOWNLOAD_STALL_TIMEOUT_MS = this._getDownloadStallTimeoutMs();
    const QUEUED_TIMEOUT_MS = Number.isFinite(Number(options?.queuedTimeoutMs))
      ? Math.max(2500, Math.floor(Number(options.queuedTimeoutMs)))
      : this._getQueuedTimeoutMs();
    const expectedBytes = Number(result?.size || 0);
    const progressEnabled =
      typeof onProgress === "function" && expectedBytes > 0;
    const streamMonitorEnabled = expectedBytes > 0;

    try {
      const filePath = await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;
        let startupTimeoutId = null;
        let stallTimeoutId = null;
        let queuedTimeoutId = null;
        let lastProgress = -1;
        let downloadedBytes = 0;
        let lastProgressEmitAt = 0;
        const progressStream = streamMonitorEnabled ? new PassThrough() : null;
        let onData = null;
        let cleanedUp = false;
        let sawFirstByte = false;
        const emitProgress = (value) => {
          if (!progressEnabled) return;
          const next = Math.max(
            0,
            Math.min(100, Math.floor(Number(value) || 0)),
          );
          if (next <= lastProgress) return;
          lastProgress = next;
          onProgress(next);
        };
        if (progressStream) {
          const armStallTimer = () => {
            if (stallTimeoutId) clearTimeout(stallTimeoutId);
            stallTimeoutId = setTimeout(() => {
              if (settled) return;
              this._disconnectOnTransferFailure();
              settle(reject)(new Error("Download stalled (no progress)"));
            }, DOWNLOAD_STALL_TIMEOUT_MS);
          };
          onData = (chunk) => {
            const size = Buffer.isBuffer(chunk)
              ? chunk.length
              : Number(chunk?.length || 0);
            if (!Number.isFinite(size) || size <= 0) return;
            if (!sawFirstByte) {
              sawFirstByte = true;
              if (startupTimeoutId) {
                clearTimeout(startupTimeoutId);
                startupTimeoutId = null;
              }
              if (queuedTimeoutId) {
                clearTimeout(queuedTimeoutId);
                queuedTimeoutId = null;
              }
            }
            armStallTimer();
            downloadedBytes += size;
            const now = Date.now();
            const pct = Math.floor((downloadedBytes / expectedBytes) * 100);
            const bounded = Math.max(0, Math.min(99, pct));
            if (bounded > lastProgress && now - lastProgressEmitAt >= 750) {
              lastProgressEmitAt = now;
              emitProgress(bounded);
            }
          };
          progressStream.on("data", onData);
        }

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (progressStream && onData) {
            progressStream.off("data", onData);
          }
          if (progressStream) {
            progressStream.destroy();
          }
        };

        const settle = (fn) => (val) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          if (startupTimeoutId) clearTimeout(startupTimeoutId);
          if (stallTimeoutId) clearTimeout(stallTimeoutId);
          if (queuedTimeoutId) clearTimeout(queuedTimeoutId);
          cleanup();
          fn(val);
        };

        timeoutId = setTimeout(async () => {
          if (settled) return;
          this._disconnectOnTransferFailure();
          settle(reject)(new Error("Download timeout"));
        }, DOWNLOAD_TIMEOUT_MS);
        if (progressStream) {
          startupTimeoutId = setTimeout(() => {
            if (settled) return;
            this._disconnectOnTransferFailure();
            settle(reject)(new Error("Download stalled (no bytes received)"));
          }, DOWNLOAD_STARTUP_TIMEOUT_MS);
          queuedTimeoutId = setTimeout(() => {
            if (settled || sawFirstByte) return;
            this._disconnectOnTransferFailure();
            settle(reject)(
              new Error("Download queued (skipping to next source)"),
            );
          }, QUEUED_TIMEOUT_MS);
        }

        this.client.download(
          { file: result, path: absPath },
          (err, down) => {
            if (err) {
              settle(reject)(err);
              return;
            }
            const bytesReceived = Number(down?.bytesReceived || 0);
            if (
              expectedBytes > 0 &&
              bytesReceived > 0 &&
              bytesReceived < expectedBytes
            ) {
              settle(reject)(
                new Error(
                  `Incomplete download (${bytesReceived}/${expectedBytes} bytes)`,
                ),
              );
              return;
            }
            emitProgress(100);
            const resolvedPath =
              typeof down?.path === "string" && down.path.trim()
                ? path.resolve(down.path)
                : absPath;
            settle(resolve)(resolvedPath);
          },
          progressStream || undefined,
        );
      });
      const stat = await fs.stat(filePath).catch(() => null);
      const actualBytes = Number(stat?.size || 0);
      if (actualBytes <= 0) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        throw new Error("Downloaded file is empty");
      }
      this._resetUserFailure(result?.user);
      this._resetUserQueued(result?.user);
      this.metrics.downloadSuccesses += 1;
      return filePath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "");
      if (this._isQueuedError(message)) {
        this._recordUserQueued(result?.user);
      } else if (!this._isUserOfflineError(message)) {
        this._recordUserFailure(result?.user);
      }
      this.metrics.downloadFailures += 1;
      throw err;
    } finally {
      this.releaseConnection();
    }
  }

  getStatus() {
    return {
      connected: this.isConnected(),
      connectionRefCount: this.connectionRefCount,
      keepAliveArmed: this.idleDisconnectTimer !== null,
      metrics: {
        connectCalls: this.metrics.connectCalls,
        connectSuccesses: this.metrics.connectSuccesses,
        disconnectCalls: this.metrics.disconnectCalls,
        downloadStarts: this.metrics.downloadStarts,
        downloadSuccesses: this.metrics.downloadSuccesses,
        downloadFailures: this.metrics.downloadFailures,
        lastConnectAt: this.metrics.lastConnectAt,
        lastDisconnectAt: this.metrics.lastDisconnectAt,
      },
    };
  }
}

export const soulseekClient = new SimpleSoulseekClient();
