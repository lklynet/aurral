import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const openFavoritesHarness = async (t, suffix) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  const favorites = await vite.ssrLoadModule(`/src/utils/api/endpoints/library.js?${suffix}`);
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  });
  t.after(() => vite.close());
  globalThis.fetch = async (_url, init = {}) => new Promise((resolve) => {
    requests.push({ method: init.method || "GET", resolve });
  });
  const waitForRequests = async (count) => {
    while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
  };

  return { ...favorites, queryClient, queryKeys, requests, waitForRequests };
};

test("an older favorites read cannot overwrite a newer mutation cache", async (t) => {
  const { getLibraryFavorites, updateLibraryFavorites, requests, waitForRequests } =
    await openFavoritesHarness(t, "favorites-race-test");

  const staleFavorites = { artist: [], album: [], song: [], library: { tracks: [] } };
  const mutationResponse = {
    artist: [],
    album: [],
    song: [{ id: "song:1" }],
    changedIds: ["song:1"],
  };
  const freshFavorites = { artist: [], album: [], song: ["song:1"], library: { tracks: ["fresh"] } };
  const read = getLibraryFavorites();
  await waitForRequests(1);
  const mutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(2);

  requests[1].resolve(jsonResponse(mutationResponse));
  await waitForRequests(3);
  requests[2].resolve(jsonResponse(freshFavorites));
  assert.deepEqual(await mutation, mutationResponse);
  requests[0].resolve(jsonResponse(staleFavorites));
  assert.deepEqual(await read, freshFavorites);
  assert.deepEqual(await getLibraryFavorites(), freshFavorites);
  assert.equal(requests.length, 3);
});

test("a favorites read waits when it completes before the mutation refresh", async (t) => {
  const { getLibraryFavorites, updateLibraryFavorites, requests, waitForRequests } =
    await openFavoritesHarness(t, "favorites-read-before-refresh-test");
  const read = getLibraryFavorites();
  await waitForRequests(1);
  const mutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(2);

  let readSettled = false;
  const pendingRead = read.then((value) => {
    readSettled = true;
    return value;
  });
  requests[0].resolve(jsonResponse({ version: "stale" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readSettled, false);

  requests[1].resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(3);
  const freshFavorites = { version: "fresh" };
  requests[2].resolve(jsonResponse(freshFavorites));

  assert.deepEqual(await pendingRead, freshFavorites);
  await mutation;
});

test("favorite writes serialize and the final refresh includes both mutations", async (t) => {
  const { updateLibraryFavorites, queryClient, queryKeys, requests, waitForRequests } =
    await openFavoritesHarness(t, "favorites-refresh-generation-test");
  const initial = { version: "initial" };
  queryClient.setQueryData(queryKeys.libraryFavorites, initial);

  const firstMutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(1);
  requests[0].resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(2);

  const secondMutation = updateLibraryFavorites(["song:2"], true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);

  requests[1].resolve(jsonResponse({ version: "first" }));
  await waitForRequests(3);
  requests[2].resolve(jsonResponse({ changedIds: ["song:2"] }));
  await waitForRequests(4);

  await firstMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), initial);

  const freshFavorites = { version: "both" };
  requests[3].resolve(jsonResponse(freshFavorites));
  await secondMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), freshFavorites);
});

test("a failed favorite refresh does not block the next queued mutation", async (t) => {
  const { updateLibraryFavorites, queryClient, queryKeys, requests, waitForRequests } =
    await openFavoritesHarness(t, "favorites-refresh-failure-test");
  const initial = { version: "initial" };
  queryClient.setQueryData(queryKeys.libraryFavorites, initial);

  const firstMutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(1);
  requests[0].resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(2);

  const secondMutation = updateLibraryFavorites(["song:2"], true);
  requests[1].resolve(new Response(JSON.stringify({ error: "refresh failed" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  }));
  await firstMutation;
  await waitForRequests(3);
  requests[2].resolve(jsonResponse({ changedIds: ["song:2"] }));
  await waitForRequests(4);

  const freshFavorites = { version: "new" };
  requests[3].resolve(jsonResponse(freshFavorites));
  await secondMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), freshFavorites);
});
