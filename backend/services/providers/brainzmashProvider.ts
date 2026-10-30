import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import axios from "../../../lib/axiosFetch.ts";
import { asAppError } from "../../../lib/errors.ts";
import createCache from "../apiClients/simpleCache.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { APP_NAME, APP_VERSION, DEFAULT_METADATA_BASE_URL } from "../../config/constants.ts";
import {
  getNormalizedText,
  rankAlbumCandidates,
  runningOrder,
  scoreTextMatch,
  withPressingDurations,
} from "./brainzmashRanking.ts";
import {
  toNormalizedAlbum,
  toNormalizedArtist,
  toNormalizedArtistAlbum,
  type toNormalizedArtistImage,
  type NormalizedAlbum,
  type NormalizedArtist,
  type NormalizedRelease,
} from "./brainzmashMappers.ts";
import { selectBestAlbumImage } from "../imageService.ts";
import { coreAlbumTitle, withoutFeaturedArtists } from "../trackMatching/titleText.ts";
import createRateLimiter from "../apiClients/rateLimiter.ts";
import { musicbrainzGet, releaseGroupSchema } from "../apiClients/musicbrainzHttp.ts";
import { readMany } from "../integrationData.ts";
import { runSharedInflight } from "../sharedInflight.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireMetadataRequest,
  clearMetadataRequestStates,
  completeMetadataRequest,
  deferMetadataRequest,
  failMetadataRequest,
  getMetadataProviderBudget,
  getMetadataRequestState,
  releaseMetadataRequest,
  reserveMetadataProviderRequest,
  setMetadataProviderCooldown,
} from "../metadataProviderBudget.ts";

type ArtistResponse = NonNullable<Parameters<typeof toNormalizedArtist>[0]>;
type ArtistAlbumResponse = NonNullable<Parameters<typeof toNormalizedArtistAlbum>[0]>;
type AlbumResponse = NonNullable<Parameters<typeof toNormalizedAlbum>[0]>;
type ImageResponse = NonNullable<Parameters<typeof toNormalizedArtistImage>[0]>;
type ArtistDetailResponse = ArtistResponse & { Albums?: ArtistAlbumResponse[] };
type ArtistDetailAlbum = Omit<ReturnType<typeof toNormalizedArtistAlbum>, "rating"> & {
  rating: NormalizedAlbum["rating"];
};

type SearchImage = ImageResponse & {
  Url?: string | null;
  url?: string | null;
  CoverType?: string | null;
  kind?: string | null;
};

interface AlbumSearchEntry {
  id?: string;
  title?: string;
  artistid?: string;
  artists?: ArtistResponse[];
  type?: string;
  secondarytypes?: string[];
  releasedate?: string;
  images?: SearchImage[];
}

const releaseGroupSearchSchema = v.looseObject({ "release-groups": v.array(v.unknown()) });

const releaseGroupHitSchema = v.looseObject({
  ...releaseGroupSchema.entries,
  score: v.optional(v.number()),
});

interface AlbumSearchItem {
  id?: string;
  title: string;
  artistName: string;
  artistId: string | null;
  type: string;
  secondaryTypes: string[];
  releaseDate: string | null;
  coverUrl: string | null;
  images: ImageResponse[];
  inLibrary: boolean;
  score: number;
  releaseStatuses: string[];
}

interface MetadataRequestOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

type MetadataParams = Record<string, string | number>;

interface MetadataError extends Error {
  code?: string;
  retryAfterMs?: number;
  response?: { status?: number; headers?: Record<string, string> };
}

const METADATA_ENTITY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const METADATA_ENTITY_STALE_TTL_SECONDS = 30 * 24 * 60 * 60;
const METADATA_SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_NOT_FOUND_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS = 5_000;
const METADATA_FORBIDDEN_COOLDOWN_MS = 5 * 60_000;
const METADATA_RATE_LIMIT_MAX_COOLDOWN_MS = 15 * 60_000;
const METADATA_CACHE_MAX_ENTRIES = 20_000;
const METADATA_HOT_CACHE_TTL_SECONDS = 60;
const METADATA_HOT_CACHE_MAX_ENTRIES = 50;
const METADATA_STORE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_ALBUM_SEARCH_WINDOW = 25;
const METADATA_REQUEST_MIN_INTERVAL_MS = 100;
const METADATA_REQUEST_TIMEOUT_MS = 8000;
const METADATA_REQUEST_LEASE_MS = 2 * 60_000;
const METADATA_REQUEST_LEASE_POLL_MS = 250;
const METADATA_MAX_QUEUED_REQUESTS =
  Math.floor(METADATA_REQUEST_TIMEOUT_MS / METADATA_REQUEST_MIN_INTERVAL_MS) - 1;
