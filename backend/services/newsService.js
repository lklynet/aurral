import { createHash } from "crypto";
import { buildImageProxyUrl } from "./imageProxyService.js";
import { dbOps } from "../db/helpers/index.js";
import { libraryManager } from "./libraryManager.js";
import { getNewsApiKey } from "./apiClients/config.js";
import { newsApiSearchArtist } from "./apiClients/newsapi.js";
import { mapWithConcurrency } from "./discovery/helpers.js";

const NEWS_PREFERENCES_KEY = (userId) => `user:${Number.parseInt(userId, 10)}:newsPreferences`;
const NEWS_STATE_KEY = "news:refreshState";
const MAX_BLOCKED_PUBLISHERS = 100;
const NEWS_REQUEST_LIMIT = 100;
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const ARTIST_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_ARTIST_RETRY_MS = 60 * 60 * 1000;
const RATE_LIMIT_PAUSE_MS = 12 * 60 * 60 * 1000;
const REFRESH_BATCH_SIZE = 25;
const REFRESH_CONCURRENCY = 5;
const MAX_ARTICLES_PER_ARTIST = 20;

let refreshPromise = null;

const normalizeBlockedPublishers = (publishers) => {
  const seen = new Set();
  return (Array.isArray(publishers) ? publishers : [])
    .map((publisher) => String(publisher || "").trim())
    .filter((publisher) => {
      const key = publisher.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_BLOCKED_PUBLISHERS);
};

const isPublisherBlocked = (source, blockedPublishers) => {
  const key = String(source || "").trim().toLowerCase();
  return key && blockedPublishers.some((publisher) => publisher.toLowerCase() === key);
};

export const getNewsPreferences = (userId) => {
  const stored = dbOps.getJSONSetting(NEWS_PREFERENCES_KEY(userId));
  return { blockedPublishers: normalizeBlockedPublishers(stored?.blockedPublishers) };
};

export const updateNewsPreferences = (userId, preferences = {}) => {
  const next = {
    blockedPublishers: normalizeBlockedPublishers(preferences.blockedPublishers),
  };
  dbOps.setJSONSetting(NEWS_PREFERENCES_KEY(userId), next);
  return next;
};

const normalizeArtists = (artists) =>
  [...new Map(
    (Array.isArray(artists) ? artists : [])
    .map((artist) => ({
      artistMbid: String(artist?.foreignArtistId || artist?.mbid || "").trim() || null,
      artistName: String(artist?.artistName || artist?.name || "").trim(),
    }))
    .filter((artist) => artist.artistName)
    .map((artist) => [getArtistKey(artist), artist]),
  ).values()];

const getArtistKey = (artist) =>
  artist.artistMbid || `name:${artist.artistName.toLowerCase()}`;

const getStoredNewsState = () => {
  const stored = dbOps.getJSONSetting(NEWS_STATE_KEY);
  const apiKey = getNewsApiKey();
  const apiKeyMarker = apiKey
    ? createHash("sha256").update(apiKey).digest("hex")
    : "";
  const keyChanged =
    stored?.apiKeyMarker && apiKeyMarker && stored.apiKeyMarker !== apiKeyMarker;
  const artists = stored?.artists && typeof stored.artists === "object"
    ? stored.artists
    : {};
  const requestTimes = Array.isArray(stored?.requestTimes)
    ? keyChanged
      ? []
      : stored.requestTimes.map(Number).filter(Number.isFinite)
    : [];
  return {
    artists,
    requestTimes,
    rateLimitedUntil: keyChanged ? 0 : Number(stored?.rateLimitedUntil || 0),
    apiKeyMarker,
  };
};

const pruneRequestTimes = (requestTimes, now = Date.now()) =>
  requestTimes.filter((timestamp) => now - timestamp < REQUEST_WINDOW_MS);

const saveStoredNewsState = (state) => {
  dbOps.setJSONSetting(NEWS_STATE_KEY, {
    artists: state.artists,
    requestTimes: state.requestTimes,
    rateLimitedUntil: state.rateLimitedUntil || 0,
    apiKeyMarker: state.apiKeyMarker || "",
  });
};

const getArtistEntry = (state, artist) => state.artists[getArtistKey(artist)] || null;

const isArtistDue = (entry, now) => {
  if (!entry) return true;
  const nextAttemptAt = Number(entry.nextAttemptAt || 0);
  if (nextAttemptAt > now) return false;
  return now - Number(entry.checkedAt || 0) >= ARTIST_REFRESH_TTL_MS;
};

const normalizeArticles = (articles) =>
  (Array.isArray(articles) ? articles : [])
    .map((article) => ({
      title: String(article?.title || "").trim(),
      description: String(article?.description || "").trim(),
      url: String(article?.url || "").trim(),
      source: String(article?.source || "").trim(),
      publishedAt: article?.publishedAt || null,
      imageUrl: String(article?.imageUrl || "").trim() || null,
    }))
    .filter((article) => article.title && article.url)
    .slice(0, MAX_ARTICLES_PER_ARTIST);

const isRateLimitedError = (error) =>
  Number(error?.response?.status) === 429 ||
  error?.response?.data?.code === "rateLimited";

const runDueArtistRefresh = async (artists) => {
  const now = Date.now();
  const state = getStoredNewsState();
  state.requestTimes = pruneRequestTimes(state.requestTimes, now);

  if (state.rateLimitedUntil > now) {
    return { state, failedCount: 0, attemptedCount: 0, warning: "NewsAPI rate limit reached. Refresh is paused until the quota window resets." };
  }

  const availableCalls = Math.max(0, NEWS_REQUEST_LIMIT - state.requestTimes.length);
  const dueArtists = artists
    .filter((artist) => isArtistDue(getArtistEntry(state, artist), now))
    .sort((left, right) => {
      const leftEntry = getArtistEntry(state, left);
      const rightEntry = getArtistEntry(state, right);
      const leftAttempted = Number(leftEntry?.attemptedAt || 0);
      const rightAttempted = Number(rightEntry?.attemptedAt || 0);
      if (leftAttempted === 0 || rightAttempted === 0) {
        if (leftAttempted === 0 && rightAttempted !== 0) return -1;
        if (rightAttempted === 0 && leftAttempted !== 0) return 1;
      }
      return leftAttempted - rightAttempted;
    });
  const selectedArtists = dueArtists.slice(0, Math.min(REFRESH_BATCH_SIZE, availableCalls));

  if (selectedArtists.length === 0) {
    const warning = dueArtists.length > 0
      ? "NewsAPI refresh budget exhausted for the current 24-hour window."
      : null;
    saveStoredNewsState(state);
    return { state, failedCount: 0, attemptedCount: 0, warning };
  }

  let rateLimited = false;
  const results = await mapWithConcurrency(
    selectedArtists,
    REFRESH_CONCURRENCY,
    async (artist) => {
      if (rateLimited) return { artist, skipped: true };
      const attemptedAt = Date.now();
      state.requestTimes.push(attemptedAt);
      try {
        return {
          artist,
          attemptedAt,
          articles: await newsApiSearchArtist(artist.artistName),
        };
      } catch (error) {
        if (isRateLimitedError(error)) rateLimited = true;
        return { artist, attemptedAt, error };
      }
    },
  );

  let failedCount = 0;
  let attemptedCount = 0;
  let succeededCount = 0;
  let rateLimitedCount = 0;
  for (const result of results) {
    if (result.skipped) continue;
    attemptedCount += 1;
    const key = getArtistKey(result.artist);
    const previous = getArtistEntry(state, result.artist) || {};
    if (result.error) {
      failedCount += 1;
      if (isRateLimitedError(result.error)) rateLimitedCount += 1;
      state.artists[key] = {
        ...previous,
        artistMbid: result.artist.artistMbid,
        artistName: result.artist.artistName,
        attemptedAt: result.attemptedAt,
        nextAttemptAt: result.attemptedAt + FAILED_ARTIST_RETRY_MS,
      };
      continue;
    }
    succeededCount += 1;
    state.artists[key] = {
      artistMbid: result.artist.artistMbid,
      artistName: result.artist.artistName,
      checkedAt: result.attemptedAt,
      attemptedAt: result.attemptedAt,
      nextAttemptAt: result.attemptedAt + ARTIST_REFRESH_TTL_MS,
      articles: normalizeArticles(result.articles),
    };
  }

  if (rateLimitedCount > 0) {
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
  }
  saveStoredNewsState(state);
  return {
    state,
    failedCount,
    attemptedCount,
    succeededCount,
    warning: rateLimitedCount > 0
      ? "NewsAPI rate limit reached. Showing cached stories until the quota window resets."
      : failedCount > 0
        ? "Some artist news could not be refreshed. Showing cached stories."
        : null,
  };
};

const refreshDueArtists = (artists) => {
  if (!refreshPromise) {
    refreshPromise = runDueArtistRefresh(artists).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

const publishedTime = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const collectArticles = (state, artists, blockedPublishers) => {
  const seenUrls = new Set();
  return artists
    .flatMap((artist) => {
      const entry = getArtistEntry(state, artist);
      return (Array.isArray(entry?.articles) ? entry.articles : []).map((article) => ({
        ...article,
        artistMbid: artist.artistMbid,
        artistName: artist.artistName,
        imageUrl: buildImageProxyUrl(article.imageUrl) || article.imageUrl || null,
      }));
    })
    .filter((article) => {
      if (!article.url || seenUrls.has(article.url)) return false;
      if (isPublisherBlocked(article.source, blockedPublishers)) return false;
      seenUrls.add(article.url);
      return true;
    })
    .sort((left, right) => publishedTime(right.publishedAt) - publishedTime(left.publishedAt));
};

const getRefreshStatus = (state, artists, refreshResult, now = Date.now()) => {
  const requestTimes = pruneRequestTimes(state.requestTimes, now);
  const checkedArtistCount = artists.filter((artist) => Number(getArtistEntry(state, artist)?.checkedAt || 0) > 0).length;
  const queuedArtistCount = artists.filter((artist) => isArtistDue(getArtistEntry(state, artist), now)).length;
  const lastCheckedAt = artists.reduce(
    (latest, artist) => Math.max(latest, Number(getArtistEntry(state, artist)?.checkedAt || 0)),
    0,
  );
  return {
    checkedArtistCount,
    queuedArtistCount,
    callsUsed: requestTimes.length,
    callsRemaining: Math.max(0, NEWS_REQUEST_LIMIT - requestTimes.length),
    lastCheckedAt: lastCheckedAt || null,
    rateLimitedUntil: state.rateLimitedUntil > now ? state.rateLimitedUntil : null,
    warning: refreshResult.warning || null,
  };
};

export async function fetchNewsForArtists(artists, { blockedPublishers = [] } = {}) {
  if (!getNewsApiKey()) {
    return { configured: false, artistCount: 0, articles: [] };
  }

  const normalizedArtists = normalizeArtists(artists);
  const normalizedBlockedPublishers = normalizeBlockedPublishers(blockedPublishers);
  const refreshResult = await refreshDueArtists(normalizedArtists);
  const state = getStoredNewsState();
  const articles = collectArticles(state, normalizedArtists, normalizedBlockedPublishers);
  if (refreshResult.failedCount > 0 && articles.length === 0) {
    const allLibraryArtistsFailed =
      refreshResult.failedCount === refreshResult.attemptedCount &&
      refreshResult.attemptedCount === normalizedArtists.length;
    const error = new Error(
      refreshResult.state.rateLimitedUntil > Date.now()
        ? "NewsAPI rate limit reached. Artist news refresh is paused until the quota window resets."
        : allLibraryArtistsFailed
          ? "NewsAPI failed for every library artist"
        : "NewsAPI failed before returning any library news",
    );
    error.statusCode = refreshResult.state.rateLimitedUntil > Date.now() ? 429 : 502;
    throw error;
  }

  return {
    configured: true,
    artistCount: normalizedArtists.length,
    articles,
    refresh: getRefreshStatus(state, normalizedArtists, refreshResult),
  };
}

export async function getLibraryNews({ limit = 60, userId } = {}) {
  const preferences = getNewsPreferences(userId);
  const result = await fetchNewsForArtists(await libraryManager.getAllArtists(), preferences);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 60)));
  return {
    ...result,
    blockedPublishers: preferences.blockedPublishers,
    articles: result.articles.slice(0, safeLimit),
  };
}

export async function refreshLibraryNews() {
  if (!getNewsApiKey()) return { configured: false, artistCount: 0, articles: [] };
  return fetchNewsForArtists(await libraryManager.getAllArtists());
}
