import { requireFixture } from "./playlists/fixtures.ts";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import axios from "../lib/axiosFetch.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  rssNews,
  newsService,
  config,
  { api },
  inboxService,
] = await setupIsolatedBackend(
  "rss-news-service",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/rssNews.ts"),
  () => import("../backend/services/newsService.ts"),
  () => import("../backend/services/apiClients/config.ts"),
  () => import("../backend/routes/api.ts"),
  () => import("../backend/services/inboxService.ts"),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const TAGGED_FEED = "https://tagged.test/feed";
const UNTAGGED_FEED = "https://untagged.test/feed";

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

const configureFeeds = (urls: string[]) =>
  dbOps.updateSettings({
    integrations: {
      news: {
        enabled: true,
        groups: Object.fromEntries(config.DEFAULT_NEWS_GROUPS.map((group) => [group.id, false])),
        feeds: urls.map((url) => ({
          id: url,
          name: url,
          url,
          group: "custom",
          enabled: true,
          builtIn: false,
        })),
      },
    },
  });

const addLibraryArtists = (names: string[]) => {
  const insert = db.prepare(
    "INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES (?, ?, '', '')",
  );
  for (const name of names) insert.run(`name:${name}`, name);
};

const rss = (
  items: {
    title: string;
    url: string;
    categories?: string[];
    publishedAt?: number;
    imageUrl?: string;
  }[],
) =>
  `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Test Feed</title>${items
    .map(
      ({ title, url, categories = [], publishedAt = Date.now(), imageUrl }) => `<item>
    <title><![CDATA[${title}]]></title>
    <link>${url}</link>
    <pubDate>${new Date(publishedAt).toUTCString()}</pubDate>
    ${categories.map((category) => `<category><![CDATA[${category}]]></category>`).join("")}
    ${imageUrl ? `<media:content url="${imageUrl}" />` : ""}
  </item>`,
    )
    .join("")}</channel></rss>`;

const serveFeeds = (t: import("vite-plus/test").TestContext, responses: Record<string, string>) =>
  vi.spyOn(axios, "get").mockImplementation(async (url) => {
    const response = responses[url];
    if (response === undefined) throw new Error(`Unexpected request: ${url}`);
    return { data: response, status: 200, statusText: "OK", headers: {} };
  });

const story = (title: string, extra: { categories?: string[]; publishedAt?: number } = {}) => ({
  title,
  url: `https://news.test/${encodeURIComponent(title)}`,
  imageUrl: "https://news.test/image.jpg",
  ...extra,
});

const getTitles = async (options: { mode?: "matched" | "top" } = {}) =>
  (await newsService.getNewsForUser({ userId: null, limit: 100, ...options })).articles.map(
    ({ title }) => title,
  );

test("parses RSS items, Atom entries, entities, categories, and images", () => {
  const articles = rssNews.parseRssFeed(
    `
    <rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Example Music</title><item>
      <title><![CDATA[Artist One &amp; the new album]]></title>
      <description>&lt;p&gt;A new R&amp;amp;B story.&lt;/p&gt;</description>
      <link>https://example.test/story?utm_source=rss&#038;utm_medium=rss</link>
      <pubDate>2026-08-07T12:00:00Z</pubDate>
      <category><![CDATA[Artist One]]></category>
      <category>New Music</category>
      <media:content url="https://example.test/image.jpg" />
    </item></channel></rss>
  `,
    { url: "https://example.test/feed" },
  );

  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Artist One & the new album");
  assert.equal(articles[0].description, "A new R&B story.");
  assert.deepEqual(articles[0].categories, ["Artist One", "New Music"]);
  assert.equal(articles[0].url, "https://example.test/story?utm_source=rss&utm_medium=rss");
  assert.equal(articles[0].source, "Example Music");
  assert.equal(articles[0].imageUrl, "https://example.test/image.jpg");
});

test("fetches RSS feed articles under the feed's configured name", async () => {
  vi.spyOn(axios, "get").mockImplementation(async () => ({
    status: 200,
    statusText: "OK",
    headers: {},
    data: '<feed><title>Feed Name</title><entry><title>Artist One news</title><link href="https://example.test/story"/><summary>News</summary></entry></feed>',
  }));

  const [article] = await rssNews.fetchRssFeed({ name: "Feed", url: "https://example.test/rss" });
  assert.equal(article.title, "Artist One news");
  assert.equal(article.url, "https://example.test/story");
  assert.equal(article.source, "Feed");
});

test("ignores tracking pixels and badges when finding RSS HTML images", () => {
  const articles = rssNews.parseRssFeed(
    `
    <rss><channel><title>Example</title><item>
      <title>Artist news</title><link>https://example.test/story</link>
      <content:encoded><![CDATA[
        <img src="https://example.test/tracking-pixel.png">
        <img src="https://example.test/article.jpg">
      ]]></content:encoded>
    </item></channel></rss>
  `,
    { name: "Example", url: "https://example.test/feed" },
  );
  assert.equal(articles[0].imageUrl, "https://example.test/article.jpg");
});

test("tags stories with library artists by whole name, category, and accent-free spelling", async (t) => {
  configureFeeds([TAGGED_FEED, UNTAGGED_FEED]);
  addLibraryArtists([
    "Air",
    "Live",
    "Oasis",
    "Björk",
    "U2",
    "Nas",
    "Lil Nas X",
    "Wet Leg",
    "Big Thief",
    "Ghost",
    "The Killers",
  ]);
  serveFeeds(t, {
    [TAGGED_FEED]: rss([
      story("Clairo announces fairytale tour", { categories: ["Clairo"] }),
      story("How to Live Stream the festival", { categories: ["Festivals"] }),
      story("Noel Gallagher guitar sells at auction", { categories: ["Oasis"] }),
      story("The Killers announce anniversary reissue", { categories: ["Reissues"] }),
    ]),
    [UNTAGGED_FEED]: rss([
      story("Bjork shares new single"),
      story("U2 announce residency"),
      story("Ghost announce world tour"),
      story("Lil Nas X returns with new song"),
      story("Wet Leg and Big Thief share split single"),
    ]),
  });

  await newsService.refreshNewsFeeds();
  const { articles } = await newsService.getNewsForUser({ userId: null, limit: 100 });
  const tags = Object.fromEntries(
    articles.map((article) => [
      article.title,
      article.artists.map(({ artistName }) => artistName).sort(),
    ]),
  );

  assert.deepEqual(tags, {
    "Noel Gallagher guitar sells at auction": ["Oasis"],
    "The Killers announce anniversary reissue": ["The Killers"],
    "Bjork shares new single": ["Björk"],
    "U2 announce residency": ["U2"],
    "Ghost announce world tour": ["Ghost"],
    "Lil Nas X returns with new song": ["Lil Nas X"],
    "Wet Leg and Big Thief share split single": ["Big Thief", "Wet Leg"],
  });
  assert.equal(
    articles.every((article) => article.artists[0].newsType === "library"),
    true,
  );
  assert.equal((await getTitles({ mode: "top" })).length, 9);
});

test("keeps stories after they leave a feed and shows new matches right after a refresh", async (t) => {
  configureFeeds([UNTAGGED_FEED]);
  addLibraryArtists(["Wet Leg"]);
  const responses = {
    [UNTAGGED_FEED]: rss([
      story("Wet Leg announce tour", { publishedAt: Date.now() - DAY_MS }),
      story("Wet Leg demo resurfaces", { publishedAt: Date.now() - 40 * DAY_MS }),
    ]),
  };
  serveFeeds(t, responses);
  await newsService.refreshNewsFeeds();
  assert.deepEqual(await getTitles(), ["Wet Leg announce tour"]);

  responses[UNTAGGED_FEED] = rss([story("Wet Leg share new single")]);
  await newsService.refreshNewsFeeds();

  assert.deepEqual(await getTitles(), ["Wet Leg share new single", "Wet Leg announce tour"]);
});

test("pages through matched stories", async (t) => {
  configureFeeds([UNTAGGED_FEED]);
  addLibraryArtists(["Wet Leg"]);
  serveFeeds(t, {
    [UNTAGGED_FEED]: rss(
      [1, 2, 3, 4, 5].map((day) =>
        story(day % 2 ? `Wet Leg story ${day}` : `Unrelated story ${day}`, {
          publishedAt: Date.now() - day * DAY_MS,
        }),
      ),
    ),
  });
  await newsService.refreshNewsFeeds();

  const first = await newsService.getNewsForUser({ userId: null, limit: 2 });
  const second = await newsService.getNewsForUser({ userId: null, limit: 2, offset: 2 });

  assert.deepEqual(
    first.articles.map(({ title }) => title),
    ["Wet Leg story 1", "Wet Leg story 3"],
  );
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    second.articles.map(({ title }) => title),
    ["Wet Leg story 5"],
  );
  assert.equal(second.hasMore, false);
});

