import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("artist REST details coalesce identical requests through Query", async (t: import("vite-plus/test").TestContext) => {
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

  const { getArtistDetails } = await import("../../frontend/src/utils/api/endpoints/artists.ts");
  const options = { mode: "core", releaseTypes: ["Album"] };
  const [first, second] = await Promise.all([
    getArtistDetails("artist-1", "Artist", options),
    getArtistDetails("artist-1", "Artist", options),
  ]);

  assert.equal(requestCount, 1);
  assert.deepEqual(first, second);
  assert.equal(first.id, "artist-1");
});

test("artist cover refreshes do not reuse or get overwritten by normal requests", async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  let resolveNormal: (() => void) | undefined;
  const response = (image: string) =>
    new Response(JSON.stringify({ images: [{ image, front: true }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Promise<Response>((resolve) => {
        resolveNormal = () => resolve(response("https://images.example/normal.jpg"));
      });
    }
    return response("https://images.example/refreshed.jpg");
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getArtistCover } = await import("../../frontend/src/utils/api/endpoints/artists.ts");
  const normal = getArtistCover("artist-1", "Artist");
  while (!resolveNormal) await new Promise<void>((resolve) => setImmediate(resolve));
  const refresh = getArtistCover("artist-1", "Artist", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);

  resolveNormal();
  const [normalResult, refreshedResult] = await Promise.all([normal, refresh]);
  assert.equal(normalResult.images[0].image, "https://images.example/normal.jpg");
  assert.equal(refreshedResult.images[0].image, "https://images.example/refreshed.jpg");
  assert.equal(requestCount, 2);
  const cached = await getArtistCover("artist-1", "Artist");
  assert.equal(cached.images[0].image, "https://images.example/refreshed.jpg");
});

test("normal cover requests wait for active artist and release-group refreshes", async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  const requestCounts = new Map();
  const releaseRefreshes = new Map();
  const response = (image: string) =>
    Response.json({ images: [{ image, front: true }], notFound: false, transientError: false });
  globalThis.fetch = async (url) => {
    const key = String(url).includes("/release-group/") ? "release-group" : "artist";
    const requestCount = (requestCounts.get(key) || 0) + 1;
    requestCounts.set(key, requestCount);
    if (requestCount === 1) {
      return response(`https://images.example/${key}-stale.jpg`);
    }
    return new Promise<Response>((resolve) => {
      releaseRefreshes.set(key, () => resolve(response(`https://images.example/${key}-fresh.jpg`)));
    });
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getArtistCover, getReleaseGroupCover } =
    await import("../../frontend/src/utils/api/endpoints/artists.ts");
  const cases = [
    {
      key: "artist",
      getCover: (refresh: boolean = false) => getArtistCover("artist-priority", "Artist", refresh),
    },
    {
      key: "release-group",
      getCover: (refresh = false) =>
        getReleaseGroupCover("release-priority", { bypassCache: refresh }),
    },
  ];

  const imageOf = (result: { images: { image: string | null }[] }) => result.images[0].image;
  for (const { key, getCover } of cases) {
    const stale = await getCover();
    assert.equal(imageOf(stale), `https://images.example/${key}-stale.jpg`);

    const refresh = getCover(true);
    while (!releaseRefreshes.has(key)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const normal = getCover();
    releaseRefreshes.get(key)();

    const [refreshed, normalResult] = await Promise.all([refresh, normal]);
    assert.equal(imageOf(refreshed), `https://images.example/${key}-fresh.jpg`);
    assert.equal(imageOf(normalResult), `https://images.example/${key}-fresh.jpg`);
    assert.equal(requestCounts.get(key), 2);
  }
});

test("batch and single release-group cover requests each get their own response shape", async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.includes("/release-groups/covers")
      ? {
          covers: {
            "rg-batch-first": { image: "https://images.example/batch-1.jpg", notFound: false },
            "rg-single-first": { image: "https://images.example/batch-2.jpg", notFound: false },
          },
        }
      : { images: [{ image: "https://images.example/single.jpg", front: true }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.onTestFinished(async () => {
    globalThis.fetch = previousFetch;
  });

  const { getReleaseGroupCover, getReleaseGroupCoversBatch } =
    await import("../../frontend/src/utils/api/endpoints/artists.ts");
  const names = { artistName: "Artist", albumTitle: "Album" };

  await getReleaseGroupCoversBatch([{ mbid: "rg-batch-first", ...names }]);
  const single = await getReleaseGroupCover("rg-batch-first", names);
  assert.equal(single?.images?.[0]?.image, "https://images.example/single.jpg");

  await getReleaseGroupCover("rg-single-first", names);
  const batch = await getReleaseGroupCoversBatch([{ mbid: "rg-single-first", ...names }]);
  assert.equal(batch["rg-single-first"]?.image, "https://images.example/batch-2.jpg");
});
