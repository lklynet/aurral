import { AsyncLocalStorage } from "node:async_hooks";
import { Innertube } from "youtubei.js";
import createRateLimiter from "../apiClients/rateLimiter.js";
import {
  buildSharedTrackIdentity,
  dedupeSharedTracks,
} from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,150}$/;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const RATE_LIMIT_MAX_MS = 15 * 60_000;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const providerError = (message, { code, statusCode }) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const invalidReference = () => providerError(
  "Enter a valid public YouTube or YouTube Music playlist URL",
  { code: "YOUTUBE_PLAYLIST_INVALID", statusCode: 400 },
);

const rateLimited = () => providerError(
  "YouTube Music is rate limiting playlist requests; try again later",
  { code: "YOUTUBE_PLAYLIST_RATE_LIMITED", statusCode: 429 },
);

const getRateLimitDelayMs = (value, now = Date.now()) => {
  const retryAfter = String(value || "").trim();
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RATE_LIMIT_MAX_MS);
  }
  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - now), RATE_LIMIT_MAX_MS);
  }
  return RATE_LIMIT_FALLBACK_MS;
};

export function validateYoutubePlaylistId(value) {
  const id = String(value || "").trim();
  if (PLAYLIST_ID_PATTERN.test(id)) return id;
  throw invalidReference();
}

export function extractYoutubePlaylistId(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw invalidReference();
  }
  const listValues = url.searchParams.getAll("list");
  if (url.protocol !== "https:" || !YOUTUBE_HOSTS.has(url.hostname) || listValues.length !== 1) {
    throw invalidReference();
  }
  return validateYoutubePlaylistId(listValues[0]);
}

const getText = (value) => {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  const rendered = value?.toString?.();
  return typeof rendered === "string" && rendered !== "[object Object]" ? rendered.trim() : "";
};

const getNamedValue = (value) => getText(value?.name ?? value?.title ?? value);

const getPlaylistName = (playlist) => {
  const candidates = [
    playlist?.header?.title,
    playlist?.metadata?.title,
    playlist?.title,
  ];
  for (const candidate of candidates) {
    const name = getText(candidate);
    if (name) return name;
  }
  return "";
};

const isContinuation = (entry) =>
  entry?.type === "ContinuationItem" || entry?.constructor?.type === "ContinuationItem";

const getContinuationKey = (entry) => {
  const payload = entry?.endpoint?.payload;
  const key = payload?.continuation
    ?? payload?.continuationCommand?.token
    ?? entry?.continuation
    ?? entry?.token;
  if (typeof key === "string" && key) return key;
  if (!payload || typeof payload !== "object") return "";
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
};

const normalizeDuration = (duration) => {
  const seconds = Number(duration?.seconds ?? duration);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
};

const normalizeRows = (rows) => {
  const stats = {
    sourceItems: rows.length,
    unavailable: 0,
    podcast: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const raw = [];
  const positions = [];
  const excluded = [];
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    if (!row) {
      stats.unavailable += 1;
      excluded.push({ position, reason: "unavailable" });
      continue;
    }
    if (["podcast_show", "podcast_episode", "non_music_track"].includes(row.item_type)) {
      stats.podcast += 1;
      excluded.push({ position, reason: "podcast", trackName: getText(row.title) || null });
      continue;
    }
    if (!row.id) {
      stats.unavailable += 1;
      excluded.push({ position, reason: "unavailable" });
      continue;
    }
    if (row.item_type !== "song" && row.item_type !== "video") {
      stats.unavailable += 1;
      excluded.push({ position, reason: "unavailable" });
      continue;
    }
    const trackName = getText(row.title);
    const artistName = getNamedValue(
      row.item_type === "song" ? row.artists?.[0] : row.authors?.[0],
    );
    if (!trackName || !artistName) {
      stats.incomplete += 1;
      excluded.push({ position, reason: "incomplete", trackName: trackName || null });
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: row.item_type === "song" ? getNamedValue(row.album) || null : null,
      durationMs: normalizeDuration(row.duration),
    });
    positions.push(position);
  }
  const tracks = dedupeSharedTracks(raw);
  const seen = new Set();
  for (const [index, track] of raw.entries()) {
    const identity = buildSharedTrackIdentity(track);
    if (seen.has(identity)) {
      stats.duplicate += 1;
      excluded.push({
        position: positions[index],
        reason: "duplicate",
        artistName: track.artistName,
        trackName: track.trackName,
      });
    }
    seen.add(identity);
  }
  excluded.sort((left, right) => left.position - right.position);
  return { tracks, stats, excluded };
};

export class YoutubeMusicPlaylistClient {
  constructor({
    createInnertube = (options) => Innertube.create(options),
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 30_000,
    operationTimeoutMs = 4 * 60_000,
    maxPages = 200,
    maxItems = 10_000,
    playlistCacheTtlMs = 15 * 60_000,
    maxCachedPlaylists = 20,
    playlistRequestIntervalMs = 100,
    maxQueuedPlaylistRequests = 50,
  } = {}) {
    this.createInnertube = createInnertube;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.operationTimeoutMs = operationTimeoutMs;
    this.maxPages = maxPages;
    this.maxItems = maxItems;
    this.playlistCacheTtlMs = Math.max(0, playlistCacheTtlMs);
    this.maxCachedPlaylists = Math.max(1, maxCachedPlaylists);
    this.playlistRequestLimiter = createRateLimiter(playlistRequestIntervalMs, {
      maxQueue: maxQueuedPlaylistRequests,
    });
    this.operationContext = new AsyncLocalStorage();
    this.sessionPromise = null;
    this.playlistCache = new Map();
    this.rateLimitedUntil = 0;
  }