test("keeps cached stories and warns when every feed fails", async (t) => {
  configureFeeds([UNTAGGED_FEED]);
  const responses: Record<string, string> = { [UNTAGGED_FEED]: rss([story("Cached story")]) };
  serveFeeds(t, responses);
  await newsService.refreshNewsFeeds();
  assert.equal(
    (await newsService.getNewsForUser({ userId: null, mode: "top" })).refresh.warning,
    null,
  );

  delete responses[UNTAGGED_FEED];
  await newsService.refreshNewsFeeds();
  const result = await newsService.getNewsForUser({ userId: null, mode: "top" });

  assert.deepEqual(
    result.articles.map(({ title }) => title),
    ["Cached story"],
  );
  assert.match(requireFixture(result.refresh.warning), /could not be refreshed/);
});

test("looks up a missing story image once", async () => {
  configureFeeds([UNTAGGED_FEED]);
  const storyUrl = "https://93.184.216.34/story";
  const storyRequests: string[] = [];
  vi.spyOn(axios, "get").mockImplementation(
    requireFixture(async (url) => {
      if (url === UNTAGGED_FEED)
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          data: rss([{ title: "Story without image", url: storyUrl }]),
        };
      storyRequests.push(url);
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: '<meta property="og:image" content="https://93.184.216.34/cover.jpg">',
      };
    }),
  );

  await newsService.refreshNewsFeeds();
  await newsService.refreshNewsFeeds();
  const [article] = (await newsService.getNewsForUser({ userId: null, mode: "top" })).articles;

  assert.deepEqual(storyRequests, [storyUrl]);
  assert.ok(article.imageUrl);
});

