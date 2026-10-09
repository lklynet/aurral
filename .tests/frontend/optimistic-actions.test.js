import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const openHarness = async (t) => {
  const vite = await startFrontendServer();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, resolve });
  });
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
  t.after(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
    return vite.close();
  });
  const waitForRequests = async (count) => {
    while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
  };
  return { vite, queryClient, queryKeys, requests, waitForRequests };
};

test("an album request shows as downloading at once and stops if the server refuses it", async (t) => {
  const { vite, queryClient, queryKeys, requests, waitForRequests } = await openHarness(t);
  const { requestAlbumFromSearch } = await vite.ssrLoadModule("/src/utils/api/endpoints/library.js");
  const activeAlbums = () => queryClient.getQueryData(queryKeys.activeDownloads)?.albums || [];

  const request = requestAlbumFromSearch({ albumMbid: "album-1", artistMbid: "artist-1" });
  await waitForRequests(1);
  assert.deepEqual(activeAlbums(), ["album-1"]);

  requests[0].resolve(json({ error: "Lidarr is unreachable" }, 502));
  await assert.rejects(request);
  assert.deepEqual(activeAlbums(), []);
});
