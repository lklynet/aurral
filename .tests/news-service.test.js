import assert from "node:assert/strict";
import test from "node:test";
import axios from "../lib/axiosFetch.js";
import { setupIsolatedBackend, cleanupIsolatedState } from "./helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, rssNews, newsService, config] = await setupIsolatedBackend(
  "rss-news-service",
  "backend/db/helpers/index.js",
  "backend/services/rssNews.js",
  "backend/services/newsService.js",
  "backend/services/apiClients/config.js",
);

test.after(async () => cleanupIsolatedState(isolatedState));

test("parses RSS items, Atom entries, entities, and images", () => {
  const articles = rssNews.parseRssFeed(`
    <rss><channel><title>Example Music</title><item>
      <title><![CDATA[Artist One &amp; the new album]]></title>
      <description>A new story.</description>
      <link>https://example.test/story</link>
      <pubDate>2026-08-07T12:00:00Z</pubDate>
      <media:content url="https://example.test/image.jpg" />
    </item></channel></rss>
  `, { name: "Example", url: "https://example.test/feed" });

  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Artist One & the new album");
  assert.equal(articles[0].source, "Example Music");
  assert.equal(articles[0].imageUrl, "https://example.test/image.jpg");
});

test("fetches and normalizes RSS feed articles", async (t) => {
  t.mock.method(axios, "get", async () => ({
    data: "<feed><title>Feed Name</title><entry><title>Artist One news</title><link href=\"https://example.test/story\"/><summary>News</summary></entry></feed>",
  }));

  const [article] = await rssNews.fetchRssFeed({ name: "Feed", url: "https://example.test/rss" });
  assert.equal(article.title, "Artist One news");
  assert.equal(article.url, "https://example.test/story");
  assert.equal(article.source, "Feed Name");
});

test("ignores tracking pixels and badges when finding RSS HTML images", () => {
  const articles = rssNews.parseRssFeed(`
    <rss><channel><title>Example</title><item>
      <title>Artist news</title><link>https://example.test/story</link>
      <content:encoded><![CDATA[
        <img src="https://example.test/tracking-pixel.png">
        <img src="https://example.test/article.jpg">
      ]]></content:encoded>
    </item></channel></rss>
  `, { name: "Example", url: "https://example.test/feed" });
  assert.equal(articles[0].imageUrl, "https://example.test/article.jpg");
});

test("matches only artist mentions and applies publisher blocks", () => {
  const result = newsService.matchNewsArticles([
    {
      id: "good",
      title: "Artist One announces a new album",
      description: "A music story.",
      source: "Good Music",
      url: "https://good.test/story",
      publishedAt: "2026-08-07T12:00:00Z",
    },
    {
      id: "bad",
      title: "Artist One company reports record earnings",
      description: "A business story.",
      source: "Bad News",
      url: "https://bad.test/story",
      publishedAt: "2026-08-07T11:00:00Z",
    },
    {
      id: "description-only",
      title: "A different artist announces a tour",
      description: "Artist One appears in the article body.",
      source: "Good Music",
      url: "https://good.test/other-story",
      publishedAt: "2026-08-07T10:00:00Z",
    },
  ], [{ artistMbid: "mbid-1", artistName: "Artist One", newsType: "library" }], ["Bad News"]);

  assert.deepEqual(result.map((article) => article.title), ["Artist One announces a new album"]);
  assert.equal(result[0].newsType, "library");
});

test("uses curated RSS groups and preserves custom feeds", () => {
  const settings = config.getNewsSettings();
  assert.ok(settings.feeds.length >= 10);
  assert.ok(settings.feeds.some((feed) => feed.group === "indie"));
  const customFeed = config.normalizeNewsFeeds([
    { name: "Custom", url: "https://custom.test/feed", group: "custom" },
  ]).find((feed) => feed.url === "https://custom.test/feed");
  assert.equal(customFeed.builtIn, false);
});

test("ignores malformed stored RSS feed URLs", () => {
  const feeds = config.normalizeNewsFeeds([{ name: "Broken", url: "http://", group: "custom" }]);
  assert.equal(feeds.some((feed) => feed.name === "Broken"), false);
});
