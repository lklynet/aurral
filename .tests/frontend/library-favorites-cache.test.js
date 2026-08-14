import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("an older favorites read cannot overwrite a newer mutation cache", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { getLibraryFavorites, updateLibraryFavorites } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/library.js?favorites-race-test",
  );
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init = {}) => new Promise((resolve) => {
    requests.push({ method: init.method || "GET", resolve });
  });
  const waitForRequests = async (count) => {
    while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
  };

  const staleFavorites = { artist: [], album: [], song: [], library: { tracks: [] } };
  const freshFavorites = { artist: [], album: [], song: ["song:1"], library: { tracks: ["fresh"] } };
  const read = getLibraryFavorites();
  await waitForRequests(1);
  const mutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(2);

  requests[1].resolve(jsonResponse(freshFavorites));
  assert.deepEqual(await mutation, freshFavorites);
  requests[0].resolve(jsonResponse(staleFavorites));
  assert.deepEqual(await read, staleFavorites);
  assert.deepEqual(await getLibraryFavorites(), freshFavorites);
  assert.equal(requests.length, 2);
});