const metadataHotCache = createCache(
  METADATA_HOT_CACHE_TTL_SECONDS,
  METADATA_HOT_CACHE_MAX_ENTRIES,
);
let nextMetadataStoreCleanupAt = 0;
const metadataNotFoundCache = createCache(
  METADATA_NOT_FOUND_CACHE_TTL_SECONDS,
  METADATA_CACHE_MAX_ENTRIES,
);
const providerInflightRequests = new Map();
const providerRequestLimiter = createRateLimiter(METADATA_REQUEST_MIN_INTERVAL_MS, {
  maxQueue: METADATA_MAX_QUEUED_REQUESTS,
});
const METADATA_MAX_RETRIES = 1;

export function clearMetadataProviderCaches() {
  metadataHotCache.flushAll();
  dbOps.clearMetadataResponses();
  metadataNotFoundCache.flushAll();
  providerInflightRequests.clear();
  clearMetadataRequestStates();
}

const healthState: {
  configuredProvider: string;
  activeBaseUrl: string | null;
  failoverActive: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string;
} = {
  configuredProvider: "brainzmash",
  activeBaseUrl: null,
  failoverActive: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: "",
};

function nowIso() {
  return new Date().toISOString();
}

function getSettingsMetadata() {
  const settings = dbOps.getSettings();
  return settings.integrations?.metadata || {};
}

function isNarrowFallbacksEnabled() {
  const metadata = getSettingsMetadata();
  return metadata.enableNarrowFallbacks !== false;
}

export function getMetadataBaseUrl() {
  const metadata = getSettingsMetadata();
  const raw = String(
    metadata.baseUrl || process.env.BRAINZMASH_BASE_URL || DEFAULT_METADATA_BASE_URL,
  ).trim();
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_METADATA_BASE_URL;
  }
}

function getUserAgent() {
  return `${APP_NAME}/${APP_VERSION}`;
}

function isEntityMetadataPath(path: string) {
  return /^\/(?:album|artist)\/[^/]+$/.test(path);
}

export function isMetadataNotFoundError(error: unknown) {
  const failure = asAppError(error);
  return failure?.code === "ERR_METADATA_NOT_FOUND" || failure?.response?.status === 404;
}

function createMetadataNotFoundError() {
  const error: MetadataError = new Error("Metadata resource not found");
  error.code = "ERR_METADATA_NOT_FOUND";
  error.response = { status: 404 };
  return error;
}

function createMetadataCircuitError(code: string, status: number, remainingMs: number) {
  const error: MetadataError = new Error(
    code === "ERR_METADATA_FORBIDDEN"
      ? "Metadata provider access is temporarily blocked"
      : "Metadata provider rate limit cooldown is active",
  );
  error.code = code;
  error.retryAfterMs = Math.max(0, Math.ceil(remainingMs));
  error.response = { status };
  return error;
}

function createMetadataCooldownError(remainingMs: number) {
  const error: MetadataError = new Error(
    "Metadata resource is cooling down after a failed request",
  );
  error.code = "ERR_METADATA_COOLDOWN";
  error.retryAfterMs = Math.max(0, Math.ceil(remainingMs));
  return error;
}

function isMetadataCircuitError(error: unknown) {
  const failure = asAppError(error);
  return (
    failure?.code === "ERR_METADATA_FORBIDDEN" ||
    failure?.code === "ERR_METADATA_RATE_LIMITED" ||
    failure?.code === "ERR_METADATA_COOLDOWN"
  );
}

function getRetryAfterMs(error: unknown) {
  const headers = asAppError(error)?.response?.headers;
  const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS, seconds * 1000);
  }
  const retryAt = Date.parse(String(retryAfter || ""));
  if (Number.isFinite(retryAt)) {
    return Math.max(METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS, retryAt - Date.now());
  }
  return METADATA_RATE_LIMIT_FALLBACK_COOLDOWN_MS;
}

function getMetadataCircuitError(baseUrl: string) {
  const now = Date.now();
  const budget = getMetadataProviderBudget(baseUrl);
  const forbiddenUntil = budget.forbidden_until ?? 0;
  const rateLimitedUntil = budget.rate_limited_until ?? 0;
  if (forbiddenUntil > now) {
    return createMetadataCircuitError("ERR_METADATA_FORBIDDEN", 403, forbiddenUntil - now);
  }
  if (rateLimitedUntil > now) {
    return createMetadataCircuitError("ERR_METADATA_RATE_LIMITED", 429, rateLimitedUntil - now);
  }
  return null;
}

