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
import { dbOps } from "../../db/helpers/index.ts";
import { APP_NAME, APP_VERSION, LISTENBRAINZ_API } from "../../config/constants.ts";

type ListenbrainzSubmitEvent = {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  trackMbid?: string | null;
  albumMbid?: string | null;
  artistMbid?: string | null;
} & ({ listenType?: "single"; playedAt: number | string } | { listenType: "playing_now" });

interface ListenbrainzErrorDetails {
  path: string;
  status: number | null;
  code: string | number | null;
  message: string;
  error: unknown;
}

const listenbrainzCache = createCache(300);
const releaseGroupLookupFailures = createCache<true>(300, 500);
const releaseGroupLookups = new Map<string, Promise<void>>();
const RELEASE_GROUP_POPULARITY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_GROUP_MISSING_DATE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const RELEASE_GROUP_DATE_LOOKUP_LIMIT = 300;
const RELEASE_GROUP_LOOKUP_PRIORITY = 1;
const LISTENBRAINZ_POPULARITY_BATCH_SIZE = 1000;
const LISTENBRAINZ_METADATA_BATCH_SIZE = 100;

const listenbrainzLimiter = createRateLimiter(350);
const LISTENBRAINZ_USER_AGENT = `${APP_NAME}/${APP_VERSION} ( https://github.com/lklynet/aurral )`;

