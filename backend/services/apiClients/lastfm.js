import axios from "../../../lib/axiosFetch.js";
import https from "https";
import { createHash } from "node:crypto";
import createRateLimiter from "./rateLimiter.js";
import createCache from "./simpleCache.js";
import { logger } from "../logger.js";
import { LASTFM_API } from "../../config/constants.js";
import { getLastfmApiKey, getLastfmApiSecret } from "./config.js";
import { runSharedInflight } from "../sharedInflight.js";

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
  Math.max(3000, parseInt(process.env.AURRAL_LASTFM_TIMEOUT_MS, 10) || 0) || 15000;
const LASTFM_MAX_RETRIES = 2;

const lastfmInflightRequests = new Map();
const lastfmErrorLogAt = new Map();

const signedLastfmRequest = async (method, params = {}) => {
  const apiKey = getLastfmApiKey();
  const apiSecret = getLastfmApiSecret();
  if (!apiKey || !apiSecret) throw new Error("Last.fm API credentials are not configured");
  const signedParams = { ...params, api_key: apiKey, method };
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

export const lastfmGetSession = (token) =>
  signedLastfmRequest("auth.getSession", { token: String(token || "").trim() });

export const lastfmScrobble = (event, sessionKey) =>
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

export async function lastfmRequest(method, params = {}, options = {}) {
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

  return runSharedInflight(lastfmInflightRequests, cacheKey, async (sharedSignal) => {
    const isRetryable = (error) => {
      const status = error.response?.status;
      const code = error.code;
      return (
        code === "ECONNABORTED" ||
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        [408, 425, 500, 502, 503, 504].includes(status)
      );
    };
    const getLogKey = (details) =>
      `${details.method}:${details.status || "none"}:${details.code || "none"}`;
    const logError = (message, details) => {
      const key = getLogKey(details);
      const now = Date.now();
      const last = lastfmErrorLogAt.get(key) || 0;
      if (now - last < 15000) return;
      lastfmErrorLogAt.set(key, now);
      logger.error("api", message, details);
    };
    let lastError = null;
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
    const status = lastError?.response?.status || null;
    const payloadError =
      lastError?.response?.data?.message ||
      lastError?.response?.data?.error ||
      null;
    const details = {
      method,
      status,
      code: lastError?.code || null,
      message: lastError?.message || "Unknown Last.fm error",
      error: payloadError,
    };
    if (details.code === "ECONNABORTED") {
      logError(`Last.fm API timeout (${method})`, details);
    } else {
      logError(`Last.fm API error (${method})`, details);
    }
    return null;
  }, { signal: options.signal });
}

export { lastfmCache };