function openMetadataCircuit(baseUrl: string, status: number, error: unknown) {
  const cooldownMs =
    status === 403
      ? METADATA_FORBIDDEN_COOLDOWN_MS
      : Math.min(getRetryAfterMs(error), METADATA_RATE_LIMIT_MAX_COOLDOWN_MS);
  setMetadataProviderCooldown(baseUrl, status, Date.now() + cooldownMs);
}

const RETRYABLE_ERROR_CODES: (string | undefined)[] = [
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
];
const RETRYABLE_STATUSES: (number | undefined)[] = [408, 425, 429, 500, 502, 503, 504];

function isRetryable(error: unknown) {
  const failure = asAppError(error);
  return (
    (typeof failure?.code === "string" && RETRYABLE_ERROR_CODES.includes(failure.code)) ||
    RETRYABLE_STATUSES.includes(failure?.response?.status)
  );
}

function getMetadataCachePolicy(path: string) {
  if (isEntityMetadataPath(path)) {
    return {
      freshTtlSeconds: METADATA_ENTITY_CACHE_TTL_SECONDS,
      staleTtlSeconds: METADATA_ENTITY_STALE_TTL_SECONDS,
    };
  }
  return {
    freshTtlSeconds: METADATA_SEARCH_CACHE_TTL_SECONDS,
    staleTtlSeconds: 0,
  };
}

async function readCachedMetadata(cacheKey: string, { persistent = false } = {}) {
  let entry = persistent ? null : metadataHotCache.get(cacheKey);
  if (!entry) {
    const persisted = await dbOps.getMetadataResponseAsync(cacheKey);
    const current = persistent ? null : metadataHotCache.get(cacheKey);
    if (!persisted) {
      if (!current) return null;
      entry = current;
    } else {
      entry = current || persisted;
      if (!current) metadataHotCache.set(cacheKey, persisted);
    }
  }
  const now = Date.now();
  if (entry.staleUntil < now) return null;
  return { value: entry.value, stale: entry.freshUntil < now };
}

async function storeMetadata(
  cacheKey: string,
  value: unknown,
  { freshTtlSeconds, staleTtlSeconds }: ReturnType<typeof getMetadataCachePolicy>,
) {
  const now = Date.now();
  const freshUntil = now + freshTtlSeconds * 1000;
  const entry = { value, freshUntil, staleUntil: freshUntil + staleTtlSeconds * 1000 };
  metadataHotCache.set(cacheKey, entry);
  try {
    await dbOps.setMetadataResponseAsync(cacheKey, entry);
    if (now >= nextMetadataStoreCleanupAt) {
      nextMetadataStoreCleanupAt = now + METADATA_STORE_CLEANUP_INTERVAL_MS;
      dbOps.cleanMetadataResponses(METADATA_CACHE_MAX_ENTRIES);
    }
  } catch (error) {
    logger.warn("metadata", "Could not store metadata response", {
      reason: safeLogDiagnostic(error),
    });
  }
}

async function waitForMetadataRequestOwner(cacheKey: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const state = getMetadataRequestState(cacheKey);
    const now = Date.now();
    if (state?.retryAfter && state.retryAfter > now) {
      throw createMetadataCooldownError(state.retryAfter - now);
    }
    if (!state?.leased || state.leaseUntil <= now) {
      const cached = await readCachedMetadata(cacheKey, { persistent: true });
      return cached ? ({ found: true, value: cached.value } as const) : ({ found: false } as const);
    }
    await delay(Math.min(METADATA_REQUEST_LEASE_POLL_MS, state.leaseUntil - now), undefined, {
      signal,
    });
  }
}

function forgetMetadata(cacheKey: string) {
  metadataHotCache.delete(cacheKey);
  dbOps.deleteMetadataResponse(cacheKey);
}