test("only admins can disable a feed, and its stories leave the news list", async (t: import("vite-plus/test").TestContext) => {
  configureFeeds([TAGGED_FEED, UNTAGGED_FEED]);
  serveFeeds(t, {
    [TAGGED_FEED]: rss([story("Tagged feed story")]),
    [UNTAGGED_FEED]: rss([story("Untagged feed story")]),
  });
  await newsService.refreshNewsFeeds();
  const disable = (user: ReturnType<typeof testUser>) =>
    signedInAs(user)
      .route("/", api)
      .request("/news/feeds/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl: UNTAGGED_FEED }),
      });

  assert.equal((await disable(testUser(2))).status, 403);
  assert.equal((await getTitles({ mode: "top" })).length, 2);

  assert.equal((await disable(testUser(1, { role: "admin" }))).status, 200);
  assert.deepEqual(await getTitles({ mode: "top" }), ["Tagged feed story"]);
});

test("the inbox lists a story under each library artist it mentions", async (t) => {
  configureFeeds([UNTAGGED_FEED]);
  addLibraryArtists(["Wet Leg", "Big Thief"]);
  serveFeeds(t, { [UNTAGGED_FEED]: rss([story("Wet Leg and Big Thief share split single")]) });
  await newsService.refreshNewsFeeds();
  dbOps.updateSettings({
    inbox: { releases: false, shows: false, discoveries: false, news: true },
  });
  const userId = userOps.createUser("news-inbox-user", "password-hash")!.id;

  await inboxService.refreshInboxForUser(userId, { force: true });

  const items = dbOps.getInboxItems(userId, { kinds: ["news"] });
  assert.deepEqual(items.map((item) => requireFixture(item).metadata.artistName).sort(), [
    "Big Thief",
    "Wet Leg",
  ]);
  assert.deepEqual(
    items.map((item) => {
      const articles = requireFixture(item).metadata.articles;
      assert.ok(Array.isArray(articles));
      return articles.map(({ title }: { title: string }) => title);
    }),
    [["Wet Leg and Big Thief share split single"], ["Wet Leg and Big Thief share split single"]],
  );
});

test("drops retired built-in feeds from saved settings instead of keeping them as custom feeds", () => {
  const feeds = config.normalizeNewsFeeds([
    { name: "Mixmag", url: "https://mixmag.net/feed", group: "electronic", enabled: true },
  ]);
  assert.equal(
    feeds.some((feed) => feed.url === "https://mixmag.net/feed"),
    false,
  );
});

test("ignores malformed stored RSS feed URLs", () => {
  const feeds = config.normalizeNewsFeeds([{ name: "Broken", url: "http://", group: "custom" }]);
  assert.equal(
    feeds.some((feed) => feed.name === "Broken"),
    false,
  );
});
