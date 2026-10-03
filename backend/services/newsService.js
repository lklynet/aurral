import { db } from "../config/db-sqlite.js";
import { buildImageProxyUrl } from "./imageProxyService.js";
import { dbOps } from "../db/helpers/index.js";
import { getLibraryArtistKeyProjection } from "./libraryQueryService.js";
import { getNewsSettings } from "./apiClients/config.js";
import { fetchArticleImage, fetchRssFeed } from "./rssNews.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { getUserDiscovery } from "./discovery/userDiscovery.js";
import createCache from "./apiClients/simpleCache.js";

const REFRESH_STATE_KEY = "news:refreshState";
const ARTICLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTICLES = 5000;
const MAX_IMAGE_LOOKUPS = 40;

const articleMatchCache = createCache(5 * 60, 100);

const upsertArticle = db.prepare(`
  INSERT INTO news_articles (
    id, source_url, source, url, title, description, categories, image_url, image_checked, published_at
  ) VALUES (
    @id, @sourceUrl, @source, @url, @title, @description, @categories, @imageUrl, @imageChecked, @publishedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    source = excluded.source,
    url = excluded.url,
    title = excluded.title,
    description = excluded.description,
    categories = excluded.categories,
    image_url = COALESCE(excluded.image_url, news_articles.image_url)
`);
const deleteStaleArticles = db.prepare(`
  DELETE FROM news_articles
  WHERE published_at < ? OR source_url NOT IN (SELECT value FROM json_each(?))
`);
const trimArticles = db.prepare(`
  DELETE FROM news_articles WHERE id IN (
    SELECT id FROM news_articles ORDER BY published_at DESC, id LIMIT -1 OFFSET ?
  )
`);
const selectArticlesMissingImages = db.prepare(`
  SELECT id, url FROM news_articles
  WHERE image_url IS NULL AND image_checked = 0
  ORDER BY published_at DESC
  LIMIT ?
`);
const setArticleImage = db.prepare(
  "UPDATE news_articles SET image_url = ?, image_checked = 1 WHERE id = ?",
);
const selectArticleTerms = db.prepare("SELECT id, title, categories FROM news_articles");
const selectActiveArticleIds = db.prepare(`
  SELECT id FROM news_articles
  WHERE source_url IN (SELECT value FROM json_each(?))
  ORDER BY published_at DESC, id
`);
const selectArticlesByIds = db.prepare(`
  SELECT * FROM news_articles
  WHERE id IN (SELECT value FROM json_each(?))
  ORDER BY published_at DESC, id
`);

export function invalidateNewsResponseCache() {
  articleMatchCache.flushAll();
}

const getEnabledFeeds = (settings) => settings.enabled
  ? settings.feeds.filter((feed) => feed.enabled && (feed.group === "custom" || settings.groups[feed.group] !== false))
  : [];

const normalizeName = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/\p{M}+/gu, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

const isSingleWordName = (name) => !name.includes(" ");

const parseCategories = (value) => {
  try {
    const categories = JSON.parse(value || "[]");
    return Array.isArray(categories) ? categories : [];
  } catch {
    return [];
  }
};

async function getNewsArtists(userId) {
  const recommendedArtists = userId
    ? ((await getUserDiscovery(userId, 50, 0))?.body?.recommendations || [])
    : [];
  const artists = [
    ...getLibraryArtistKeyProjection().map((artist) => ({
      artistMbid: artist.mbid || null,
      artistName: String(artist.artistName || "").trim(),
      newsType: "library",
    })),
    ...recommendedArtists.map((artist) => ({
      artistMbid: String(artist?.mbid || artist?.id || "").trim() || null,
      artistName: String(artist?.name || artist?.artistName || "").trim(),
      newsType: "recommended",
    })),
  ];
  const byIdentity = new Map();
  for (const artist of artists) {
    const identity = artist.artistMbid || `name:${artist.artistName.toLowerCase()}`;
    if (artist.artistName && !byIdentity.has(identity)) byIdentity.set(identity, artist);
  }
  return [...byIdentity.values()];
}

const buildArtistIndex = (artists) => {
  const names = new Map();
  let maxWords = 0;
  for (const artist of artists) {
    const name = normalizeName(artist.artistName);
    if (name.length < 2) continue;
    maxWords = Math.max(maxWords, name.split(" ").length);
    names.set(name, [...(names.get(name) || []), artist]);
  }
  return { names, maxWords };
};