function refreshMetadata<T>(
  cacheKey: string,
  path: string,
  params: MetadataParams,
  { signal, fallbackValue }: MetadataRequestOptions & { fallbackValue?: T } = {},
): Promise<T> {
  const baseUrl = getMetadataBaseUrl();
  const cachePolicy = getMetadataCachePolicy(path);
  const circuitError = getMetadataCircuitError(baseUrl);
  if (circuitError) {
    return fallbackValue !== undefined
      ? Promise.resolve(fallbackValue)
      : Promise.reject(circuitError);
  }
  healthState.activeBaseUrl = baseUrl;
  healthState.lastCheckedAt = nowIso();

  return runSharedInflight(
    providerInflightRequests,
    cacheKey,
    async (sharedSignal: AbortSignal) => {
      const ownsPersistentRequest = isEntityMetadataPath(path);
      let leaseToken: string | null = null;
      if (ownsPersistentRequest) {
        while (!leaseToken) {
          const claim = acquireMetadataRequest(cacheKey, METADATA_REQUEST_LEASE_MS);
          if (claim.acquired) {
            leaseToken = claim.token;
            break;
          }
          if (claim.retryAfter > Date.now()) {
            if (fallbackValue !== undefined) return fallbackValue;
            throw createMetadataCooldownError(claim.retryAfter - Date.now());
          }
          const shared = await waitForMetadataRequestOwner(cacheKey, sharedSignal).catch(
            (error) => {
              if (
                fallbackValue !== undefined &&
                asAppError(error)?.code === "ERR_METADATA_COOLDOWN"
              ) {
                return { found: true as const, value: fallbackValue };
              }
              throw error;
            },
          );
          if (shared.found) return shared.value;
        }
      }
      const maxRetries = ownsPersistentRequest ? 0 : METADATA_MAX_RETRIES;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let providerRequestStarted = false;
        if (sharedSignal.aborted) {
          if (leaseToken) releaseMetadataRequest(cacheKey, leaseToken);
          throw sharedSignal.reason || new Error("The operation was aborted");
        }
        try {
          const response = await providerRequestLimiter.schedule(
            async (remainingMs) => {
              const activeCircuitError = getMetadataCircuitError(baseUrl);
              if (activeCircuitError) throw activeCircuitError;
              const admissionStarted = Date.now();
              let waitMs;
              while (
                (waitMs = reserveMetadataProviderRequest(
                  baseUrl,
                  METADATA_REQUEST_MIN_INTERVAL_MS,
                )) > 0
              ) {
                if (waitMs >= remainingMs - (Date.now() - admissionStarted)) {
                  const error: MetadataError = new Error(
                    "Metadata provider request deadline exceeded",
                  );
                  error.code = "ETIMEDOUT";
                  throw error;
                }
                await delay(waitMs, undefined, { signal: sharedSignal });
                const waitingCircuit = getMetadataCircuitError(baseUrl);
                if (waitingCircuit) throw waitingCircuit;
              }
              const circuitAfterWait = getMetadataCircuitError(baseUrl);
              if (circuitAfterWait) throw circuitAfterWait;
              const requestTimeoutMs = remainingMs - (Date.now() - admissionStarted);
              if (requestTimeoutMs <= 0) {
                const error: MetadataError = new Error(
                  "Metadata provider request deadline exceeded",
                );
                error.code = "ETIMEDOUT";
                throw error;
              }
              providerRequestStarted = true;
              return axios.get(`${baseUrl}${path}`, {
                params,
                timeout: Number.isFinite(requestTimeoutMs)
                  ? Math.max(1, Math.floor(requestTimeoutMs))
                  : METADATA_REQUEST_TIMEOUT_MS,
                headers: {
                  "User-Agent": getUserAgent(),
                },
                signal: sharedSignal,
              });
            },
            { signal: sharedSignal, timeoutMs: METADATA_REQUEST_TIMEOUT_MS },
          );
          await storeMetadata(cacheKey, response.data, cachePolicy);
          if (leaseToken) completeMetadataRequest(cacheKey, leaseToken);
          metadataNotFoundCache.delete(cacheKey);
          healthState.lastSuccessAt = healthState.lastCheckedAt;
          healthState.lastFailureReason = "";
          return response.data;
        } catch (error) {
          if (sharedSignal.aborted) {
            if (leaseToken) releaseMetadataRequest(cacheKey, leaseToken);
            throw sharedSignal.reason || error;
          }
          const failure = asAppError(error);
          const status = failure?.response?.status;
          healthState.lastFailureAt = healthState.lastCheckedAt;
          healthState.lastFailureReason =
            status != null
              ? `HTTP ${status}`
              : String(failure?.code || failure?.message || "Unknown error");
          // BrainzMash answers 429 when the same album is asked for again within
          // a week, so only that entity waits out the Retry-After.
          if (status === 429 && leaseToken && !isMetadataCircuitError(error)) {
            const retryAt = Date.now() + getRetryAfterMs(error);
            deferMetadataRequest(cacheKey, leaseToken, retryAt);
            if (fallbackValue !== undefined) return fallbackValue;
            throw createMetadataCooldownError(retryAt - Date.now());
          }
          if (status === 403 || status === 429) {
            if (!isMetadataCircuitError(error)) {
              openMetadataCircuit(baseUrl, status, error);
            }
            if (leaseToken) completeMetadataRequest(cacheKey, leaseToken);
            if (fallbackValue !== undefined) return fallbackValue;
            throw error;
          }
          if (status === 404 && isEntityMetadataPath(path)) {
            forgetMetadata(cacheKey);
            metadataNotFoundCache.set(cacheKey, true);
            if (leaseToken) completeMetadataRequest(cacheKey, leaseToken);
          }
          if (attempt === maxRetries || !isRetryable(error)) {
            if (leaseToken && isRetryable(error) && providerRequestStarted) {
              failMetadataRequest(cacheKey, leaseToken);
            } else if (leaseToken && providerRequestStarted) {
              completeMetadataRequest(cacheKey, leaseToken);
            } else if (leaseToken) releaseMetadataRequest(cacheKey, leaseToken);
            if (fallbackValue !== undefined && isRetryable(error)) return fallbackValue;
            throw error;
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(sharedSignal.reason || new Error("The operation was aborted"));
            };
            const timer = setTimeout(() => {
              sharedSignal.removeEventListener("abort", onAbort);
              resolve();
            }, 250);
            if (sharedSignal.aborted) onAbort();
            else sharedSignal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      throw new Error("Metadata provider request failed");
    },
    { signal },
  );
}

async function request<T>(
  path: string,
  params: MetadataParams = {},
  { signal, forceRefresh = false }: MetadataRequestOptions = {},
): Promise<T> {
  const baseUrl = getMetadataBaseUrl();
  const cacheKey = `${baseUrl}${path}:${JSON.stringify(params)}`;
  if (!forceRefresh && metadataNotFoundCache.get(cacheKey)) {
    throw createMetadataNotFoundError();
  }
  const cached = await readCachedMetadata(cacheKey);
  if (cached && !forceRefresh) {
    if (cached.stale) {
      void refreshMetadata<T>(cacheKey, path, params, { fallbackValue: cached.value as T }).catch(
        () => {},
      );
    }
    return cached.value as T;
  }
  return refreshMetadata<T>(cacheKey, path, params, {
    signal,
    ...(cached ? { fallbackValue: cached.value as T } : {}),
  });
}

function applyReleaseTypeFilter<T extends { type: string; secondaryTypes?: string[] }>(
  albums: T[],
  releaseTypes: string[] | string = [],
): T[] {
  const normalizedSet = new Set(
    (Array.isArray(releaseTypes)
      ? releaseTypes
      : String(releaseTypes || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
    ).map((value) => String(value)),
  );
  if (normalizedSet.size === 0) return albums;
  return albums.filter((album) => {
    if (normalizedSet.has(album.type)) return true;
    return (album.secondaryTypes || []).some((entry) => normalizedSet.has(entry));
  });
}

function tally<T, K>(releases: T[], key: (release: T) => K) {
  const counts = new Map<K, number>();
  for (const release of releases) counts.set(key(release), (counts.get(key(release)) || 0) + 1);
  return counts;
}

// The album is the official tracklist most of its releases share: pressings
// of the standard edition far outnumber deluxe editions and box sets, which
// can run to 90 tracks, and misprints that swap tracks. A tie goes to the
// longer tracklist, and among its releases a single disc, numbered like CD
// and digital copies, comes first. The expanded edition is the longest one
// that keeps every standard track and is at most twice as long, which leaves
// out box sets.
export function selectAlbumRelease(
  album: { releases?: NormalizedRelease[] } | null | undefined,
  { edition = "standard" }: { edition?: string | null } = {},
) {
  const releases = Array.isArray(album?.releases) ? album.releases : [];
  const withTracks = releases.filter(
    (release) => Array.isArray(release?.tracks) && release.tracks.length > 0,
  );
  const official = withTracks.filter(
    (release) => String(release?.status || "").toLowerCase() === "official",
  );
  const pool = official.length > 0 ? official : withTracks;
  if (pool.length === 0) return releases[0] || null;
  const [trackCount] = [...tally(pool, (release) => release.tracks.length)].sort(
    ([leftCount, left], [rightCount, right]) => right - left || rightCount - leftCount,
  )[0];
  const standard = chooseTracklist(pool, trackCount);
  if (edition !== "expanded") return standard;
  const keepsStandardTracks = (release: NormalizedRelease) => {
    const unmatched = [...release.tracks];
    return standard.tracks.every((track) => {
      const index = unmatched.findIndex((candidate) =>
        track.recordingId && candidate.recordingId
          ? candidate.recordingId === track.recordingId
          : getNormalizedText(candidate.title) === getNormalizedText(track.title),
      );
      if (index === -1) return false;
      unmatched.splice(index, 1);
      return true;
    });
  };
  const longer = pool.filter(
    (release) =>
      release.tracks.length > trackCount &&
      release.tracks.length <= trackCount * 2 &&
      keepsStandardTracks(release),
  );
  if (longer.length === 0) return standard;
  return chooseTracklist(longer, Math.max(...longer.map((release) => release.tracks.length)));
}

function chooseTracklist(pool: NormalizedRelease[], trackCount: number) {
  const sameCount = pool.filter((release) => release.tracks.length === trackCount);
  const orders = new Map(sameCount.map((release) => [release, runningOrder(release)] as const));
  const orderCounts = tally(sameCount, (release) => orders.get(release));
  const discs = (release: NormalizedRelease) =>
    new Set(release.tracks.map((track) => track.mediumNumber || 1)).size;
  const chosen = sameCount.reduce((best, release) => {
    const commoner = orderCounts.get(orders.get(release))! - orderCounts.get(orders.get(best))!;
    return commoner > 0 || (commoner === 0 && discs(release) < discs(best)) ? release : best;
  });
  return withPressingDurations(sameCount, chosen);
}

export async function getArtistByMbid(mbid: string, { signal }: MetadataRequestOptions = {}) {
  const data = await request<ArtistResponse>(`/artist/${mbid}`, {}, { signal });
  return toNormalizedArtist(data);
}

export async function getAlbumByMbid(
  albumMbid: string,
  { signal, forceRefresh = false }: MetadataRequestOptions = {},
) {
  const data = await request<AlbumResponse>(`/album/${albumMbid}`, {}, { signal, forceRefresh });
  return toNormalizedAlbum(data);
}

export async function getAlbumTracksByAlbumMbid(
  albumMbid: string,
  {
    chooseRelease = selectAlbumRelease,
  }: { chooseRelease?: (album: NormalizedAlbum) => NormalizedRelease | null | undefined } = {},
) {
  const album = await getAlbumByMbid(albumMbid);
  const release = chooseRelease(album);
  return Array.isArray(release?.tracks)
    ? release.tracks.map((track) => ({ ...track, releaseMbid: release.id || null }))
    : [];
}

export async function searchArtists(
  query: string,
  {
    limit = 24,
    offset = 0,
    signal,
    throwOnFailure = false,
  }: { limit?: number; offset?: number; signal?: AbortSignal; throwOnFailure?: boolean } = {},
) {
  let items: NormalizedArtist[] = [];
  try {
    const data = await request<ArtistResponse[]>(
      "/search/artist",
      {
        query,
        limit,
      },
      { signal },
    );
    const source = Array.isArray(data) ? data : [];
    items = source.map((entry) => ({
      ...toNormalizedArtist(entry),
    }));
  } catch (error) {
    signal?.throwIfAborted();
    if (throwOnFailure) throw error;
  }
  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function searchAlbums(
  query: string,
  {
    artistName = "",
    limit = 24,
    offset = 0,
    releaseTypes = [],
    sort = "relevance",
    signal,
    throwOnFailure = false,
  }: {
    artistName?: string;
    limit?: number;
    offset?: number;
    releaseTypes?: string[] | string;
    sort?: string;
    signal?: AbortSignal;
    throwOnFailure?: boolean;
  } = {},
) {
  // Relevance ranking reorders what the provider returns, so a short list
  // still looks at enough results to find the album. One more than the page
  // shows whether another page exists.
  const requestedLimit = Math.max(limit + offset + 1, MIN_ALBUM_SEARCH_WINDOW);
  let items: AlbumSearchItem[] = [];
  let failure: unknown = null;

  try {
    const data = await request<AlbumSearchEntry[]>(
      "/search/album",
      {
        query,
        limit: requestedLimit,
        ...(artistName ? { artist: artistName } : {}),
      },
      { signal },
    );
    const source = Array.isArray(data) ? data : [];
    items = source.map((entry, index) => {
      const artists = Array.isArray(entry?.artists) ? entry.artists : [];
      const credited =
        artists.find((artist) => artist?.id && artist.id === entry?.artistid) || artists[0];
      const primaryArtist = credited ? toNormalizedArtist(credited) : null;
      const coverImage = selectBestAlbumImage(entry?.images);
      return {
        id: entry?.id,
        title: entry?.title || "Untitled Release",
        artistName: primaryArtist?.name || artistName || "Unknown Artist",
        artistId: entry?.artistid || primaryArtist?.id || null,
        type: entry?.type || "Album",
        secondaryTypes: Array.isArray(entry?.secondarytypes) ? entry.secondarytypes : [],
        releaseDate: entry?.releasedate || null,
        coverUrl: coverImage?.Url ? String(coverImage.Url).trim() : null,
        images: Array.isArray(entry?.images) ? entry.images : [],
        inLibrary: false,
        score: Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  } catch (error) {
    signal?.throwIfAborted();
    failure = error;
  }

  if (items.length === 0 && isNarrowFallbacksEnabled()) {
    failure = null;
    const escapeLucenePhrase = (value: string) =>
      String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    const mbQuery = artistName
      ? `artist:"${escapeLucenePhrase(artistName)}" AND releasegroup:"${escapeLucenePhrase(query)}"`
      : String(query || "").trim();
    const data = await musicbrainzGet(
      releaseGroupSearchSchema,
      "/release-group",
      { query: mbQuery, limit: requestedLimit },
      { signal },
    ).catch((error) => {
      signal?.throwIfAborted();
      failure = error;
      return null;
    });
    const hits = data
      ? readMany(releaseGroupHitSchema, data["release-groups"], {
          service: "MusicBrainz",
          endpoint: "/release-group",
        })
      : [];
    items = hits.map((entry, index) => {
      const primaryCredit = entry["artist-credit"]?.[0];
      return {
        id: entry.id,
        title: entry.title || "Untitled Release",
        artistName:
          primaryCredit?.name || primaryCredit?.artist?.name || artistName || "Unknown Artist",
        artistId: primaryCredit?.artist?.id || null,
        type: entry["primary-type"] || "Album",
        secondaryTypes: entry["secondary-types"] ?? [],
        releaseDate: entry["first-release-date"] || null,
        coverUrl: null,
        images: [],
        inLibrary: false,
        score: entry.score || Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  }

  if (failure && throwOnFailure) throw failure;
  items = applyReleaseTypeFilter(items, releaseTypes);

  if (sort === "relevance") {
    items = rankAlbumCandidates(query, items, { artistName });
  } else if (sort === "artistAsc") {
    items.sort(
      (left, right) =>
        String(left.artistName || "").localeCompare(String(right.artistName || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  } else if (sort === "titleAsc") {
    items.sort(
      (left, right) =>
        String(left.title || "").localeCompare(String(right.title || "")) ||
        String(left.artistName || "").localeCompare(String(right.artistName || "")),
    );
  } else if (sort === "dateDesc") {
    items.sort(
      (left, right) =>
        String(right.releaseDate || "").localeCompare(String(left.releaseDate || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  }

  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

type ArtistLike = { id?: string | null; name?: string; aliases?: string[] } | null | undefined;

function artistNameForms(name: unknown) {
  const value = String(name || "")
    .trim()
    .replace(/&/g, " and ");
  const parts = value.split(",").map((part) => part.trim());
  const variants =
    parts.length === 2 && parts.every(Boolean) ? [value, `${parts[1]} ${parts[0]}`] : [value];
  return variants
    .map((variant) => getNormalizedText(variant).replace(/^the /, "") || variant.toLowerCase())
    .filter(Boolean);
}

export const hasArtistName = (name: unknown, artist: ArtistLike) => {
  const forms = new Set(artistNameForms(name));
  return [artist?.name, ...(artist?.aliases || [])].some((candidate) =>
    artistNameForms(candidate).some((form) => forms.has(form)),
  );
};

// An artist is the one a credit names when the credit, or its lead artist as
// in "Koyo feat. DRAIN", is the artist's name or one of its aliases.
export function isCreditedArtist(credit: string | null | undefined, artist: ArtistLike) {
  return hasArtistName(credit, artist) || hasArtistName(withoutFeaturedArtists(credit), artist);
}

// A search the provider could not answer throws, so a caller can tell an
// outage from an album MusicBrainz does not have. A match has the title and
// credits the artist by ID or by name. The search without the artist finds an
// artist written another way, such as in another script, and also other
// artists' albums with the same title. A title that names an edition, such as
// "Nevermind (Remastered)", also matches the album without it. `holds` checks
// a match further, such as that it lists the song being downloaded.
export async function resolveAlbumByArtistAndTitle({
  artistName = "",
  artistMbid = "",
  albumTitle = "",
  releaseYear = null,
  holds = null,
}: {
  artistName?: string;
  artistMbid?: string;
  albumTitle?: string;
  releaseYear?: string | number | null;
  holds?: ((albumId: string) => boolean | Promise<boolean>) | null;
}) {
  const albumOrNone = (mbid: string) =>
    getAlbumByMbid(mbid).catch((error) => {
      if (isMetadataNotFoundError(error)) return null;
      throw error;
    });
  const byArtist = (album: NormalizedAlbum | null) =>
    [{ id: album?.artistId }, ...(album?.artists || [])].some(
      (artist) => (artistMbid && artist.id === artistMbid) || isCreditedArtist(artistName, artist),
    );
  const core = coreAlbumTitle(albumTitle);
  const titled = (title: string) =>
    scoreTextMatch(title, albumTitle) >= 85 || scoreTextMatch(coreAlbumTitle(title), core) >= 85;
  const tried = new Set();
  for (const searchTitle of new Set([albumTitle, core])) {
    for (const searchArtist of new Set([artistName, ""])) {
      const result = await searchAlbums(searchTitle, {
        artistName: searchArtist,
        limit: 10,
        offset: 0,
        throwOnFailure: true,
      });
      const ranked = rankAlbumCandidates(albumTitle, result.items, { artistName, releaseYear });
      for (const candidate of ranked) {
        if (!candidate?.id || tried.has(candidate.id) || !titled(candidate.title)) continue;
        tried.add(candidate.id);
        if ((artistName || artistMbid) && !byArtist(await albumOrNone(candidate.id))) continue;
        if (!holds || (await holds(candidate.id))) return candidate.id;
      }
    }
  }
  return null;
}

export async function listArtistAlbums(
  artistMbid: string,
  {
    releaseTypes = [],
    includeTrackCounts = false,
    hydrateLimit = 30,
    signal,
    forceRefresh = false,
  }: {
    releaseTypes?: string[] | string;
    includeTrackCounts?: boolean;
    hydrateLimit?: number;
    signal?: AbortSignal;
    forceRefresh?: boolean;
  } = {},
) {
  const rawArtist = await request<ArtistDetailResponse>(
    `/artist/${artistMbid}`,
    {},
    { signal, forceRefresh },
  );
  const artist = toNormalizedArtist(rawArtist);
  let albums: ArtistDetailAlbum[] = (Array.isArray(rawArtist?.Albums) ? rawArtist.Albums : []).map(
    (entry) => toNormalizedArtistAlbum(entry),
  );
  albums = applyReleaseTypeFilter(albums, releaseTypes);
  albums.sort((left, right) => {
    const leftBootleg = (left.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    const rightBootleg = (right.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;
    const typeOrder = { Album: 0, EP: 1, Single: 2 };
    const leftType = (isOwnKey(typeOrder, left.type) ? typeOrder[left.type] : undefined) ?? 9;
    const rightType = (isOwnKey(typeOrder, right.type) ? typeOrder[right.type] : undefined) ?? 9;
    if (leftType !== rightType) return leftType - rightType;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });

  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) >= 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : 30;
  await Promise.all(
    albums.slice(0, safeHydrateLimit).map(async (album) => {
      try {
        const needsDate = !album.firstReleaseDate;
        const needsRating = includeTrackCounts;
        if (!needsDate && !needsRating) return;

        const hydrated = await getAlbumByMbid(album.id, { signal });
        if (needsDate) {
          album.firstReleaseDate = hydrated.releaseDate || album.firstReleaseDate;
        }
        if (needsRating) {
          album.rating = hydrated.rating || null;
        }
      } catch {}
    }),
  );

  return albums.map((album) => ({
    ...album,
    artistName: artist.name,
    artistId: artist.id,
  }));
}

export async function getArtistGenres(artistMbid: string) {
  const artist = await getArtistByMbid(artistMbid);
  return artist.genres || [];
}

export async function getArtistNameByMbid(
  artistMbid: string,
  { signal }: MetadataRequestOptions = {},
) {
  const artist = await getArtistByMbid(artistMbid, { signal });
  return artist.name || null;
}

export function getMetadataProviderHealthSnapshot() {
  return {
    brainzmash: {
      configuredProvider: healthState.configuredProvider,
      activeBaseUrl: getMetadataBaseUrl(),
      failoverActive: healthState.failoverActive,
      lastCheckedAt: healthState.lastCheckedAt,
      lastSuccessAt: healthState.lastSuccessAt,
      lastFailureAt: healthState.lastFailureAt,
      lastFailureReason: healthState.lastFailureReason,
    },
  };
}
