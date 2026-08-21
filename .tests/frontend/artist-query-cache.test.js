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
