import { createHash } from "node:crypto";
import axios from "../../lib/axiosFetch.js";
import { assertPublicUrl } from "../../lib/publicUrl.js";

const MAX_ITEMS_PER_FEED = 100;
const ENTITY_MAP = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeXml = (value) => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
    const parsed = code.toLowerCase().startsWith("x")
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10);
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
  })
  .replace(/&([a-z]+);/gi, (_, name) => ENTITY_MAP[name.toLowerCase()] || `&${name};`)
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const getTag = (xml, tag) => {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return decodeXml(match?.[1] || "");
};

const getRawTag = (xml, tag) => {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1] || "";
};

const getAttribute = (xml, tag, attribute) => {
  const match = String(xml || "").match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, "i"));
  return decodeXml(match?.[1] || "");
};

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

const getItemLink = (xml) =>
  getTag(xml, "link") ||
  getAttribute(xml, "link", "href") ||
  getAttribute(xml, "enclosure", "url");

const getItemImage = (xml) =>
  getAttribute(xml, "media:content", "url") ||
  getAttribute(xml, "media:thumbnail", "url") ||
  getAttribute(xml, "image", "href") ||
  getTag(xml, "image") ||
  (getAttribute(xml, "enclosure", "type").startsWith("image/")
    ? getAttribute(xml, "enclosure", "url")
    : null) ||
  getHtmlImage(getRawTag(xml, "content:encoded")) ||
  getHtmlImage(getRawTag(xml, "description")) ||
  getTag(xml, "media:content");

const parseItems = (xml) => {
  const matches = [...String(xml || "").matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  return matches.slice(0, MAX_ITEMS_PER_FEED).map(([, , itemXml]) => ({
    title: getTag(itemXml, "title"),
    description: getTag(itemXml, "description") || getTag(itemXml, "summary") || getTag(itemXml, "content"),
    url: getItemLink(itemXml),
    publishedAt: getTag(itemXml, "pubDate") || getTag(itemXml, "published") || getTag(itemXml, "updated") || null,
    imageUrl: getItemImage(itemXml) || null,
  })).filter((item) => item.title && item.url);
};

const getFeedTitle = (xml, feed) =>
  getTag(xml, "title") || feed.name || new URL(feed.url).hostname;

const resolveUrl = (value, base) => {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
};

export const normalizeRssArticle = (article, feed) => ({
  id: createHash("sha1").update(`${feed.url}\n${article.url}`).digest("hex"),
  title: article.title,
  description: article.description,
  url: resolveUrl(article.url, feed.url),
  source: feed.name,
  sourceUrl: feed.url,
  publishedAt: article.publishedAt,
  imageUrl: article.imageUrl ? resolveUrl(article.imageUrl, feed.url) : null,
});

export const parseRssFeed = (xml, feed) =>
  parseItems(xml).map((item) => normalizeRssArticle(item, {
    ...feed,
    name: getFeedTitle(xml, feed),
  }));

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
