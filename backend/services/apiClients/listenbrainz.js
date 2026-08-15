import axios from "../../../lib/axiosFetch.js";
import createRateLimiter from "./rateLimiter.js";
import createCache from "./simpleCache.js";
import { logger } from "../logger.js";
import { LISTENBRAINZ_API } from "../../config/constants.js";

const listenbrainzCache = createCache(300);

const listenbrainzLimiter = createRateLimiter(250);

const LISTENBRAINZ_TIMEOUT_MS = 6000;
const LISTENBRAINZ_MAX_RETRIES = 2;

const listenbrainzInflightRequests = new Map();
const listenbrainzErrorLogAt = new Map();

const listenbrainzWrite = async (baseUrl, path, { token, data } = {}) => {
  const response = await listenbrainzLimiter.schedule(() =>
    axios.post(`${String(baseUrl).replace(/\/+$/, "")}${path}`, data, {
      headers: { Authorization: `Token ${String(token || "").trim()}` },
      timeout: LISTENBRAINZ_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    }),
  );
  return response.data;
};

export const listenbrainzValidateToken = async (token) => {
  const response = await listenbrainzLimiter.schedule(() =>
    axios.get(`${LISTENBRAINZ_API}/1/validate-token`, {
      headers: { Authorization: `Token ${String(token || "").trim()}` },
      timeout: LISTENBRAINZ_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    }),
  );
  return response.data;
};

export const listenbrainzSubmit = async ({ token, baseUrl = LISTENBRAINZ_API, event }) => {
  const payload = {
    listen_type: "single",
    payload: [{
      listened_at: Math.floor(Number(event.playedAt) / 1000),
      track_metadata: {
        artist_name: event.artist,
        track_name: event.title,
        ...(event.album ? { release_name: event.album } : {}),
        additional_info: {
          submission_client: "Aurral",
          duration_ms: event.durationMs || undefined,
          recording_mbid: event.trackMbid || undefined,
          release_mbid: event.albumMbid || undefined,
          artist_mbids: event.artistMbid ? [event.artistMbid] : undefined,
        },
      },
    }],
  };
  return listenbrainzWrite(`${String(baseUrl).replace(/\/+$/, "")}/1`, "/submit-listens", {
    token,
    data: payload,
  });
};

export async function listenbrainzRequest(path, params = {}) {
  const cacheKey = `lb:${path}:${JSON.stringify(params)}`;
  const cached = listenbrainzCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const inflight = listenbrainzInflightRequests.get(cacheKey);
  if (inflight) return inflight;

  const requestPromise = (async () => {
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
      `${details.path}:${details.status || "none"}:${details.code || "none"}`;
    const logError = (message, details) => {
      const key = getLogKey(details);
      const now = Date.now();
      const last = listenbrainzErrorLogAt.get(key) || 0;
      if (now - last < 15000) return;
      listenbrainzErrorLogAt.set(key, now);
      logger.error("api", message, details);
    };

    let lastError = null;
    for (
      let retryCount = 0;
      retryCount <= LISTENBRAINZ_MAX_RETRIES;
      retryCount++
    ) {
      try {
        const response = await listenbrainzLimiter.schedule(() =>
          axios.get(`${LISTENBRAINZ_API}${path}`, {
            params,
            timeout: LISTENBRAINZ_TIMEOUT_MS,
            validateStatus: (status) =>
              (status >= 200 && status < 300) || status === 204,
          }),
        );
        const payload = response.status === 204 ? null : response.data;
        listenbrainzCache.set(cacheKey, payload);
        return payload;
      } catch (error) {
        lastError = error;
        if (retryCount < LISTENBRAINZ_MAX_RETRIES && isRetryable(error)) {
          const backoffMs = 300 * Math.pow(2, retryCount) + retryCount * 200;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }

    const details = {
      path,
      status: lastError?.response?.status || null,
      code: lastError?.code || null,
      message: lastError?.message || "Unknown ListenBrainz error",
      error:
        lastError?.response?.data?.error ||
        lastError?.response?.data?.message ||
        null,
    };
    logError("ListenBrainz API error:", details);
    throw lastError;
  })();

  listenbrainzInflightRequests.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    listenbrainzInflightRequests.delete(cacheKey);
  }
}

export { listenbrainzCache };
