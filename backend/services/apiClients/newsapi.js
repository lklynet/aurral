import axios from "../../../lib/axiosFetch.js";
import createCache from "./simpleCache.js";
import { getNewsApiKey, getNewsApiSettings } from "./config.js";

const NEWS_API_BASE = "https://newsapi.org/v2/everything";
const newsCache = createCache(3600);
const HOUR_MS = 60 * 60 * 1000;
const NEWS_WINDOW_MS = 7 * 24 * HOUR_MS;
const MUSIC_CONTEXT_QUERY =
  "(music OR musician OR band OR singer OR songwriter OR album OR single OR song OR track OR tune OR release OR tour OR concert OR festival OR performance OR recording OR record OR soundtrack OR discography OR lyrics OR spotify OR grammy OR billboard OR vinyl OR producer OR composer OR guitarist OR drummer OR bassist OR label)";
const MUSIC_INTENT_PATTERN =
  /\b(?:music|musician|band|singer|songwriter|album|single|song|track|tune|release|tour|concert|festival|performance|performing|recording|record|soundtrack|discography|lyrics|spotify|grammy|billboard|vinyl|producer|composer|guitarist|drummer|bassist|label)\b/i;
const MUSIC_HEADLINE_TITLE_PATTERN =
  /\b(?:music|musician|band|singer|songwriter|album|single|song|track|tune|release|tour|concert|festival|live|recording|soundtrack|discography|lyrics|spotify|grammy|billboard|vinyl|producer|composer|guitarist|drummer|bassist)\b/i;
const LOW_QUALITY_PUBLISHER_DOMAINS = [
  "biztoc.com",
  "rlsbb.cc",
  "newsbreak.com",
  "flipboard.com",
  "smartnews.com",
  "muckrack.com",
];

const buildQuery = (artistName) =>
  `"${String(artistName || "").replaceAll('"', "")}" AND ${MUSIC_CONTEXT_QUERY}`;

const normalizeSearchText = (value) =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const isMusicArticle = (article, artistName = "") => {
  const title = String(article?.title || "");
  const text = `${title} ${String(article?.description || "")}`;
  const normalizedArtist = normalizeSearchText(artistName);
  const normalizedTitle = normalizeSearchText(title);
  if (normalizedArtist && !normalizedTitle.includes(normalizedArtist)) return false;
  return MUSIC_INTENT_PATTERN.test(text);
};

export const isMusicHeadlineArticle = (article) =>
  MUSIC_HEADLINE_TITLE_PATTERN.test(String(article?.title || ""));

const getArticleHostname = (url) => {
  try {
    return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

export const isLowQualityNewsPublisher = (article) => {
  const hostname = getArticleHostname(article?.url);
  const source = String(article?.source || "").toLowerCase();
  return LOW_QUALITY_PUBLISHER_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`) || source.includes(domain),
  );
};

export async function newsApiSearchArtist(artistName, { signal } = {}) {
  const apiKey = getNewsApiKey();
  const normalizedName = String(artistName || "").trim();
  if (!apiKey || !normalizedName) return [];
  const settings = getNewsApiSettings();
  const from = new Date(
    Math.floor((Date.now() - NEWS_WINDOW_MS) / HOUR_MS) * HOUR_MS,
  ).toISOString();
  const params = {
    q: buildQuery(normalizedName),
    searchIn: "title",
    from,
    language: settings.language,
    sortBy: "publishedAt",
    pageSize: 20,
  };
  if (settings.domains.length > 0) params.domains = settings.domains.join(",");
  const cacheKey = JSON.stringify(params);
  const cached = newsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const response = await axios.get(NEWS_API_BASE, {
    params,
    headers: { "X-Api-Key": apiKey },
    timeout: 10000,
    signal,
  });
  const articles = Array.isArray(response.data?.articles) ? response.data.articles : [];
  const normalized = articles
    .map((article) => ({
      title: String(article?.title || "").trim(),
      description: String(article?.description || "").trim(),
      url: String(article?.url || "").trim(),
      source: String(article?.source?.name || "").trim(),
      publishedAt: article?.publishedAt || null,
      imageUrl: String(article?.urlToImage || "").trim() || null,
    }))
    .filter(
      (article) =>
        article.title &&
        article.url &&
        isMusicArticle(article, normalizedName) &&
        !isLowQualityNewsPublisher(article),
    );
  newsCache.set(cacheKey, normalized);
  return normalized;
}

export async function newsApiSearchMusicHeadlines({ signal } = {}) {
  const apiKey = getNewsApiKey();
  if (!apiKey) return [];
  const settings = getNewsApiSettings();
  const from = new Date(
    Math.floor((Date.now() - NEWS_WINDOW_MS) / HOUR_MS) * HOUR_MS,
  ).toISOString();
  const params = {
    q: MUSIC_CONTEXT_QUERY,
    searchIn: "title,description",
    from,
    language: settings.language,
    sortBy: "publishedAt",
    pageSize: 20,
  };
  if (settings.domains.length > 0) params.domains = settings.domains.join(",");
  const cacheKey = `music-headlines:${JSON.stringify(params)}`;
  const cached = newsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const response = await axios.get(NEWS_API_BASE, {
    params,
    headers: { "X-Api-Key": apiKey },
    timeout: 10000,
    signal,
  });
  const articles = Array.isArray(response.data?.articles) ? response.data.articles : [];
  const normalized = articles
    .map((article) => ({
      title: String(article?.title || "").trim(),
      description: String(article?.description || "").trim(),
      url: String(article?.url || "").trim(),
      source: String(article?.source?.name || "").trim(),
      publishedAt: article?.publishedAt || null,
      imageUrl: String(article?.urlToImage || "").trim() || null,
    }))
    .filter(
      (article) =>
        article.title &&
        article.url &&
        isMusicHeadlineArticle(article) &&
        !isLowQualityNewsPublisher(article),
    );
  newsCache.set(cacheKey, normalized);
  return normalized;
}

export { newsCache };
