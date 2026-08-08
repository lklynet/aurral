import { buildImageProxyUrl } from "./imageProxyService.js";
import { dbOps } from "../db/helpers/index.js";
import { libraryManager } from "./libraryManager.js";
import { getNewsSettings } from "./apiClients/config.js";
import { fetchArticleImage, fetchRssFeed } from "./rssNews.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { getUserDiscovery } from "./discovery/userDiscovery.js";

const NEWS_PREFERENCES_KEY = (userId) => `user:${Number.parseInt(userId, 10)}:newsPreferences`;
const NEWS_STATE_KEY = "news:rssState";
// RSS feeds are local and quota-free; keep the cache short enough for new stories to appear promptly.
const REFRESH_TTL_MS = 5 * 60 * 1000;
const ARTICLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTICLES = 1000;
const MAX_BLOCKED_PUBLISHERS = 100;

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
  const value = String(source || "").trim().toLowerCase();
  return value && blockedPublishers.some((publisher) => publisher.toLowerCase() === value);
};

const getStoredState = () => {
  const stored = dbOps.getJSONSetting(NEWS_STATE_KEY);
  return {
    checkedAt: Number(stored?.checkedAt || 0),
    articles: Array.isArray(stored?.articles) ? stored.articles : [],
    failedFeeds: Array.isArray(stored?.failedFeeds) ? stored.failedFeeds : [],
  };
};

const saveState = (state) => {
  dbOps.setJSONSetting(NEWS_STATE_KEY, {
    checkedAt: state.checkedAt || 0,
    articles: state.articles.slice(0, MAX_ARTICLES),
    failedFeeds: state.failedFeeds.slice(0, 50),
  });
};

const normalizeText = (value) => String(value || "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const containsArtistName = (article, artistName) => {
  const name = normalizeText(artistName);
  if (name.length < 3) return false;
  const title = normalizeText(article.title);
  return title.includes(name);
};

const publishedTime = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const normalizeArtists = (artists) => [...new Map(
  (Array.isArray(artists) ? artists : [])
    .map((artist) => ({
      artistMbid: String(artist?.foreignArtistId || artist?.mbid || "").trim() || null,
      artistName: String(artist?.artistName || artist?.name || "").trim(),
      newsType: artist?.newsType === "recommended" ? "recommended" : "library",
    }))
    .filter((artist) => artist.artistName)
    .map((artist) => [artist.artistMbid || `name:${artist.artistName.toLowerCase()}`, artist]),
).values()];

const getEnabledFeeds = (settings) => settings.enabled
  ? settings.feeds.filter((feed) => feed.enabled && (feed.group === "custom" || settings.groups[feed.group] !== false))
  : [];

async function enrichArticleImages(articles, state) {
  const missing = articles.filter((article) => !article.imageUrl && article.url);
  if (missing.length === 0) return articles;
  const discovered = await mapWithConcurrency(missing, 3, async (article) => ({
    id: article.id,
    imageUrl: await fetchArticleImage(article.url),
  }));
  const images = new Map(discovered.filter((entry) => entry.imageUrl).map((entry) => [entry.id, entry.imageUrl]));
  if (images.size === 0) return articles;
  state.articles = state.articles.map((article) => (
    images.has(article.id) ? { ...article, imageUrl: images.get(article.id) } : article
  ));
  saveState(state);
  return articles.map((article) => (
    images.has(article.id) ? { ...article, imageUrl: images.get(article.id) } : article
  ));
}

async function refreshRssFeeds() {
  const settings = getNewsSettings();
  const feeds = getEnabledFeeds(settings);
  const state = getStoredState();
  const now = Date.now();
  if (state.checkedAt && now - state.checkedAt < REFRESH_TTL_MS) {
    return { state, attemptedCount: 0, warning: null };
  }
  if (feeds.length === 0) {
    state.checkedAt = now;
    state.failedFeeds = [];
    state.articles = [];
    saveState(state);
    return { state, attemptedCount: 0, warning: null };
  }

  const results = await mapWithConcurrency(feeds, 3, async (feed) => {
    try {
      return { feed, articles: await fetchRssFeed(feed) };
    } catch {
      return { feed, articles: [], failed: true };
    }
  });
  const failedUrls = new Set(results.filter((result) => result.failed).map(({ feed }) => feed.url));
  const cachedArticles = state.articles.filter((article) => (
    failedUrls.has(article.sourceUrl)
    && (!article.publishedAt || now - publishedTime(article.publishedAt) <= ARTICLE_TTL_MS)
  ));
  const freshArticles = results.flatMap((result) => result.articles);
  const byId = new Map([...cachedArticles, ...freshArticles].map((article) => [article.id, article]));
  const failedFeeds = results.filter((result) => result.failed).map(({ feed }) => feed.name);
  state.articles = [...byId.values()]
    .filter((article) => !article.publishedAt || now - publishedTime(article.publishedAt) <= ARTICLE_TTL_MS)
    .sort((left, right) => publishedTime(right.publishedAt) - publishedTime(left.publishedAt))
    .slice(0, MAX_ARTICLES);
  state.checkedAt = now;
  state.failedFeeds = failedFeeds;
  saveState(state);
  return {
    state,
    attemptedCount: feeds.length,
    warning: failedFeeds.length === feeds.length ? "RSS feeds could not be refreshed. Showing cached stories." : null,
  };
}

