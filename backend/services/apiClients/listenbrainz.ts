import axios from "../../../lib/axiosFetch.ts";
import createRateLimiter from "./rateLimiter.ts";
import createCache from "./simpleCache.ts";
import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { APP_NAME, APP_VERSION, LISTENBRAINZ_API } from "../../config/constants.ts";

interface ListenbrainzSubmitEvent {
  playedAt: number | string;
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  trackMbid?: string | null;
  albumMbid?: string | null;
  artistMbid?: string | null;
}

interface ListenbrainzErrorDetails {
  path: string;
  status: number | null;
  code: string | number | null;
  message: string;
  error: unknown;
}

const listenbrainzCache = createCache(300);
const listenbrainzLookupCache = createCache(3600, 200);
const LISTENBRAINZ_LOOKUP_FAILURE_TTL_SECONDS = 300;
const LISTENBRAINZ_POPULARITY_BATCH_SIZE = 1000;
const LISTENBRAINZ_METADATA_BATCH_SIZE = 100;

const listenbrainzLimiter = createRateLimiter(350);
const LISTENBRAINZ_USER_AGENT = `${APP_NAME}/${APP_VERSION} ( https://github.com/lklynet/aurral )`;

const LISTENBRAINZ_TIMEOUT_MS = 6000;
const LISTENBRAINZ_MAX_RETRIES = 2;

const LISTENBRAINZ_MAX_RATE_LIMIT_WAIT_SECONDS = 15;

const listenbrainzInflightRequests = new Map();
const listenbrainzErrorLogAt = new Map();

const getRateLimitWaitMs = (error: unknown) => {
  const failure = asAppError(error);
  if (failure?.response?.status !== 429) return null;
  const resetIn = Number(failure.response.headers?.["x-ratelimit-reset-in"]);
  const seconds = Number.isFinite(resetIn) && resetIn >= 0 ? resetIn : 1;
  return Math.min(seconds, LISTENBRAINZ_MAX_RATE_LIMIT_WAIT_SECONDS) * 1000 + 250;
};

const normalizeListenbrainzBaseUrl = (baseUrl: string | null | undefined) => {
  const candidate =
    String(baseUrl || "")
      .trim()
      .replace(/\/+$/, "") || LISTENBRAINZ_API;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host
      ? candidate
      : LISTENBRAINZ_API;
  } catch {
    return LISTENBRAINZ_API;
  }
};

const listenbrainzWrite = async (
  baseUrl: string,
  path: string,
  { token, data }: { token?: string | null; data?: unknown } = {},
) => {
  const response = await listenbrainzLimiter.schedule(() =>
    axios.post(`${String(baseUrl).replace(/\/+$/, "")}${path}`, data, {
      headers: {
        Authorization: `Token ${String(token || "").trim()}`,
        "User-Agent": LISTENBRAINZ_USER_AGENT,
      },
      timeout: LISTENBRAINZ_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    }),
  );
  return response.data;
};

export const listenbrainzValidateToken = async (
  token: string | null | undefined,
  baseUrl: string | null | undefined = LISTENBRAINZ_API,
) => {
  const root = normalizeListenbrainzBaseUrl(baseUrl);
  const response = await listenbrainzLimiter.schedule(() =>
    axios.get(`${root}/1/validate-token`, {
      headers: {
        Authorization: `Token ${String(token || "").trim()}`,
        "User-Agent": LISTENBRAINZ_USER_AGENT,
      },
      timeout: LISTENBRAINZ_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    }),
  );
  return response.data;
};

export const listenbrainzSubmit = async ({
  token,
  baseUrl = LISTENBRAINZ_API,
  event,
}: {
  token?: string | null;
  baseUrl?: string | null;
  event: ListenbrainzSubmitEvent;
}) => {
  const root = normalizeListenbrainzBaseUrl(baseUrl);
  const listenedAt = Math.floor(Number(event?.playedAt) / 1000);
  if (!Number.isFinite(listenedAt) || listenedAt <= 0) {
    throw new Error("listenbrainzSubmit requires a numeric playedAt timestamp");
  }
  const payload = {
    listen_type: "single",
    payload: [
      {
        listened_at: listenedAt,
        track_metadata: {
          artist_name: event.artist,
          track_name: event.title,
          ...(event.album ? { release_name: event.album } : {}),
          additional_info: {
            submission_client: "Aurral",
            duration_ms: event.durationMs || undefined,
            recording_mbid: event.trackMbid || undefined,
            release_group_mbid: event.albumMbid || undefined,
            artist_mbids: event.artistMbid ? [event.artistMbid] : undefined,
          },
        },
      },
    ],
  };
  return listenbrainzWrite(`${root}/1`, "/submit-listens", {
    token,
    data: payload,
  });
};

