import assert from "node:assert/strict";
import test from "node:test";
import axios from "../lib/axiosFetch.js";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, newsApi, newsService] = await setupIsolatedBackend(
  "news-service",
  "backend/db/helpers/index.js",
  "backend/services/apiClients/newsapi.js",
  "backend/services/newsService.js",
);

const resetNewsState = () => {
  dbOps.setJSONSetting("news:refreshState", null);
  newsApi.newsCache.flushAll();
};

test.beforeEach(() => {
  resetNewsState();
});

test.after(async () => {
  resetNewsState();
  await cleanupIsolatedState(isolatedState);
});

test("fetchNewsForArtists normalizes artist metadata and removes duplicate stories", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });
  newsApi.newsCache.flushAll();

  let calls = 0;
  t.mock.method(axios, "get", async () => {
    calls += 1;
    return {
      data: {
        articles: [
          {
            title: "Shared music story",
            description: "A recent story.",
            url: "https://news.example.test/shared-story",
            source: { name: "Example News" },
            publishedAt: "2026-08-05T12:00:00Z",
            urlToImage: "https://images.example.test/story.jpg",
          },
        ],
      },
    };
  });

  const result = await newsService.fetchNewsForArtists([
    { foreignArtistId: "artist-one", artistName: "Artist One" },
    { mbid: "artist-two", name: "Artist Two" },
  ]);

  assert.equal(result.configured, true);
  assert.equal(result.artistCount, 2);
  assert.equal(calls, 2);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].artistName, "Artist One");
  assert.equal(result.articles[0].artistMbid, "artist-one");
  assert.equal(result.articles[0].title, "Shared music story");
});

test("news searches only the artist phrase and reuses the hourly query cache", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });
  newsApi.newsCache.flushAll();

  let calls = 0;
  let params;
  t.mock.method(axios, "get", async (_url, config) => {
    calls += 1;
    params = config.params;
    return { data: { articles: [] } };
  });

  await newsApi.newsApiSearchArtist("David Bowie");
  await newsApi.newsApiSearchArtist("David Bowie");

  assert.equal(calls, 1);
  assert.equal(params.q, '"David Bowie"');
  assert.equal(params.searchIn, "title,description");
});

test("does not turn an all-artist NewsAPI failure into an empty success", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });
  newsApi.newsCache.flushAll();
  t.mock.method(axios, "get", async () => {
    throw new Error("NewsAPI rate limited");
  });

  await assert.rejects(
    newsService.fetchNewsForArtists([
      { foreignArtistId: "artist-one", artistName: "Artist One" },
      { foreignArtistId: "artist-two", artistName: "Artist Two" },
    ]),
    /NewsAPI failed for every library artist/,
  );
});

test("keeps cached stories when NewsAPI reaches its rate limit", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });

  let rateLimited = false;
  t.mock.method(axios, "get", async () => {
    if (rateLimited) {
      const error = new Error("rate limited");
      error.response = { status: 429, data: { code: "rateLimited" } };
      throw error;
    }
    return {
      data: {
        articles: [
          {
            title: "Cached story",
            url: "https://news.example.test/cached-story",
            source: { name: "Example News" },
            publishedAt: "2026-08-05T12:00:00Z",
          },
        ],
      },
    };
  });

  const artist = [{ foreignArtistId: "artist-one", artistName: "Artist One" }];
  await newsService.fetchNewsForArtists(artist);
  const state = dbOps.getJSONSetting("news:refreshState");
  state.artists["artist-one"].checkedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
  state.artists["artist-one"].nextAttemptAt = Date.now() - 1;
  dbOps.setJSONSetting("news:refreshState", state);
  newsApi.newsCache.flushAll();
  rateLimited = true;

  const result = await newsService.fetchNewsForArtists(artist);
  assert.equal(result.articles[0].title, "Cached story");
  assert.match(result.refresh.warning, /rate limit reached/);
  assert.ok(result.refresh.rateLimitedUntil > Date.now());
});

test("filters blocked publishers before returning library news", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });
  newsApi.newsCache.flushAll();
  t.mock.method(axios, "get", async () => ({
    data: {
      articles: [
        {
          title: "Good story",
          url: "https://good.example/story",
          source: { name: "Good News" },
          publishedAt: "2026-08-05T12:00:00Z",
        },
        {
          title: "Bad result",
          url: "https://rlsbb.cc/result",
          source: { name: "Rlsbb.cc" },
          publishedAt: "2026-08-05T11:00:00Z",
        },
      ],
    },
  }));

  const result = await newsService.fetchNewsForArtists(
    [{ foreignArtistId: "artist-one", artistName: "Artist One" }],
    { blockedPublishers: ["rlsbb.cc"] },
  );

  assert.deepEqual(result.articles.map((article) => article.source), ["Good News"]);
});

test("rotates large libraries through a shared 100-call budget", async (t) => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      newsapi: { apiKey: "test-news-key", language: "en", domains: "" },
    },
  });

  let calls = 0;
  const queriedArtists = [];
  t.mock.method(axios, "get", async (_url, config) => {
    calls += 1;
    queriedArtists.push(config.params.q);
    return {
      data: {
        articles: [
          {
            title: config.params.q,
            url: `https://news.example.test/${calls}`,
            source: { name: "Example News" },
            publishedAt: "2026-08-05T12:00:00Z",
          },
        ],
      },
    };
  });

  const artists = Array.from({ length: 110 }, (_, index) => ({
    foreignArtistId: `artist-${index}`,
    artistName: `Artist ${index}`,
  }));

  const first = await newsService.fetchNewsForArtists(artists);
  assert.equal(calls, 25);
  assert.equal(first.refresh.checkedArtistCount, 25);
  assert.equal(first.refresh.queuedArtistCount, 85);
  assert.equal(first.refresh.callsRemaining, 75);

  await newsService.fetchNewsForArtists(artists);
  await newsService.fetchNewsForArtists(artists);
  await newsService.fetchNewsForArtists(artists);
  assert.equal(calls, 100);
  assert.equal(new Set(queriedArtists).size, 100);

  const exhausted = await newsService.fetchNewsForArtists(artists);
  assert.equal(calls, 100);
  assert.equal(exhausted.refresh.callsRemaining, 0);
  assert.match(exhausted.refresh.warning, /budget exhausted/);
});
