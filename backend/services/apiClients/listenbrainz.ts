import * as v from "valibot";
import {
  http,
  isTransientNetworkError,
  waitBeforeRetry,
  type HttpOptions,
} from "../../../lib/http.ts";
import { lenient, lenientCount, lenientText, readOne } from "../integrationData.ts";
import createRateLimiter from "./rateLimiter.ts";
import { createOutagePause } from "./outagePause.ts";
import createCache from "./simpleCache.ts";
import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";
import { MBID_PATTERN } from "../../../lib/mbid.ts";
import { APP_NAME, APP_VERSION, LISTENBRAINZ_API } from "../../config/constants.ts";

export type ListenbrainzSubmitEvent = {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  trackMbid?: string | null;
  albumMbid?: string | null;
  releaseMbid?: string | null;
  artistMbids?: (string | null)[];
  artistNames?: string[];
} & ({ listenType?: "single"; playedAt: number | string } | { listenType: "playing_now" });

interface ListenbrainzErrorDetails {
  path: string;
  status: number | null;
  code: string | number | null;
  message: string;
  error: unknown;
}

const listenbrainzCache = createCache(300);

const listenbrainzLimiter = createRateLimiter(350, { shared: LISTENBRAINZ_API });
const LISTENBRAINZ_USER_AGENT = `${APP_NAME}/${APP_VERSION} ( https://github.com/lklynet/aurral )`;

const LISTENBRAINZ_TIMEOUT_MS = 6000;
const LISTENBRAINZ_SUBMIT_TIMEOUT_MS = 30_000;
const LISTENBRAINZ_MAX_RETRIES = 2;

const LISTENBRAINZ_MAX_RATE_LIMIT_WAIT_SECONDS = 15;

const listenbrainzInflightRequests = new Map<string, Promise<unknown>>();
const listenbrainzErrorLogAt = new Map<string, number>();
const listenbrainzPauses = new Map<string, ReturnType<typeof createOutagePause>>();

const listenbrainzPause = (root: string) => {
  const host = new URL(root).host;
  const pause = listenbrainzPauses.get(host) ?? createOutagePause(host);
  listenbrainzPauses.set(host, pause);
  return pause;
};

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
    http.post(`${String(baseUrl).replace(/\/+$/, "")}${path}`, data, {
      headers: {
        Authorization: `Token ${String(token || "").trim()}`,
        "User-Agent": LISTENBRAINZ_USER_AGENT,
      },
      timeoutMs: LISTENBRAINZ_SUBMIT_TIMEOUT_MS,
    }),
  );
  return response.data;
};

const tokenValidationSchema = v.looseObject({
  valid: v.optional(v.boolean()),
  user_name: v.optional(v.string()),
});

export const listenbrainzValidateToken = async (
  token: string | null | undefined,
  baseUrl: string | null | undefined = LISTENBRAINZ_API,
) => {
  const root = normalizeListenbrainzBaseUrl(baseUrl);
  const response = await listenbrainzLimiter.schedule(() =>
    http.get(`${root}/1/validate-token`, {
      headers: {
        Authorization: `Token ${String(token || "").trim()}`,
        "User-Agent": LISTENBRAINZ_USER_AGENT,
      },
      timeoutMs: LISTENBRAINZ_TIMEOUT_MS,
    }),
  );
  return readOne(tokenValidationSchema, response.data, {
    service: "ListenBrainz",
    endpoint: "/1/validate-token",
  });
};

