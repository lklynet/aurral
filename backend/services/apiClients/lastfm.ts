import axios from "../../../lib/axiosFetch.ts";
import https from "https";
import { createHash } from "node:crypto";
import createRateLimiter from "./rateLimiter.ts";
import createCache from "./simpleCache.ts";
import { logger } from "../logger.ts";
import { LASTFM_API } from "../../config/constants.ts";
import { getLastfmApiKey, getLastfmApiSecret } from "./config.ts";
import { runSharedInflight } from "../sharedInflight.ts";
import { asAppError } from "../../../lib/errors.ts";

interface LastfmScrobbleEvent {
  playedAt: number | string;
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  trackMbid?: string | null;
  artistMbid?: string | null;
}

interface LastfmErrorDetails {
  method: string;
  status: number | null;
  code: string | number | null;
  message: string;
  error: unknown;
}

const lastfmCache = createCache(300);

const lastfmLimiter = createRateLimiter(200);

const lastfmHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 15000,
});

const LASTFM_TIMEOUT_MS =
  Math.max(3000, parseInt(String(process.env.AURRAL_LASTFM_TIMEOUT_MS), 10) || 0) || 15000;
const LASTFM_MAX_RETRIES = 2;

const lastfmInflightRequests = new Map();
const lastfmErrorLogAt = new Map();

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
    axios.post(LASTFM_API, new URLSearchParams({ ...signedParams, format: "json" }), {
      timeout: LASTFM_TIMEOUT_MS,
      httpsAgent: lastfmHttpsAgent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: (status) => status >= 200 && status < 300,
    }),
  );
  if (response.data?.error) {
    throw new Error(response.data.message || `Last.fm request failed (${response.data.error})`);
  }
  return response.data;
};

export const lastfmGetSession = (token: string | null | undefined) =>
  signedLastfmRequest("auth.getSession", { token: String(token || "").trim() });

export const lastfmScrobble = (event: LastfmScrobbleEvent, sessionKey: string | null | undefined) =>
  signedLastfmRequest("track.scrobble", {
    sk: sessionKey,
    artist: event.artist,
    track: event.title,
    timestamp: Math.floor(Number(event.playedAt) / 1000),
    ...(event.album ? { album: event.album } : {}),
    ...(event.artistMbid ? { artist_mbid: event.artistMbid } : {}),
    ...(event.trackMbid ? { mbid: event.trackMbid } : {}),
    ...(event.durationMs ? { duration: Math.round(event.durationMs / 1000) } : {}),
  });

export async function lastfmRequest(
  method: string,
  params: Record<string, string | number | null | undefined> = {},
  options: { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
) {
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
      const getLogKey = (details: LastfmErrorDetails) =>
        `${details.method}:${details.status || "none"}:${details.code || "none"}`;
      const logError = (message: string, details: LastfmErrorDetails) => {
        const key = getLogKey(details);
        const now = Date.now();
        const last = lastfmErrorLogAt.get(key) || 0;
        if (now - last < 15000) return;
        lastfmErrorLogAt.set(key, now);
        logger.error("api", message, details);
      };
      let lastError: unknown = null;
      for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        sharedSignal.throwIfAborted?.();
        try {
          const response = await lastfmLimiter.schedule(() =>
            axios.get(LASTFM_API, {
              params: {
                method,
                api_key: apiKey,
                format: "json",
                ...params,
              },
              timeout: timeoutMs,
              httpsAgent: lastfmHttpsAgent,
              signal: sharedSignal,
            }),
          );
          lastfmCache.set(cacheKey, response.data);
          return response.data;
        } catch (error) {
          if (sharedSignal.aborted) throw sharedSignal.reason || error;
          lastError = error;
          if (retryCount < maxRetries && isRetryable(error)) {
            const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        }
      }
      const failure = asAppError(lastError);
      const status = failure?.response?.status || null;
      const responseData = failure?.response?.data;
      const payloadError =
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
      if (details.code === "ECONNABORTED") {
        logError(`Last.fm API timeout (${method})`, details);
      } else {
        logError(`Last.fm API error (${method})`, details);
      }
      return null;
    },
    { signal: options.signal },
  );
}

export { lastfmCache };
