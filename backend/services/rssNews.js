import { createHash } from "node:crypto";
import { parseFeed } from "@rowanmanning/feed-parser";
import { decode } from "html-entities";
import axios from "../../lib/axiosFetch.js";
import { assertPublicUrl } from "../../lib/publicUrl.js";

const MAX_ITEMS_PER_FEED = 100;
const MAX_CATEGORIES = 20;
const MAX_DESCRIPTION_LENGTH = 500;

const htmlToText = (value) => String(value || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const isUsableImageUrl = (value) => {
  const url = String(value || "").trim().toLowerCase();
  return /^https?:\/\//.test(url) && !/(tracking|pixel|badge|listen-on|favicon|\.ico(?:$|\?))/.test(url);
};

const getHtmlImage = (html) => {
  const candidates = [
    ...String(html || "").matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)/gi),
    ...String(html || "").matchAll(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/gi),
    ...String(html || "").matchAll(/<img\b[^>]*\bsrc=["']([^"']+)/gi),
  ].map((match) => match[1]);
  return candidates.find(isUsableImageUrl) || null;
};

const isImageMedia = (media) =>
  media.type === "image" || media.mimeType?.startsWith("image/") || (!media.type && !media.mimeType);

const getItemImage = (item) =>
  [...item.media.filter(isImageMedia).map((media) => media.url), item.image?.url]
    .map((url) => decode(url || ""))
    .find(isUsableImageUrl) ||
  getHtmlImage(item.content) ||
  getHtmlImage(item.description);

const resolveUrl = (value, base) => {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
};

const getItemCategories = (item) => [
  ...new Set(item.categories.map((category) => htmlToText(category.label || category.term))),
].filter(Boolean).slice(0, MAX_CATEGORIES);

const normalizeRssArticle = (article, feed) => ({
  id: createHash("sha1").update(`${feed.url}\n${article.url}`).digest("hex"),
  title: article.title,
  description: article.description,
  categories: article.categories,
  url: resolveUrl(article.url, feed.url),
  source: feed.name,
  sourceUrl: feed.url,
  publishedAt: article.publishedAt,
  imageUrl: article.imageUrl ? resolveUrl(article.imageUrl, feed.url) : null,
});

export const parseRssFeed = (xml, feed) => {
  const parsed = parseFeed(xml);
  const source = { ...feed, name: feed.name || parsed.title || new URL(feed.url).hostname };
  return parsed.items
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((item) => ({
      title: htmlToText(item.title),
      description: htmlToText(item.description || item.content).slice(0, MAX_DESCRIPTION_LENGTH),
      categories: getItemCategories(item),
      url: decode(item.url || ""),
      publishedAt: (item.published || item.updated)?.toISOString() || null,
      imageUrl: getItemImage(item) || null,
    }))
    .filter((item) => item.title && item.url)
    .map((item) => normalizeRssArticle(item, source));
};

export async function fetchRssFeed(feed, { signal } = {}) {
  const response = await axios.get(feed.url, {
    publicOnly: true,
    signal,
    timeout: 10000,
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  return parseRssFeed(String(response.data || ""), feed);
}

export async function fetchArticleImage(articleUrl) {
  try {
    await assertPublicUrl(articleUrl);
    const response = await axios.get(articleUrl, {
      publicOnly: true,
      timeout: 8000,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    return getHtmlImage(String(response.data || ""));
  } catch {
    return null;
  }
}
