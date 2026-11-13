import * as v from "valibot";
import { http, isTransientNetworkError, waitBeforeRetry } from "../../../lib/http.ts";
import { createHash } from "node:crypto";
import createRateLimiter from "./rateLimiter.ts";
import createCache from "./simpleCache.ts";
import { createOutagePause } from "./outagePause.ts";
import { logger } from "../logger.ts";
import { LASTFM_API } from "../../config/constants.ts";
import { getLastfmApiKey, getLastfmApiSecret } from "./config.ts";
import { runSharedInflight, type InflightRequests } from "../sharedInflight.ts";
import { asAppError } from "../../../lib/errors.ts";
import { lenient, lenientCount, lenientText, oneOrMany, readOne } from "../integrationData.ts";

interface LastfmTrackEvent {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  trackMbid?: string | null;
  artistMbid?: string | null;
}

interface LastfmScrobbleEvent extends LastfmTrackEvent {
  playedAt: number | string;
}

interface LastfmErrorDetails {
  method: string;
  status: number | null;
  code: string | number | null;
  message: string;
  error: unknown;
}

const lastfmText = lenientText;
const lastfmCount = lenientCount;
const lastfmRank = lenient(v.looseObject({ rank: lastfmCount }));

const lastfmImageSchema = v.looseObject({ size: lastfmText, "#text": lastfmText });
const lastfmTagSchema = v.looseObject({ name: lastfmText, count: lastfmCount });
const lastfmArtistSchema = v.looseObject({
  name: lastfmText,
  "#text": lastfmText,
  mbid: lastfmText,
  match: lastfmCount,
  image: oneOrMany(lastfmImageSchema),
  listeners: lastfmCount,
  playcount: lastfmCount,
  rank: lastfmCount,
  "@attr": lastfmRank,
});
const lastfmTrackSchema = v.looseObject({
  name: lastfmText,
  mbid: lastfmText,
  playcount: lastfmCount,
  listeners: lastfmCount,
  duration: lastfmCount,
  artist: lenient(v.looseObject({ name: lastfmText, "#text": lastfmText, mbid: lastfmText })),
  album: lenient(v.looseObject({ title: lastfmText, "#text": lastfmText })),
  "@attr": lastfmRank,
});
const lastfmResponseSchema = v.looseObject({
  error: lenient(v.number()),
  toptags: lenient(v.looseObject({ tag: oneOrMany(lastfmTagSchema) })),
  tags: lenient(v.looseObject({ tag: oneOrMany(lastfmTagSchema) })),
  similarartists: lenient(v.looseObject({ artist: oneOrMany(lastfmArtistSchema) })),
  artists: lenient(v.looseObject({ artist: oneOrMany(lastfmArtistSchema) })),
  topartists: lenient(
    v.looseObject({
      artist: oneOrMany(lastfmArtistSchema),
      "@attr": lenient(v.looseObject({ total: lastfmText })),
    }),
  ),
  toptracks: lenient(v.looseObject({ track: oneOrMany(lastfmTrackSchema) })),
  tracks: lenient(v.looseObject({ track: oneOrMany(lastfmTrackSchema) })),
  track: lenient(lastfmTrackSchema),
  album: lenient(
    v.looseObject({ tracks: lenient(v.looseObject({ track: oneOrMany(lastfmTrackSchema) })) }),
  ),
});

export type LastfmImage = v.InferOutput<typeof lastfmImageSchema>;
export type LastfmArtist = v.InferOutput<typeof lastfmArtistSchema>;
export type LastfmTrack = v.InferOutput<typeof lastfmTrackSchema>;
type LastfmResponse = v.InferOutput<typeof lastfmResponseSchema>;

const lastfmCache = createCache<LastfmResponse>(300);

const lastfmLimiter = createRateLimiter(200, { shared: LASTFM_API });

const LASTFM_TIMEOUT_MS =
  Math.max(3000, parseInt(String(process.env.AURRAL_LASTFM_TIMEOUT_MS), 10) || 0) || 15000;
const LASTFM_MAX_RETRIES = 2;

const lastfmInflightRequests: InflightRequests = new Map();
const lastfmErrorLogAt = new Map<string, number>();
const lastfmPause = createOutagePause("Last.fm");