const LISTENBRAINZ_TIMEOUT_MS = 6000;
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
      timeoutMs: LISTENBRAINZ_TIMEOUT_MS,
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
    priority = 0,
  }: {
    token?: string | null;
    baseUrl?: string;
    timeoutMs?: number;
    data?: unknown;
    priority?: number;
  } = {},
): Promise<unknown> {
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

const toBatches = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const toListenCount = (value: number | null | undefined) =>
  Number.isInteger(value) && value! > 0 ? value! : null;

export const listenbrainzGetReleaseGroupListens = async (releaseGroupMbids: string[]) => {
  const batches = await Promise.all(
    toBatches(releaseGroupMbids, LISTENBRAINZ_POPULARITY_BATCH_SIZE).map((mbids) =>
      listenbrainzRequest(
        "/1/popularity/release-group",
        {},
        { data: { release_group_mbids: mbids }, priority: RELEASE_GROUP_LOOKUP_PRIORITY },
      ),
    ),
  );
  if (!batches.every(Array.isArray)) throw new TypeError("ListenBrainz popularity is not a list");
  const listens = new Map<string, { listenCount: number; listenerCount: number }>();
  for (const row of batches.flatMap((batch) => v.parse(popularityRowsSchema, batch))) {
    const listenCount = toListenCount(row.total_listen_count);
    const listenerCount = toListenCount(row.total_user_count);
    if (row.release_group_mbid && listenCount && listenerCount) {
      listens.set(row.release_group_mbid, { listenCount, listenerCount });
    }
  }
  return listens;
};

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

export const listenbrainzTopRecordingsSchema = v.fallback(
  v.looseObject({
    payload: lenient(
      v.looseObject({
        recordings: lenient(
          v.array(
            v.fallback(
              v.looseObject({
                artist_name: lenientText,
                artist_mbids: listenbrainzMbids,
                track_name: lenientText,
                release_name: lenient(v.nullable(v.string())),
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

const popularityRowsSchema = v.array(
  v.fallback(
    v.looseObject({
      release_group_mbid: lenientText,
      total_listen_count: lenient(v.nullable(v.number())),
      total_user_count: lenient(v.nullable(v.number())),
    }),
    {},
  ),
);

const releaseGroupMetadataSchema = v.record(
  v.string(),
  v.fallback(v.looseObject({ release_group: lenient(v.looseObject({ date: lenientText })) }), {}),
);

const isReleaseGroupMetadata = (batch: unknown) =>
  Boolean(batch) && typeof batch === "object" && !Array.isArray(batch) && !("error" in batch!);

const listenbrainzGetReleaseGroupDates = async (releaseGroupMbids: string[]) => {
  const batches = await Promise.all(
    toBatches(releaseGroupMbids, LISTENBRAINZ_METADATA_BATCH_SIZE).map((mbids) =>
      listenbrainzRequest(
        "/1/metadata/release_group/",
        { release_group_mbids: mbids.join(",") },
        { priority: RELEASE_GROUP_LOOKUP_PRIORITY },
      ),
    ),
  );
  if (!batches.every(isReleaseGroupMetadata)) {
    throw new TypeError("ListenBrainz release group metadata is not keyed by MBID");
  }
  const dates = new Map<string, string>();
  for (const batch of batches) {
    for (const [mbid, metadata] of Object.entries(v.parse(releaseGroupMetadataSchema, batch))) {
      const date = metadata.release_group?.date;
      if (date) dates.set(mbid, date);
    }
  }
  return dates;
};

const lookUpReleaseGroups = (kind: string, mbids: string[], lookUp: () => Promise<void>) => {
  if (!mbids.length) return null;
  const key = `${kind}:${mbids.join(",")}`;
  if (releaseGroupLookupFailures.get(key)) return null;
  const running = releaseGroupLookups.get(key);
  if (running) return running;
  const lookup = lookUp()
    .catch(() => {
      releaseGroupLookupFailures.set(key, true);
    })
    .finally(() => releaseGroupLookups.delete(key));
  releaseGroupLookups.set(key, lookup);
  return lookup;
};

const isDue = (checkedAt: number | null | undefined, maxAgeMs: number, now: number) =>
  checkedAt == null || now - checkedAt > maxAgeMs;

const settlesWithin = async (waitMs: number, lookups: Promise<void>[]) => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, waitMs, false);
  });
  try {
    return await Promise.race([Promise.all(lookups).then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export async function listenbrainzGetReleaseGroupStats(
  releaseGroups: { id: string; "first-release-date"?: string | null }[],
  { waitMs }: { waitMs: number },
) {
  const ids = releaseGroups.map(({ id }) => id);
  const now = Date.now();
  const stored = dbOps.getListenbrainzReleaseGroups(ids);
  const popularityIds = ids.filter((id) =>
    isDue(stored.get(id)?.popularity_checked_at, RELEASE_GROUP_POPULARITY_FRESH_MS, now),
  );
  const dateIds = releaseGroups
    .filter((releaseGroup) => {
      if (releaseGroup["first-release-date"]) return false;
      const record = stored.get(releaseGroup.id);
      return (
        !record?.first_release_date &&
        isDue(record?.dates_checked_at, RELEASE_GROUP_MISSING_DATE_RECHECK_MS, now)
      );
    })
    .slice(0, RELEASE_GROUP_DATE_LOOKUP_LIMIT)
    .map(({ id }) => id);
  const lookups = [
    {
      unanswered: popularityIds.some((id) => stored.get(id)?.popularity_checked_at == null),
      lookup: lookUpReleaseGroups("popularity", popularityIds, async () => {
        const listens = await listenbrainzGetReleaseGroupListens(popularityIds);
        dbOps.saveListenbrainzReleaseGroupPopularity(
          new Map(popularityIds.map((id) => [id, listens.get(id) ?? null])),
          Date.now(),
        );
      }),
    },
    {
      unanswered: dateIds.some((id) => stored.get(id)?.dates_checked_at == null),
      lookup: lookUpReleaseGroups("dates", dateIds, async () => {
        const dates = await listenbrainzGetReleaseGroupDates(dateIds);
        dbOps.saveListenbrainzReleaseGroupDates(
          new Map(dateIds.map((id) => [id, dates.get(id) ?? null])),
          Date.now(),
        );
      }),
    },
  ];
  const awaited = lookups.flatMap(({ unanswered, lookup }) =>
    unanswered && lookup ? [lookup] : [],
  );
  if (!awaited.length) return { records: stored, pending: false };
  const answered = await settlesWithin(waitMs, awaited);
  return {
    records: answered ? dbOps.getListenbrainzReleaseGroups(ids) : stored,
    pending: !answered,
  };
}

export function clearListenbrainzStats() {
  releaseGroupLookupFailures.flushAll();
  dbOps.clearListenbrainzReleaseGroups();
  dbOps.clearListenbrainzArtistTags();
}

export { listenbrainzCache };
