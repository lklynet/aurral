import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

async function setup(t, respond) {
  const vite = await startFrontendServer();
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://aurral.test");
    requests.push(url.pathname + url.search);
    const { status = 200, body } = respond(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const { prefetchRoute } = await vite.ssrLoadModule("/src/navigation/routePrefetch.js");
  const { queryClient } = await vite.ssrLoadModule("/src/queryClient.js");
  const queryOptions = await vite.ssrLoadModule("/src/queryOptions.js");
  t.after(async () => {
    queryClient.clear();
    globalThis.fetch = previousFetch;
    delete globalThis.document;
    await vite.close();
  });
  return { vite, requests, prefetchRoute, queryClient, queryOptions };
}

const apiRequests = (requests, fragment) => requests.filter((path) => path.includes(fragment));

test("hovering a playlist link fetches it once and the page reuses the result", async (t) => {
  const playlist = { id: "42", name: "Prefetched", tracks: [] };
  const { requests, prefetchRoute, queryClient, queryOptions } = await setup(t, () => ({ body: playlist }));

  await Promise.all([
    prefetchRoute("/discover/playlists/deezer/42", { userId: "user-1" }),
    prefetchRoute("/discover/playlists/deezer/42", { userId: "user-1" }),
  ]);
  assert.equal(apiRequests(requests, "/discover/editorial/42").length, 1);

  await prefetchRoute("/discover/playlists/deezer/42", { userId: "user-1" });
  const pageData = await queryClient.fetchQuery(
    queryOptions.editorialPlaylistQueryOptions("user-1", "42"),
  );
  assert.deepEqual(pageData, playlist);
  assert.equal(apiRequests(requests, "/discover/editorial/42").length, 1);
});

test("a failed prefetch is not retried on the next hover", async (t) => {
  const { requests, prefetchRoute, queryClient, queryOptions } = await setup(t, () => ({
    status: 503,
    body: { error: "unavailable" },
  }));

  await prefetchRoute("/artist/a/release/rg-1");
  await prefetchRoute("/artist/a/release/rg-1");
  assert.equal(apiRequests(requests, "/artists/release-group/rg-1").length, 1);

  await assert.rejects(queryClient.fetchQuery(queryOptions.releaseGroupDetailsQueryOptions("rg-1")));
  assert.equal(apiRequests(requests, "/artists/release-group/rg-1").length, 2);
});

test("no prefetch runs while the tab is hidden or for links outside the app", async (t) => {
  const { requests, prefetchRoute } = await setup(t, () => ({ body: {} }));
  globalThis.document = { visibilityState: "hidden" };
  await prefetchRoute("/discover/playlists/deezer/7", { userId: "user-1" });
  delete globalThis.document;
  await prefetchRoute("https://example.com/discover/playlists/deezer/7");
  await prefetchRoute("//example.com/discover/playlists/deezer/7");
  assert.deepEqual(requests, []);
});

test("a library album prefetch matches the page query whatever its list state", async (t) => {
  const { vite, requests, prefetchRoute, queryClient } = await setup(t, (url) => ({
    body: url.pathname.includes("/library")
      ? { tracks: [{ id: 1, title: "Track" }], total: 1 }
      : {},
  }));
  const { libraryViewQueryOptions } = await vite.ssrLoadModule("/src/pages/libraryViewQuery.js");

  await prefetchRoute("/library/album/7");
  const prefetched = requests.length;
  assert.ok(prefetched > 0);

  const pageOptions = libraryViewQueryOptions({
    preview: false,
    section: "albums",
    albumId: "7",
    pageIndex: 3,
    query: "",
    genre: "rock",
    sort: "newest",
    direction: "desc",
  });
  const view = await queryClient.fetchQuery(pageOptions);
  assert.equal(view.library.tracks.length, 1);
  assert.equal(requests.length, prefetched);
});

test("a route counts as ready only after its page code has loaded", async (t) => {
  const { vite, prefetchRoute } = await setup(t, () => ({ body: {} }));
  const { isRouteModuleLoaded } = await vite.ssrLoadModule("/src/navigation/routePrefetch.js");

  assert.equal(isRouteModuleLoaded("/discover/news"), false);
  await prefetchRoute("/discover/news");
  assert.equal(isRouteModuleLoaded("/discover/news"), true);
  assert.equal(isRouteModuleLoaded("/blocklist"), false);
  assert.equal(isRouteModuleLoaded("https://example.com/discover/news"), false);
});
