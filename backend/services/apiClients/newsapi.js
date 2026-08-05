import axios from "../../../lib/axiosFetch.js";
import createCache from "./simpleCache.js";
import { getNewsApiKey, getNewsApiSettings } from "./config.js";

const NEWS_API_BASE = "https://newsapi.org/v2/everything";
const newsCache = createCache(3600);
const HOUR_MS = 60 * 60 * 1000;
const NEWS_WINDOW_MS = 7 * 24 * HOUR_MS;

const buildQuery = (artistName) => `"${String(artistName || "").replaceAll('"', "")}"`;

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
    searchIn: "title,description",
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
    .filter((article) => article.title && article.url);
  newsCache.set(cacheKey, normalized);
  return normalized;
}

export { newsCache };