const refreshFeeds = () => {
  if (!refreshPromise) {
    refreshPromise = refreshRssFeeds().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

export const matchNewsArticles = (articles, artists, blockedPublishers = []) => {
  const seen = new Set();
  return (Array.isArray(articles) ? articles : [])
    .flatMap((article) => artists
      .filter((artist) => containsArtistName(article, artist.artistName))
      .map((artist) => ({
        ...article,
        artistMbid: artist.artistMbid,
        artistName: artist.artistName,
        newsType: artist.newsType,
        imageUrl: buildImageProxyUrl(article.imageUrl) || article.imageUrl || null,
      })))
    .filter((article) => {
      const key = `${article.id}:${article.artistMbid || article.artistName}`;
      if (seen.has(key) || isPublisherBlocked(article.source, blockedPublishers)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => publishedTime(right.publishedAt) - publishedTime(left.publishedAt));
};

export const getNewsPreferences = (userId) => {
  const stored = dbOps.getJSONSetting(NEWS_PREFERENCES_KEY(userId));
  return { blockedPublishers: normalizeBlockedPublishers(stored?.blockedPublishers) };
};

export const updateNewsPreferences = (userId, preferences = {}) => {
  const next = { blockedPublishers: normalizeBlockedPublishers(preferences.blockedPublishers) };
  dbOps.setJSONSetting(NEWS_PREFERENCES_KEY(userId), next);
  return next;
};

export const disableNewsFeed = (sourceUrl, sourceName) => {
  const settings = dbOps.getSettings();
  const news = getNewsSettings();
  const url = String(sourceUrl || "").trim();
  const name = String(sourceName || "").trim().toLowerCase();
  const feeds = news.feeds.map((feed) => (
    (url && feed.url === url) || (!url && name && feed.name.toLowerCase() === name)
      ? { ...feed, enabled: false }
      : feed
  ));
  if (!feeds.some((feed, index) => feed.enabled !== news.feeds[index]?.enabled)) {
    return news;
  }
  const nextNews = { ...news, feeds };
  dbOps.updateSettings({
    integrations: { ...(settings.integrations || {}), news: nextNews },
  });
  return nextNews;
};

export async function getNewsForUser({ limit = 60, offset = 0, userId, mode = "matched" } = {}) {
  const settings = getNewsSettings();
  const libraryArtists = await libraryManager.getAllArtists();
  const recommendedArtists = userId
    ? ((await getUserDiscovery(userId, 50, 0))?.body?.recommendations || [])
    : [];
  const artists = normalizeArtists([
    ...libraryArtists.map((artist) => ({ ...artist, newsType: "library" })),
    ...recommendedArtists.map((artist) => ({ ...artist, newsType: "recommended" })),
  ]);
  const preferences = getNewsPreferences(userId);
  const refresh = await refreshFeeds();
  const activeFeedUrls = new Set(getEnabledFeeds(settings).map((feed) => feed.url));
  const activeArticles = refresh.state.articles.filter((article) => activeFeedUrls.has(article.sourceUrl));
  const matchedArticles = matchNewsArticles(
    activeArticles,
    artists,
    preferences.blockedPublishers,
  );
  const matchedById = new Map(matchedArticles.map((article) => [article.id, article]));
  // Normalize pagination before enriching or slicing the current page.
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 60)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  let articles = mode === "top"
    ? activeArticles
      .filter((article) => !isPublisherBlocked(article.source, preferences.blockedPublishers))
      .map((article) => ({
        ...article,
        ...(matchedById.get(article.id) || {}),
        imageUrl: buildImageProxyUrl(article.imageUrl) || article.imageUrl || null,
      }))
    : matchedArticles;
  if (mode === "top") {
    const page = articles.slice(safeOffset, safeOffset + safeLimit);
    const enrichedPage = await enrichArticleImages(page, refresh.state);
    const enrichedById = new Map(enrichedPage.map((article) => [article.id, article]));
    articles = articles.map((article) => enrichedById.get(article.id) || article);
  }
  return {
    configured: settings.enabled && getEnabledFeeds(settings).length > 0,
    artistCount: artists.length,
    feedCount: getEnabledFeeds(settings).length,
    articles: articles.slice(safeOffset, safeOffset + safeLimit),
    hasMore: safeOffset + safeLimit < articles.length,
    blockedPublishers: preferences.blockedPublishers,
    refresh: {
      checkedAt: refresh.state.checkedAt || null,
      failedFeeds: refresh.state.failedFeeds,
      warning: refresh.warning || null,
    },
  };
}

export const getLibraryNews = getNewsForUser;

export async function refreshLibraryNews() {
  return getNewsForUser();
}

export const getNewsFeedState = () => {
  const settings = getNewsSettings();
  return {
    enabled: settings.enabled,
    groups: settings.groups,
    feeds: settings.feeds,
    lastCheckedAt: getStoredState().checkedAt || null,
  };
};