// Feeds that tag stories use categories to name the artists covered. For those
// stories, a one-word name in the title is too ambiguous to count on its own.
const findArticleArtists = ({ title, categories }, { names, maxWords }) => {
  const matched = new Set(
    categories.map(normalizeName).filter((category) => names.has(category)),
  );
  const requireCategory = categories.length > 0;
  const words = normalizeName(title).split(" ");
  for (let start = 0; start < words.length; start += 1) {
    let phrase = "";
    for (let end = start; end < Math.min(words.length, start + maxWords); end += 1) {
      phrase = phrase ? `${phrase} ${words[end]}` : words[end];
      if (names.has(phrase) && !(requireCategory && isSingleWordName(phrase))) matched.add(phrase);
    }
  }
  const matchedNames = [...matched];
  return matchedNames
    .filter((name) => !matchedNames.some((other) => other !== name && ` ${other} `.includes(` ${name} `)))
    .flatMap((name) => names.get(name))
    .sort((left, right) => (left.newsType === "recommended") - (right.newsType === "recommended"));
};

async function getArticleMatches(userId) {
  const cacheKey = String(userId || "");
  const cached = articleMatchCache.get(cacheKey);
  if (cached) return cached;
  const artistIndex = buildArtistIndex(await getNewsArtists(userId));
  const matches = new Map();
  for (const row of selectArticleTerms.all()) {
    const artists = findArticleArtists(
      { title: row.title, categories: parseCategories(row.categories) },
      artistIndex,
    );
    if (artists.length > 0) matches.set(row.id, artists);
  }
  articleMatchCache.set(cacheKey, matches);
  return matches;
}

const toArticle = (row, artists) => ({
  id: row.id,
  title: row.title,
  description: row.description || "",
  url: row.url,
  source: row.source,
  sourceUrl: row.source_url,
  publishedAt: new Date(row.published_at).toISOString(),
  imageUrl: buildImageProxyUrl(row.image_url),
  artists,
});

export async function getNewsForUser({
  userId,
  mode = "matched",
  limit = 60,
  offset = 0,
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 60)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const feedUrls = getEnabledFeeds(getNewsSettings()).map((feed) => feed.url);
  const matches = await getArticleMatches(userId);
  const ids = selectActiveArticleIds.all(JSON.stringify(feedUrls)).map((row) => row.id);
  const candidates = mode === "top" ? ids : ids.filter((id) => matches.has(id));
  const pageIds = candidates.slice(safeOffset, safeOffset + safeLimit);
  const state = dbOps.getJSONSetting(REFRESH_STATE_KEY) || {};
  return {
    articles: selectArticlesByIds
      .all(JSON.stringify(pageIds))
      .map((row) => toArticle(row, matches.get(row.id) || [])),
    hasMore: safeOffset + safeLimit < candidates.length,
    refresh: {
      checkedAt: state.checkedAt || null,
      failedFeeds: Array.isArray(state.failedFeeds) ? state.failedFeeds : [],
      warning: state.allFailed ? "RSS feeds could not be refreshed. Showing cached stories." : null,
    },
  };
}

async function lookupMissingImages() {
  const articles = selectArticlesMissingImages.all(MAX_IMAGE_LOOKUPS);
  const images = await mapWithConcurrency(articles, 3, async ({ id, url }) => ({
    id,
    imageUrl: await fetchArticleImage(url),
  }));
  db.transaction(() => {
    for (const { id, imageUrl } of images) setArticleImage.run(imageUrl, id);
  })();
}

export async function refreshNewsFeeds() {
  const settings = getNewsSettings();
  const feeds = getEnabledFeeds(settings);
  const results = await mapWithConcurrency(feeds, 3, async (feed) => {
    try {
      return { feed, articles: await fetchRssFeed(feed) };
    } catch {
      return { feed, articles: null };
    }
  });
  const now = Date.now();
  const oldestPublishedAt = now - ARTICLE_TTL_MS;
  const failedFeeds = results.filter((result) => !result.articles).map(({ feed }) => feed.name);
  db.transaction(() => {
    for (const article of results.flatMap((result) => result.articles || [])) {
      const publishedAt = Math.min(new Date(article.publishedAt || now).getTime() || now, now);
      if (publishedAt < oldestPublishedAt) continue;
      upsertArticle.run({
        ...article,
        categories: JSON.stringify(article.categories),
        imageChecked: article.imageUrl ? 1 : 0,
        publishedAt,
      });
    }
    deleteStaleArticles.run(oldestPublishedAt, JSON.stringify(settings.feeds.map((feed) => feed.url)));
    trimArticles.run(MAX_ARTICLES);
    dbOps.setJSONSetting(REFRESH_STATE_KEY, {
      checkedAt: now,
      failedFeeds,
      allFailed: feeds.length > 0 && failedFeeds.length === feeds.length,
    });
  })();
  await lookupMissingImages();
  invalidateNewsResponseCache();
}

export const disableNewsFeed = (sourceUrl) => {
  const news = getNewsSettings();
  const url = String(sourceUrl || "").trim();
  if (!news.feeds.some((feed) => feed.url === url && feed.enabled)) return news;
  const nextNews = {
    ...news,
    feeds: news.feeds.map((feed) => (feed.url === url ? { ...feed, enabled: false } : feed)),
  };
  dbOps.updateSettings({
    integrations: { ...(dbOps.getSettings().integrations || {}), news: nextNews },
  });
  return nextNews;
};
