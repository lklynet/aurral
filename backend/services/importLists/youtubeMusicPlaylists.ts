import { AsyncLocalStorage } from "node:async_hooks";
import { asAppError } from "../../../lib/errors.ts";
import type { Innertube, Types, YTNodes } from "youtubei.js";
import createRateLimiter from "../apiClients/rateLimiter.ts";
import {
  buildPlaylistTrackIdentity,
  dedupePlaylistTracks,
} from "../playlists/flowPlaylistConfig.ts";

const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,150}$/;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const RATE_LIMIT_MAX_MS = 15 * 60_000;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const NON_MUSIC_ITEM_TYPES: (string | undefined)[] = [
  "podcast_show",
  "podcast_episode",
  "non_music_track",
];

type CodedError = Error & { code?: string; statusCode?: number };

interface YoutubeNamedValue {
  name?: unknown;
  title?: unknown;
}

type YoutubeMusicPlaylist = Awaited<ReturnType<Innertube["music"]["getPlaylist"]>>;
type YoutubePlaylistContent = YTNodes.ContinuationItem | YTNodes.MusicResponsiveListItem;

const providerError = (
  message: string,
  { code, statusCode }: { code: string; statusCode: number },
) => {
  const error: CodedError = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const invalidReference = () =>
  providerError("Enter a valid public YouTube or YouTube Music playlist URL", {
    code: "YOUTUBE_PLAYLIST_INVALID",
    statusCode: 400,
  });

const rateLimited = () =>
  providerError("YouTube Music is rate limiting playlist requests; try again later", {
    code: "YOUTUBE_PLAYLIST_RATE_LIMITED",
    statusCode: 429,
  });

const getRateLimitDelayMs = (value: string | null | undefined, now = Date.now()) => {
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

export function validateYoutubePlaylistId(value: unknown) {
  const id = String(value || "").trim();
  if (PLAYLIST_ID_PATTERN.test(id)) return id;
  throw invalidReference();
}

export function extractYoutubePlaylistId(value: unknown) {
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

const getText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  const rendered = value?.toString?.();
  return typeof rendered === "string" && rendered !== "[object Object]" ? rendered.trim() : "";
};

const getNamedValue = (value: YoutubeNamedValue | null | undefined) =>
  getText(value?.name ?? value?.title ?? value);

const readField = (source: unknown, key: string): unknown =>
  (typeof source === "object" && source !== null) || typeof source === "function"
    ? key in source
      ? Reflect.get(source, key)
      : undefined
    : undefined;

const getPlaylistArtworkUrl = (playlist: YoutubeMusicPlaylist) => {
  const header = playlist.header;
  const headers = [header, readField(header, "header"), readField(playlist, "metadata")];
  const thumbnails = headers.flatMap((entry) => {
    const value =
      readField(entry, "thumbnails") ?? readField(readField(entry, "thumbnail"), "contents");
    return Array.isArray(value) ? value : [];
  });
  return (
    thumbnails
      .map((thumbnail) => ({
        url: readField(thumbnail, "url"),
        width: Number(readField(thumbnail, "width")) || 0,
      }))
      .filter(
        (thumbnail): thumbnail is { url: string; width: number } =>
          typeof thumbnail.url === "string" && /^https?:\/\//i.test(thumbnail.url),
      )
      .sort((left, right) => right.width - left.width)[0]?.url || null
  );
};

const getPlaylistName = (playlist: YoutubeMusicPlaylist | undefined) => {
  const candidates = [
    readField(playlist?.header, "title"),
    readField(readField(playlist?.header, "header"), "title"),
    readField(readField(playlist, "metadata"), "title"),
    readField(playlist, "title"),
  ];
  for (const candidate of candidates) {
    const name = getText(candidate);
    if (name) return name;
  }
  return "";
};

const isContinuation = (entry: YoutubePlaylistContent): entry is YTNodes.ContinuationItem =>
  entry?.type === "ContinuationItem" ||
  readField(entry?.constructor, "type") === "ContinuationItem";

const getContinuationKey = (entry: YTNodes.ContinuationItem) => {
  const payload = entry?.endpoint?.payload;
  const key =
    payload?.continuation ??
    payload?.continuationCommand?.token ??
    readField(entry, "continuation") ??
    readField(entry, "token");
  if (typeof key === "string" && key) return key;
  if (!payload || typeof payload !== "object") return "";
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
};

const normalizeDuration = (duration: { seconds?: number } | undefined) => {
  const seconds = Number(duration?.seconds ?? duration);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
};

const normalizeRows = (rows: YTNodes.MusicResponsiveListItem[]) => {
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
    if (NON_MUSIC_ITEM_TYPES.includes(row.item_type)) {
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
  const tracks = dedupePlaylistTracks(raw);
  const seen = new Set();
  for (const [index, track] of raw.entries()) {
    const identity = buildPlaylistTrackIdentity(track);
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

type YoutubePlaylist = Awaited<ReturnType<YoutubeMusicPlaylistClient["getCompletePlaylist"]>>;

export class YoutubeMusicPlaylistClient {
  declare createInnertube: (options: Types.InnerTubeConfig) => Promise<Innertube>;
  declare fetchImpl: typeof fetch;
  declare requestTimeoutMs: number;
  declare operationTimeoutMs: number;
  declare maxPages: number;
  declare maxItems: number;
  declare playlistCacheTtlMs: number;
  declare maxCachedPlaylists: number;
  declare playlistRequestLimiter: ReturnType<typeof createRateLimiter>;
  declare operationContext: AsyncLocalStorage<{ signal?: AbortSignal }>;
  declare sessionPromise: Promise<Innertube> | null;
  declare playlistCache: Map<string, { promise: Promise<YoutubePlaylist>; expiresAt: number }>;
  declare rateLimitedUntil: number;

  constructor({
    createInnertube = async (options: Types.InnerTubeConfig) => {
      const { Innertube } = await import("youtubei.js");
      return Innertube.create(options);
    },
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

  async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    if (Date.now() < this.rateLimitedUntil) throw rateLimited();
    const signals = [init.signal, this.operationContext.getStore()?.signal].filter(
      (signal) => signal != null,
    );
    signals.push(AbortSignal.timeout(this.requestTimeoutMs));
    const response = await this.fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
    if (response?.status === 429) {
      this.rateLimitedUntil = Math.max(
        this.rateLimitedUntil,
        Date.now() + getRateLimitDelayMs(response.headers?.get("retry-after")),
      );
      throw rateLimited();
    }
    return response;
  }

  async getSession() {
    if (!this.sessionPromise) {
      const sessionPromise = this.createInnertube({ fetch: this.fetch.bind(this) }).catch(
        (error) => {
          if (this.sessionPromise === sessionPromise) this.sessionPromise = null;
          throw error;
        },
      );
      this.sessionPromise = sessionPromise;
    }
    const signal = this.operationContext.getStore()?.signal;
    if (!signal) return this.sessionPromise;
    const sessionPromise = this.sessionPromise;
    let handleAbort: () => void;
    const aborted = new Promise<never>((_, reject) => {
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

  trimPlaylistCache(maxSize: number) {
    while (this.playlistCache.size > maxSize) {
      const evictable = [...this.playlistCache].find(
        ([, entry]) => entry.expiresAt !== Number.POSITIVE_INFINITY,
      );
      if (!evictable) break;
      this.playlistCache.delete(evictable[0]);
    }
  }

  async getPlaylist(value: unknown, { forceRefresh = false }: { forceRefresh?: boolean } = {}) {
    const id = validateYoutubePlaylistId(value);
    const now = Date.now();
    const cached = this.playlistCache.get(id);
    if (cached && cached.expiresAt > now && !forceRefresh) return cached.promise;
    if (cached) this.playlistCache.delete(id);

    for (const [cachedId, entry] of this.playlistCache) {
      if (entry.expiresAt <= now) this.playlistCache.delete(cachedId);
    }
    this.trimPlaylistCache(this.maxCachedPlaylists - 1);

    const promise = this.loadPlaylist(id);
    const entry = { promise, expiresAt: Number.POSITIVE_INFINITY };
    this.playlistCache.set(id, entry);
    try {
      const playlist = await promise;
      entry.expiresAt = Date.now() + this.playlistCacheTtlMs;
      this.trimPlaylistCache(this.maxCachedPlaylists);
      return playlist;
    } catch (error) {
      if (this.playlistCache.get(id) === entry) this.playlistCache.delete(id);
      throw error;
    }
  }

  async loadPlaylist(id: string) {
    const operationController = new AbortController();
    const timeout = setTimeout(() => operationController.abort(), this.operationTimeoutMs);
    timeout.unref?.();
    try {
      return await this.operationContext.run({ signal: operationController.signal }, async () =>
        this.getCompletePlaylist(id),
      );
    } catch (error) {
      const failure = asAppError(error);
      if (operationController.signal.aborted || failure?.name === "TimeoutError") {
        throw providerError("YouTube Music took too long to respond", {
          code: "YOUTUBE_PLAYLIST_TIMEOUT",
          statusCode: 504,
        });
      }
      if (failure?.statusCode && failure?.code) throw error;
      throw providerError("The YouTube Music playlist could not be loaded", {
        code: "YOUTUBE_PLAYLIST_UNAVAILABLE",
        statusCode: 502,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCompletePlaylist(id: string) {
    const session = await this.getSession();
    const signal = this.operationContext.getStore()?.signal;
    let page = await this.playlistRequestLimiter.schedule(
      () => this.operationContext.run({ signal }, () => session.music.getPlaylist(id)),
      { signal },
    );
    const name = getPlaylistName(page);
    const artworkUrl = getPlaylistArtworkUrl(page);
    if (!name || !Array.isArray(page?.contents)) {
      throw providerError("The YouTube Music playlist is unavailable", {
        code: "YOUTUBE_PLAYLIST_UNAVAILABLE",
        statusCode: 404,
      });
    }

    const rows: YTNodes.MusicResponsiveListItem[] = [];
    const continuations = new Set<string>();
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
      rows.push(
        ...page.contents.filter(
          (entry): entry is YTNodes.MusicResponsiveListItem => !isContinuation(entry),
        ),
      );
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
        () => this.operationContext.run({ signal }, () => page.getContinuation()),
        { signal },
      );
    }

    return { id, name, artworkUrl, ...normalizeRows(rows) };
  }
}

export const youtubeMusicPlaylistClient = new YoutubeMusicPlaylistClient();