const mbid = (value: string | null | undefined) =>
  value && MBID_PATTERN.test(value) ? value : undefined;

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
  const listenedAt =
    event.listenType === "playing_now" ? undefined : Math.floor(Number(event.playedAt) / 1000);
  if (listenedAt !== undefined && !(Number.isFinite(listenedAt) && listenedAt > 0)) {
    throw new Error("listenbrainzSubmit requires a numeric playedAt timestamp");
  }
  const artistMbids = (event.artistMbids ?? []).flatMap((id) => mbid(id) ?? []);
  const payload = {
    listen_type: event.listenType ?? "single",
    payload: [
      {
        listened_at: listenedAt,
        track_metadata: {
          artist_name: event.artist,
          track_name: event.title,
          ...(event.album && { release_name: event.album }),
          additional_info: {
            submission_client: "Aurral",
            duration_ms: event.durationMs || undefined,
            recording_mbid: mbid(event.trackMbid),
            release_mbid: mbid(event.releaseMbid),
            release_group_mbid: mbid(event.albumMbid),
            artist_mbids: artistMbids.length ? artistMbids : undefined,
            artist_names: event.artistNames?.length ? event.artistNames : undefined,
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
    priority = 0,
    cache = true,
  }: {
    token?: string | null;
    baseUrl?: string;
    timeoutMs?: number;
    data?: unknown;
    priority?: number;
    cache?: boolean;
  } = {},
): Promise<unknown> {
  const root = normalizeListenbrainzBaseUrl(baseUrl);
  const isAuthenticated = Boolean(String(token || "").trim());
  const cacheKey =
    isAuthenticated || !cache
      ? null
      : `lb:${root}:${path}:${JSON.stringify(params)}${data ? `:${JSON.stringify(data)}` : ""}`;
  if (cacheKey) {
    const cached = listenbrainzCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const inflight = listenbrainzInflightRequests.get(cacheKey);
    if (inflight) return inflight;
  }

  const pause = listenbrainzPause(root);
  pause.check();
  const requestPromise = (async () => {
    const isRetryable = (error: unknown) => {
      const status = asAppError(error)?.response?.status;
      return (
        isTransientNetworkError(error) ||
        (status !== undefined && [408, 425, 500, 502, 503, 504].includes(status))
      );
    };
    const getLogKey = (details: ListenbrainzErrorDetails) =>
      `${details.path}:${details.status || "none"}:${details.code || "none"}`;
    const logFailure = (details: ListenbrainzErrorDetails) => {
      const key = getLogKey(details);
      const now = Date.now();
      const last = listenbrainzErrorLogAt.get(key) || 0;
      if (now - last < 15000) return;
      listenbrainzErrorLogAt.set(key, now);
      logger.warn("listenbrainz", "ListenBrainz request failed", details);
    };

    let lastError: unknown = null;
    for (let retryCount = 0; retryCount <= LISTENBRAINZ_MAX_RETRIES; retryCount++) {
      try {
        const response = await listenbrainzLimiter.schedule(
          () => {
            const config: HttpOptions = {
              query: params,
              headers: {
                "User-Agent": LISTENBRAINZ_USER_AGENT,
                ...(isAuthenticated && { Authorization: `Token ${String(token).trim()}` }),
              },
              timeoutMs,
            };
            return pause.run(() =>
              data ? http.post(`${root}${path}`, data, config) : http.get(`${root}${path}`, config),
            );
          },
          { priority },
        );
        const payload = response.status === 204 ? null : response.data;
        if (cacheKey) listenbrainzCache.set(cacheKey, payload);
        return payload;
      } catch (error) {
        lastError = error;
        const rateLimitWaitMs = getRateLimitWaitMs(error);
        if (rateLimitWaitMs !== null) listenbrainzLimiter.pauseFor(rateLimitWaitMs);
        if (retryCount < LISTENBRAINZ_MAX_RETRIES && rateLimitWaitMs !== null) continue;
        if (retryCount < LISTENBRAINZ_MAX_RETRIES && isRetryable(error)) {
          await waitBeforeRetry(retryCount);
          continue;
        }
        break;
      }
    }

    const failure = asAppError(lastError);
    const responseData: unknown = failure?.response?.data;
    const payloadError: unknown =
      (typeof responseData === "object" &&
        responseData !== null &&
        (Reflect.get(responseData, "error") || Reflect.get(responseData, "message"))) ||
      null;
    const details = {
      path,
      status: failure?.response?.status || null,
      code: failure?.code || null,
      message: failure?.message || "Unknown ListenBrainz error",
      error: payloadError,
    };
    if (details.code !== "PAUSED") logFailure(details);
    throw lastError;
  })();

  if (cacheKey) listenbrainzInflightRequests.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    if (cacheKey) listenbrainzInflightRequests.delete(cacheKey);
  }
}

const listenbrainzMbids = lenient(v.array(v.nullable(v.string())));

export const listenbrainzTopArtistsSchema = v.fallback(
  v.looseObject({
    payload: lenient(
      v.looseObject({
        artists: lenient(
          v.array(
            v.fallback(
              v.looseObject({
                artist_name: lenientText,
                artist_mbid: lenient(v.nullable(v.string())),
                artist_mbids: listenbrainzMbids,
                listen_count: lenientCount,
              }),
              {},
            ),
          ),
        ),
      }),
    ),
  }),
  {},
);

export { listenbrainzCache };