const signedLastfmRequest = async (
  method: string,
  params: Record<string, string | number | null | undefined> = {},
) => {
  const apiKey = getLastfmApiKey();
  const apiSecret = getLastfmApiSecret();
  if (!apiKey || !apiSecret) throw new Error("Last.fm API credentials are not configured");
  const signedParams: Record<string, string | number | null | undefined> = {
    ...params,
    api_key: apiKey,
    method,
  };
  const signature = Object.keys(signedParams)
    .sort()
    .map((key) => `${key}${signedParams[key]}`)
    .join("");
  signedParams.api_sig = createHash("md5").update(`${signature}${apiSecret}`).digest("hex");
  const response = await lastfmLimiter.schedule(() =>
    http.post(LASTFM_API, new URLSearchParams({ ...signedParams, format: "json" }), {
      timeoutMs: LASTFM_TIMEOUT_MS,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
  );
  const failure = v.safeParse(lastfmErrorSchema, response.data);
  if (failure.success) {
    throw new Error(failure.output.message || `Last.fm request failed (${failure.output.error})`);
  }
  return response.data;
};

const lastfmErrorSchema = v.looseObject({
  error: v.number(),
  message: v.optional(v.string()),
});

const lastfmSessionSchema = v.looseObject({
  session: v.optional(v.looseObject({ key: v.optional(v.string()), name: v.optional(v.string()) })),
});

export const lastfmGetSession = async (token: string | null | undefined) =>
  readOne(
    lastfmSessionSchema,
    await signedLastfmRequest("auth.getSession", { token: String(token || "").trim() }),
    { service: "Last.fm", endpoint: "auth.getSession" },
  ).session;

const lastfmTrackParams = (event: LastfmTrackEvent) => ({
  artist: event.artist,
  track: event.title,
  ...(event.album && { album: event.album }),
  ...(event.artistMbid && { artist_mbid: event.artistMbid }),
  ...(event.trackMbid && { mbid: event.trackMbid }),
  ...(event.durationMs && { duration: Math.round(event.durationMs / 1000) }),
});

export const lastfmScrobble = (event: LastfmScrobbleEvent, sessionKey: string | null | undefined) =>
  signedLastfmRequest("track.scrobble", {
    sk: sessionKey,
    ...lastfmTrackParams(event),
    timestamp: Math.floor(Number(event.playedAt) / 1000),
  });

export const lastfmUpdateNowPlaying = (
  event: LastfmTrackEvent,
  sessionKey: string | null | undefined,
) => signedLastfmRequest("track.updateNowPlaying", { sk: sessionKey, ...lastfmTrackParams(event) });

export async function lastfmRequest(
  method: string,
  params: Record<string, string | number | null | undefined> = {},
  options: { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
): Promise<LastfmResponse | null> {
  const apiKey = getLastfmApiKey();
  if (!apiKey) return null;

  const cacheKey = `lfm:${method}:${JSON.stringify(params)}`;
  const cached = lastfmCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(500, Math.floor(Number(options.timeoutMs)))
    : LASTFM_TIMEOUT_MS;
  const maxRetries = Number.isFinite(Number(options?.maxRetries))
    ? Math.max(0, Math.floor(Number(options.maxRetries)))
    : LASTFM_MAX_RETRIES;

  return runSharedInflight(
    lastfmInflightRequests,
    cacheKey,
    async (sharedSignal: AbortSignal) => {
      const isRetryable = (error: unknown) => {
        const status = asAppError(error)?.response?.status;
        return (
          isTransientNetworkError(error) ||
          (status !== undefined && [408, 425, 500, 502, 503, 504].includes(status))
        );
      };
      const getLogKey = (details: LastfmErrorDetails) =>
        `${details.method}:${details.status || "none"}:${details.code || "none"}`;
      const logFailure = (message: string, details: LastfmErrorDetails) => {
        const key = getLogKey(details);
        const now = Date.now();
        const last = lastfmErrorLogAt.get(key) || 0;
        if (now - last < 15000) return;
        lastfmErrorLogAt.set(key, now);
        logger.warn("api", message, details);
      };
      let lastError: unknown = null;
      for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        sharedSignal.throwIfAborted?.();
        if (lastfmPause.paused()) return null;
        try {
          const response = await lastfmLimiter.schedule(() =>
            lastfmPause.run(() =>
              http.get(LASTFM_API, {
                query: {
                  method,
                  api_key: apiKey,
                  format: "json",
                  ...params,
                },
                timeoutMs,
                signal: sharedSignal,
              }),
            ),
          );
          const data = readOne(lastfmResponseSchema, response.data, {
            service: "Last.fm",
            endpoint: method,
          });
          lastfmCache.set(cacheKey, data);
          return data;
        } catch (error) {
          if (sharedSignal.aborted) throw sharedSignal.reason || error;
          lastError = error;
          if (retryCount < maxRetries && isRetryable(error)) {
            await waitBeforeRetry(retryCount);
            continue;
          }
          break;
        }
      }
      const failure = asAppError(lastError);
      const status = failure?.response?.status || null;
      const responseData: unknown = failure?.response?.data;
      const payloadError: unknown =
        (typeof responseData === "object" &&
          responseData !== null &&
          (Reflect.get(responseData, "message") || Reflect.get(responseData, "error"))) ||
        null;
      const details = {
        method,
        status,
        code: failure?.code || null,
        message: failure?.message || "Unknown Last.fm error",
        error: payloadError,
      };
      if (details.code === "TIMEOUT") {
        logFailure(`Last.fm API timeout (${method})`, details);
      } else if (details.code !== "PAUSED") {
        logFailure(`Last.fm API error (${method})`, details);
      }
      return null;
    },
    { signal: options.signal },
  );
}

export { lastfmCache };