export async function listenbrainzRequest(
  path: string,
  params = {},
  {
    token = null,
    baseUrl = LISTENBRAINZ_API,
    timeoutMs = LISTENBRAINZ_TIMEOUT_MS,
    data,
  }: { token?: string | null; baseUrl?: string; timeoutMs?: number; data?: unknown } = {},
) {
  const root = normalizeListenbrainzBaseUrl(baseUrl);
  const isAuthenticated = Boolean(String(token || "").trim());
  const cacheKey = isAuthenticated
    ? null
    : `lb:${root}:${path}:${JSON.stringify(params)}${data ? `:${JSON.stringify(data)}` : ""}`;
  if (cacheKey) {
    const cached = listenbrainzCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const inflight = listenbrainzInflightRequests.get(cacheKey);
    if (inflight) return inflight;
  }

  const requestPromise = (async () => {
    const isRetryable = (error: unknown) => {
      const failure = asAppError(error);
      const status = failure?.response?.status;
      const code = failure?.code;
      return (
        code === "ECONNABORTED" ||
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        (status !== undefined && [408, 425, 500, 502, 503, 504].includes(status))
      );
    };
    const getLogKey = (details: ListenbrainzErrorDetails) =>
      `${details.path}:${details.status || "none"}:${details.code || "none"}`;
    const logError = (message: string, details: ListenbrainzErrorDetails) => {
      const key = getLogKey(details);
      const now = Date.now();
      const last = listenbrainzErrorLogAt.get(key) || 0;
      if (now - last < 15000) return;
      listenbrainzErrorLogAt.set(key, now);
      logger.error("api", message, details);
    };

    let lastError: unknown = null;
    for (let retryCount = 0; retryCount <= LISTENBRAINZ_MAX_RETRIES; retryCount++) {
      try {
        const response = await listenbrainzLimiter.schedule(() => {
          const config = {
            params,
            headers: {
              "User-Agent": LISTENBRAINZ_USER_AGENT,
              ...(isAuthenticated ? { Authorization: `Token ${String(token).trim()}` } : {}),
            },
            timeout: timeoutMs,
            validateStatus: (status: number) => (status >= 200 && status < 300) || status === 204,
          };
          return data
            ? axios.post(`${root}${path}`, data, config)
            : axios.get(`${root}${path}`, config);
        });
        const payload = response.status === 204 ? null : response.data;
        if (cacheKey) listenbrainzCache.set(cacheKey, payload);
        return payload;
      } catch (error) {
        lastError = error;
        const rateLimitWaitMs = getRateLimitWaitMs(error);
        if (rateLimitWaitMs !== null) listenbrainzLimiter.pauseFor(rateLimitWaitMs);
        if (retryCount < LISTENBRAINZ_MAX_RETRIES && rateLimitWaitMs !== null) continue;
        if (retryCount < LISTENBRAINZ_MAX_RETRIES && isRetryable(error)) {
          const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }

    const failure = asAppError(lastError);
    const responseData = failure?.response?.data;
    const details = {
      path,
      status: failure?.response?.status || null,
      code: failure?.code || null,
      message: failure?.message || "Unknown ListenBrainz error",
      error:
        (typeof responseData === "object" &&
          responseData !== null &&
          (Reflect.get(responseData, "error") || Reflect.get(responseData, "message"))) ||
        null,
    };
    logError("ListenBrainz API error:", details);
    throw lastError;
  })();

  if (cacheKey) listenbrainzInflightRequests.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    if (cacheKey) listenbrainzInflightRequests.delete(cacheKey);
  }
}

const toBatches = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const toListenCount = (value: number | null | undefined) =>
  Number.isInteger(value) && value! > 0 ? value! : null;

async function cachedListenbrainzLookup<V>(
  cacheKey: string,
  lookup: () => Promise<Map<string, V>>,
): Promise<Map<string, V>> {
  const cached = listenbrainzLookupCache.get(cacheKey);
  if (cached) return cached;
  try {
    const value = await lookup();
    listenbrainzLookupCache.set(cacheKey, value);
    return value;
  } catch {
    const empty = new Map<string, V>();
    listenbrainzLookupCache.set(cacheKey, empty, LISTENBRAINZ_LOOKUP_FAILURE_TTL_SECONDS);
    return empty;
  }
}

export const listenbrainzGetReleaseGroupListens = (releaseGroupMbids: string[]) =>
  cachedListenbrainzLookup(`listens:${releaseGroupMbids.join(",")}`, async () => {
    const batches = await Promise.all(
      toBatches(releaseGroupMbids, LISTENBRAINZ_POPULARITY_BATCH_SIZE).map((mbids) =>
        listenbrainzRequest(
          "/1/popularity/release-group",
          {},
          { data: { release_group_mbids: mbids } },
        ),
      ),
    );
    if (!batches.every(Array.isArray)) throw new TypeError("ListenBrainz popularity is not a list");
    const listens = new Map<string, { listenCount: number; listenerCount: number }>();
    for (const row of batches.flat()) {
      const listenCount = toListenCount(row?.total_listen_count);
      const listenerCount = toListenCount(row?.total_user_count);
      if (listenCount && listenerCount) {
        listens.set(row.release_group_mbid, { listenCount, listenerCount });
      }
    }
    return listens;
  });

const isReleaseGroupMetadata = (batch: unknown) =>
  Boolean(batch) && typeof batch === "object" && !Array.isArray(batch) && !("error" in batch!);

export const listenbrainzGetReleaseGroupDates = (releaseGroupMbids: string[]) =>
  cachedListenbrainzLookup(`dates:${releaseGroupMbids.join(",")}`, async () => {
    const batches = await Promise.all(
      toBatches(releaseGroupMbids, LISTENBRAINZ_METADATA_BATCH_SIZE).map((mbids) =>
        listenbrainzRequest("/1/metadata/release_group/", { release_group_mbids: mbids.join(",") }),
      ),
    );
    if (!batches.every(isReleaseGroupMetadata)) {
      throw new TypeError("ListenBrainz release group metadata is not keyed by MBID");
    }
    const dates = new Map<string, string>();
    for (const [mbid, metadata] of batches.flatMap(Object.entries)) {
      const date = metadata?.release_group?.date;
      if (typeof date === "string" && date) dates.set(mbid, date);
    }
    return dates;
  });

export { listenbrainzCache, listenbrainzLookupCache };
