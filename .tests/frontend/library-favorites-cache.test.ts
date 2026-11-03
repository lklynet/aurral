import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { requireFixture } from "../playlists/fixtures.ts";

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const openFavoritesHarness = async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();

  const favorites = await import("../../frontend/src/utils/api/endpoints/library.ts");
  const { queryClient, queryKeys } = await import("../../frontend/src/queryClient.ts");
  const originalFetch = globalThis.fetch;
  const requests: { method: string; resolve: (value: Response | PromiseLike<Response>) => void }[] =
    [];
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  });
  globalThis.fetch = async (_url, init = {}) =>
    new Promise<Response>((resolve) => {
      requests.push({ method: init.method || "GET", resolve });
    });
  const waitForRequests = async (count: number) => {
    while (requests.length < count) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  return { ...favorites, queryClient, queryKeys, requests, waitForRequests };
};

test("an older favorites read cannot overwrite a newer mutation cache", async (t) => {
  const { getLibraryFavorites, updateLibraryFavorites, requests, waitForRequests } =
    await openFavoritesHarness(t);

  const staleFavorites = { artist: [], album: [], song: [], library: { tracks: [] } };
  const mutationResponse = {
    artist: [],
    album: [],
    song: [{ id: "song:1" }],
    changedIds: ["song:1"],
  };
  const freshFavorites = {
    artist: [],
    album: [],
    song: ["song:1"],
    library: { tracks: ["fresh"] },
  };
  const read = getLibraryFavorites();
  await waitForRequests(1);
  const mutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(2);

  requireFixture(requests[1]).resolve(jsonResponse(mutationResponse));
  await waitForRequests(3);
  requireFixture(requests[2]).resolve(jsonResponse(freshFavorites));
  assert.deepEqual(await mutation, mutationResponse);
  requireFixture(requests[0]).resolve(jsonResponse(staleFavorites));
  assert.deepEqual(await read, freshFavorites);
  assert.deepEqual(await getLibraryFavorites(), freshFavorites);
  assert.equal(requests.length, 3);
});

test("a favorites read waits when it completes before the mutation refresh", async (t) => {
  const { getLibraryFavorites, updateLibraryFavorites, requests, waitForRequests } =
    await openFavoritesHarness(t);
  const read = getLibraryFavorites();
  await waitForRequests(1);
  const mutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(2);

  let readSettled = false;
  const pendingRead = read.then((value) => {
    readSettled = true;
    return value;
  });
  requireFixture(requests[0]).resolve(jsonResponse({ version: "stale" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readSettled, false);

  requireFixture(requests[1]).resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(3);
  const freshFavorites = { version: "fresh" };
  requireFixture(requests[2]).resolve(jsonResponse(freshFavorites));

  assert.deepEqual(await pendingRead, freshFavorites);
  await mutation;
});

test("favorite writes serialize and the final refresh includes both mutations", async (t) => {
  const { updateLibraryFavorites, queryClient, queryKeys, requests, waitForRequests } =
    await openFavoritesHarness(t);
  const initial = { version: "initial" };
  queryClient.setQueryData(queryKeys.libraryFavorites, initial);

  const firstMutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(1);
  requireFixture(requests[0]).resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(2);

  const secondMutation = updateLibraryFavorites(["song:2"], true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);

  requireFixture(requests[1]).resolve(jsonResponse({ version: "first" }));
  await waitForRequests(3);
  requireFixture(requests[2]).resolve(jsonResponse({ changedIds: ["song:2"] }));
  await waitForRequests(4);

  await firstMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), initial);

  const freshFavorites = { version: "both" };
  requireFixture(requests[3]).resolve(jsonResponse(freshFavorites));
  await secondMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), freshFavorites);
});

test("a failed favorite refresh does not block the next queued mutation", async (t) => {
  const { updateLibraryFavorites, queryClient, queryKeys, requests, waitForRequests } =
    await openFavoritesHarness(t);
  const initial = { version: "initial" };
  queryClient.setQueryData(queryKeys.libraryFavorites, initial);

  const firstMutation = updateLibraryFavorites(["song:1"], true);
  await waitForRequests(1);
  requireFixture(requests[0]).resolve(jsonResponse({ changedIds: ["song:1"] }));
  await waitForRequests(2);

  const secondMutation = updateLibraryFavorites(["song:2"], true);
  requireFixture(requests[1]).resolve(
    new Response(JSON.stringify({ error: "refresh failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  );
  await firstMutation;
  await waitForRequests(3);
  requireFixture(requests[2]).resolve(jsonResponse({ changedIds: ["song:2"] }));
  await waitForRequests(4);

  const freshFavorites = { version: "new" };
  requireFixture(requests[3]).resolve(jsonResponse(freshFavorites));
  await secondMutation;
  assert.deepEqual(queryClient.getQueryData(queryKeys.libraryFavorites), freshFavorites);
});
