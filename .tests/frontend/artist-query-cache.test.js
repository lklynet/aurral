import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("artist REST details coalesce identical requests through Query", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ id: "artist-1", name: "Artist" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await vite.close();
  });

  const { getArtistDetails } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/artists.js?artist-query-cache-test",
  );
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
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
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
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await vite.close();
  });

  const { getArtistCover } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/artists.js?artist-cover-refresh-test",
  );
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