  async fetch(input, init = {}) {
    if (Date.now() < this.rateLimitedUntil) throw rateLimited();
    const signals = [init.signal, this.operationContext.getStore()?.signal].filter(Boolean);
    signals.push(AbortSignal.timeout(this.requestTimeoutMs));
    const response = await this.fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
    if (response?.status === 429) {
      this.rateLimitedUntil = Date.now() + getRateLimitDelayMs(response.headers?.get("retry-after"));
      throw rateLimited();
    }
    return response;
  }

  async getSession() {
    if (!this.sessionPromise) {
      const sessionPromise = this.createInnertube({ fetch: this.fetch.bind(this) })
        .catch((error) => {
          if (this.sessionPromise === sessionPromise) this.sessionPromise = null;
          throw error;
        });
      this.sessionPromise = sessionPromise;
    }
    const signal = this.operationContext.getStore()?.signal;
    if (!signal) return this.sessionPromise;
    const sessionPromise = this.sessionPromise;
    let handleAbort;
    const aborted = new Promise((_, reject) => {
      handleAbort = () => {
        if (this.sessionPromise === sessionPromise) this.sessionPromise = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
    return Promise.race([sessionPromise, aborted]).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  }

  async getPlaylist(value, { forceRefresh = false } = {}) {
    const id = validateYoutubePlaylistId(value);
    const now = Date.now();
    const cached = this.playlistCache.get(id);
    const pending = cached?.expiresAt === Number.POSITIVE_INFINITY;
    if (cached && cached.expiresAt > now && (!forceRefresh || pending)) return cached.promise;
    if (cached) this.playlistCache.delete(id);

    for (const [cachedId, entry] of this.playlistCache) {
      if (entry.expiresAt <= now) this.playlistCache.delete(cachedId);
    }
    while (this.playlistCache.size >= this.maxCachedPlaylists) {
      this.playlistCache.delete(this.playlistCache.keys().next().value);
    }

    const promise = this.loadPlaylist(id);
    const entry = { promise, expiresAt: Number.POSITIVE_INFINITY };
    this.playlistCache.set(id, entry);
    try {
      const playlist = await promise;
      entry.expiresAt = Date.now() + this.playlistCacheTtlMs;
      return playlist;
    } catch (error) {
      if (this.playlistCache.get(id) === entry) this.playlistCache.delete(id);
      throw error;
    }
  }

  async loadPlaylist(id) {
    const operationController = new AbortController();
    const timeout = setTimeout(() => operationController.abort(), this.operationTimeoutMs);
    timeout.unref?.();
    try {
      return await this.operationContext.run(
        { signal: operationController.signal },
        async () => this.getCompletePlaylist(id),
      );
    } catch (error) {
      if (operationController.signal.aborted || error?.name === "TimeoutError") {
        throw providerError("YouTube Music took too long to respond", {
          code: "YOUTUBE_PLAYLIST_TIMEOUT",
          statusCode: 504,
        });
      }
      if (error?.statusCode && error?.code) throw error;
      throw providerError("The YouTube Music playlist could not be loaded", {
        code: "YOUTUBE_PLAYLIST_UNAVAILABLE",
        statusCode: 502,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCompletePlaylist(id) {
    const session = await this.getSession();
    const signal = this.operationContext.getStore()?.signal;
    let page = await this.playlistRequestLimiter.schedule(
      () => session.music.getPlaylist(id),
      { signal },
    );
    const name = getPlaylistName(page);
    if (!name || !Array.isArray(page?.contents)) {
      throw providerError("The YouTube Music playlist is unavailable", {
        code: "YOUTUBE_PLAYLIST_UNAVAILABLE",
        statusCode: 404,
      });
    }

    const rows = [];
    const continuations = new Set();
    let pageCount = 0;
    while (page) {
      pageCount += 1;
      if (pageCount > this.maxPages) {
        throw providerError("The YouTube Music playlist is too large to import", {
          code: "YOUTUBE_PLAYLIST_LIMIT",
          statusCode: 502,
        });
      }
      if (!Array.isArray(page.contents)) {
        throw providerError("YouTube Music returned an incomplete playlist", {
          code: "YOUTUBE_PLAYLIST_INCOMPLETE",
          statusCode: 502,
        });
      }
      const continuation = page.contents.find(isContinuation);
      rows.push(...page.contents.filter((entry) => !isContinuation(entry)));
      if (rows.length > this.maxItems) {
        throw providerError("The YouTube Music playlist is too large to import", {
          code: "YOUTUBE_PLAYLIST_LIMIT",
          statusCode: 502,
        });
      }
      if (!continuation) break;
      const key = getContinuationKey(continuation);
      if (!key || continuations.has(key) || typeof page.getContinuation !== "function") {
        throw providerError("YouTube Music returned an incomplete playlist", {
          code: "YOUTUBE_PLAYLIST_INCOMPLETE",
          statusCode: 502,
        });
      }
      continuations.add(key);
      page = await this.playlistRequestLimiter.schedule(
        () => page.getContinuation(),
        { signal },
      );
    }

    return { id, name, ...normalizeRows(rows) };
  }
}

export const youtubeMusicPlaylistClient = new YoutubeMusicPlaylistClient();
