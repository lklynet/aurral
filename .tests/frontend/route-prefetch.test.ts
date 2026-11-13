import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

async function setup(
  t: import("vite-plus/test").TestContext,
  respond: (url: URL) => { status?: number; body: unknown },
) {
  vi.resetModules();
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://aurral.test");
    requests.push(url.pathname + url.search);
    const { status = 200, body } = respond(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const { prefetchRoute } = await import("../../frontend/src/navigation/routePrefetch.ts");
  const { queryClient } = await import("../../frontend/src/queryClient.ts");
  const queryOptions = await import("../../frontend/src/queryOptions.ts");
  t.onTestFinished(async () => {
    queryClient.clear();
    globalThis.fetch = previousFetch;
    vi.unstubAllGlobals();
  });
  return { requests, prefetchRoute, queryClient, queryOptions };
}

const apiRequests = (requests: string[], fragment: string) =>
  requests.filter((path) => path.includes(fragment));

test("hovering a playlist link fetches it once and the page reuses the result", async (t) => {
  const playlist = { id: "42", name: "Prefetched", tracks: [] };
  const { requests, prefetchRoute, queryClient, queryOptions } = await setup(t, () => ({
    body: playlist,
  }));

  await Promise.all([
    prefetchRoute("/discover/playlists/deezer/42", { userId: 1 }),
    prefetchRoute("/discover/playlists/deezer/42", { userId: 1 }),
  ]);
  assert.equal(apiRequests(requests, "/discover/playlists/deezer/42").length, 1);

  await prefetchRoute("/discover/playlists/deezer/42", { userId: 1 });
  const pageData = await queryClient.fetchQuery(
    queryOptions.browsePlaylistQueryOptions(1, "deezer", "42"),
  );
  assert.deepEqual(pageData, playlist);
  assert.equal(apiRequests(requests, "/discover/playlists/deezer/42").length, 1);
});

test("hovering an album never fetches metadata from BrainzMash", async (t) => {
  const { requests, prefetchRoute } = await setup(t, () => ({ body: {} }));

  await prefetchRoute("/album/98c84b94-3445-4dcc-ad01-9e5e3e1271e2");

  assert.equal(apiRequests(requests, "/artists/release-group/").length, 0);
});

test("no prefetch runs while the tab is hidden or for links outside the app", async (t) => {
  const { requests, prefetchRoute } = await setup(t, () => ({ body: {} }));
  vi.stubGlobal("document", { visibilityState: "hidden" });
  await prefetchRoute("/discover/playlists/deezer/7", { userId: 1 });
  vi.unstubAllGlobals();
  await prefetchRoute("https://example.com/discover/playlists/deezer/7");
  await prefetchRoute("//example.com/discover/playlists/deezer/7");
  assert.deepEqual([...requests], []);
});

test("a library album prefetch matches the page query whatever its list state", async (t) => {
  const { requests, prefetchRoute, queryClient } = await setup(t, (url) => ({
    body: url.pathname.includes("/library")
      ? { tracks: [{ id: 1, title: "Track" }], total: 1 }
      : {},
  }));
  const { libraryViewQueryOptions } = await import("../../frontend/src/utils/libraryViewQuery.ts");

  await prefetchRoute("/album/7");
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
  assert.equal(view.library?.tracks.length, 1);
  assert.equal(requests.length, prefetched);
});

test("an album linked by MBID prefetches only its local library view", async (t) => {
  const mbid = "98c84b94-3445-4dcc-ad01-9e5e3e1271e2";
  const { requests, prefetchRoute, queryClient } = await setup(t, (url) => ({
    body: url.pathname.includes("/library") ? { tracks: [], total: 0 } : { id: mbid },
  }));
  const { libraryViewQueryOptions } = await import("../../frontend/src/utils/libraryViewQuery.ts");

  await prefetchRoute(`/album/${mbid}`);
  assert.equal(apiRequests(requests, `/artists/release-group/${mbid}`).length, 0);
  const prefetched = requests.length;

  await queryClient.fetchQuery(libraryViewQueryOptions({ preview: false, albumId: mbid }));
  assert.equal(requests.length, prefetched);
});

test("a route counts as ready only after its page code has loaded", async (t) => {
  const { prefetchRoute } = await setup(t, () => ({ body: {} }));
  const { isRouteModuleLoaded } = await import("../../frontend/src/navigation/routePrefetch.ts");

  assert.equal(isRouteModuleLoaded("/discover/news"), false);
  await prefetchRoute("/discover/news");
  assert.equal(isRouteModuleLoaded("/discover/news"), true);
  assert.equal(isRouteModuleLoaded("/search"), false);
  assert.equal(isRouteModuleLoaded("https://example.com/discover/news"), false);
});

test("an artist's library tracks prefetch filters by artist and matches the page query", async (t) => {
  const { requests, prefetchRoute, queryClient } = await setup(t, () => ({
    body: { kind: "tracks", tracks: [], total: 0 },
  }));
  const { libraryListParams, libraryViewQueryOptions } =
    await import("../../frontend/src/utils/libraryViewQuery.ts");

  await prefetchRoute("/library/tracks?artist=5");
  const prefetched = requests.length;
  assert.ok(apiRequests(requests, "artistId=5").length > 0);

  const { sort, direction, pageIndex, artist } = libraryListParams(
    "tracks",
    new URLSearchParams("artist=5"),
  );
  await queryClient.fetchQuery(
    libraryViewQueryOptions({ section: "tracks", pageIndex, sort, direction, artist }),
  );
  assert.equal(requests.length, prefetched);
});
