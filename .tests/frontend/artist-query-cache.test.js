import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("artist REST details coalesce identical requests through Query", async (t) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ id: "artist-1", name: "Artist" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getArtistDetails } = await import("../../frontend/src/utils/api/endpoints/artists.js");
  const options = { mode: "core", releaseTypes: ["Album"] };
  const [first, second] = await Promise.all([
    getArtistDetails("artist-1", "Artist", options),
    getArtistDetails("artist-1", "Artist", options),
  ]);

  assert.equal(requestCount, 1);
  assert.deepEqual(first, second);
  assert.equal(first.id, "artist-1");
});

test("artist cover refreshes do not reuse or get overwritten by normal requests", async (t) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  let resolveNormal;
  const response = (image) =>
    new Response(JSON.stringify({ images: [{ image, front: true }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Promise((resolve) => {
        resolveNormal = () => resolve(response("https://images.example/normal.jpg"));
      });
    }
    return response("https://images.example/refreshed.jpg");
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getArtistCover } = await import("../../frontend/src/utils/api/endpoints/artists.js");
  const normal = getArtistCover("artist-1", "Artist");
  while (!resolveNormal) await new Promise((resolve) => setImmediate(resolve));
  const refresh = getArtistCover("artist-1", "Artist", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);

  resolveNormal();
  const [normalResult, refreshedResult] = await Promise.all([normal, refresh]);
  assert.equal(normalResult.images[0].image, "https://images.example/normal.jpg");
  assert.equal(refreshedResult.images[0].image, "https://images.example/refreshed.jpg");
  assert.equal(requestCount, 2);
  const cached = await getArtistCover("artist-1", "Artist");
  assert.equal(cached.images[0].image, "https://images.example/refreshed.jpg");
});

test("normal cover requests wait for active artist and release-group refreshes", async (t) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  const requestCounts = new Map();
  const releaseRefreshes = new Map();
  const response = (key, image) =>
    new Response(
      JSON.stringify(
        key === "artist"
          ? { images: [{ image, front: true }] }
          : { imageUrl: image, notFound: false, transientError: false },
      ),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  globalThis.fetch = async (url) => {
    const key = String(url).includes("/release-group/") ? "release-group" : "artist";
    const requestCount = (requestCounts.get(key) || 0) + 1;
    requestCounts.set(key, requestCount);
    if (requestCount === 1) {
      return response(key, `https://images.example/${key}-stale.jpg`);
    }
    return new Promise((resolve) => {
      releaseRefreshes.set(key, () =>
        resolve(response(key, `https://images.example/${key}-fresh.jpg`)),
      );
    });
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getArtistCover, getReleaseGroupCover } = await import("../../frontend/src/utils/api/endpoints/artists.js");
  const cases = [
    {
      key: "artist",
      getCover: (refresh = false) => getArtistCover("artist-priority", "Artist", refresh),
      getImage: (result) => result.images[0].image,
    },
    {
      key: "release-group",
      getCover: (refresh = false) =>
        getReleaseGroupCover("release-priority", { bypassCache: refresh }),
      getImage: (result) => result.imageUrl,
    },
  ];

  for (const { key, getCover, getImage } of cases) {
    const stale = await getCover();
    assert.equal(getImage(stale), `https://images.example/${key}-stale.jpg`);

    const refresh = getCover(true);
    while (!releaseRefreshes.has(key)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const normal = getCover();
    releaseRefreshes.get(key)();

    const [refreshed, normalResult] = await Promise.all([refresh, normal]);
    assert.equal(getImage(refreshed), `https://images.example/${key}-fresh.jpg`);
    assert.equal(getImage(normalResult), `https://images.example/${key}-fresh.jpg`);
    assert.equal(requestCounts.get(key), 2);
  }
});
