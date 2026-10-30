import { requireFixture } from "../playlists/fixtures.ts";
import { test, afterEach, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { PlexClient } from "../../backend/services/plex.ts";

function makeClient() {
  const client = new PlexClient("http://plex.local:32400", "token", "client-id");
  client._machineIdentifier = "machine-1";
  return client;
}

function mockRequests(
  client: PlexClient,
  responses: Record<
    string,
    object | ((options: NonNullable<Parameters<PlexClient["request"]>[1]>) => object)
  >,
) {
  const calls: {
    path: string;
    method: "PUT" | "GET" | "POST" | "DELETE";
    params: { [x: string]: string | number | boolean | null | undefined } | undefined;
  }[] = [];
  vi.spyOn(client, "request").mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ path, method, params: opts.params });
    const key = `${method} ${path}`;
    if (!(key in responses)) {
      throw new Error(`Unmocked request in test: ${key}`);
    }
    const handler = responses[key];
    return typeof handler === "function" ? handler(opts) : handler;
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("syncPlaylist creates fresh when no ratingKey is provided - no title search involved", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "POST /playlists": {
      MediaContainer: { size: 1, Metadata: [{ ratingKey: "500", title: "Mix" }] },
    },
  });
  const result = await client.syncPlaylist({
    ratingKey: null,
    title: "Discover Weekly",
    ratingKeys: ["1", "2", "3"],
  });
  assert.deepEqual(result, { ratingKey: "500" });
  assert.equal(calls.length, 1, "only the create call - no lookup by title");
  assert.equal(calls[0].method, "POST");
  assert.equal(requireFixture(calls[0].params).title, "Discover Weekly");
  assert.ok(requireFixture(calls[0].params).uri != null);
  assert.match(String(calls[0].params?.uri), /metadata\/1,2,3$/);
});

test("syncPlaylist sets the summary as a follow-up call right after creating a brand new playlist", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "POST /playlists": {
      MediaContainer: { size: 1, Metadata: [{ ratingKey: "700", title: "Mix" }] },
    },
    "PUT /playlists/700": {},
  });
  const result = await client.syncPlaylist({
    ratingKey: null,
    title: "Electronic Vibes",
    description: "Electronic and dance floor favorites",
    ratingKeys: ["1", "2"],
  });
  assert.deepEqual(result, { ratingKey: "700" });
  const detailsCall = calls.find((c) => c.method === "PUT" && c.path === "/playlists/700");
  assert.ok(detailsCall, "expected a follow-up details PUT after create");
  assert.deepEqual(detailsCall.params, { summary: "Electronic and dance floor favorites" });
});

test("syncPlaylist returns null and makes no calls when there's no ratingKey and nothing to add", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {});
  const result = await client.syncPlaylist({ ratingKey: null, title: "Empty", ratingKeys: [] });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("syncPlaylist creates fresh when the stored ratingKey no longer exists in Plex (404) - still never searches by title", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": () => {
      const error = Object.assign(new Error("Not found"), { response: { status: 404 } });

      throw error;
    },
    "POST /playlists": {
      MediaContainer: { size: 1, Metadata: [{ ratingKey: "222", title: "Mix" }] },
    },
  });
  const result = await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Old Name",
    title: "New Name",
    ratingKeys: ["9"],
  });
  assert.deepEqual(result, { ratingKey: "222" });
  assert.ok(!calls.some((c) => c.path === "/playlists" && c.method === "GET"));
});

test("syncPlaylist propagates a non-404 error from the item lookup instead of silently recreating", async () => {
  const client = makeClient();
  mockRequests(client, {
    "GET /playlists/111/items": () => {
      const error = Object.assign(new Error("Server exploded"), { response: { status: 500 } });

      throw error;
    },
  });
  await assert.rejects(
    () =>
      client.syncPlaylist({
        ratingKey: "111",
        title: "X",
        ratingKeys: ["1"],
      }),
    /Server exploded/,
  );
});

test("syncPlaylist diffs items in place - removes only what's gone, adds only what's new, in one batched add call", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        size: 3,
        Metadata: [
          { ratingKey: "1", playlistItemID: 1 },
          { ratingKey: "2", playlistItemID: 2 },
          { ratingKey: "3", playlistItemID: 3 },
        ],
      },
    },
    "DELETE /playlists/111/items/2": {},
    "PUT /playlists/111/items": {},
  });
  const result = await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Same",
    title: "Same",
    ratingKeys: ["1", "3", "4"],
  });
  assert.deepEqual(result, { ratingKey: "111" });

  const deleteCalls = calls.filter((c) => c.method === "DELETE");
  assert.equal(deleteCalls.length, 1, "only the item that fell off should be removed");
  assert.equal(deleteCalls[0].path, "/playlists/111/items/2");

  const addCalls = calls.filter((c) => c.method === "PUT" && c.path === "/playlists/111/items");
  assert.equal(addCalls.length, 1, "additions are batched into a single call");
  assert.ok(requireFixture(addCalls[0].params).uri != null);
  assert.match(String(addCalls[0].params?.uri), /metadata\/4$/);

  const renameCalls = calls.filter((c) => c.method === "PUT" && c.path === "/playlists/111");
  assert.equal(renameCalls.length, 0, "title unchanged - no details PUT expected");
});

test("syncPlaylist makes no add/remove calls at all when the track set is already identical", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        size: 2,
        Metadata: [
          { ratingKey: "1", playlistItemID: 1 },
          { ratingKey: "2", playlistItemID: 2 },
        ],
      },
    },
  });
  const result = await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Same",
    title: "Same",
    ratingKeys: ["2", "1"],
  });
  assert.deepEqual(result, { ratingKey: "111" });
  assert.equal(calls.length, 1, "only the initial item lookup - nothing to change");
});

test("syncPlaylist updates title+summary together in one call when either changed, even with unchanged items", async () => {
  const client = makeClient();
  let detailsParams = null;
  const calls = mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: { size: 1, Metadata: [{ ratingKey: "1", playlistItemID: 1 }] },
    },
    "PUT /playlists/111": (opts) => {
      detailsParams = opts.params;
      return {};
    },
  });
  const result = await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Old Title",
    previousDescription: null,
    title: "New Title",
    description: "A fresh description",
    ratingKeys: ["1"],
  });
  assert.deepEqual(result, { ratingKey: "111" });
  assert.deepEqual(detailsParams, { title: "New Title", summary: "A fresh description" });
  assert.equal(
    calls.filter((c) => c.path.includes("/items")).length,
    1,
    "only the initial GET - item set was unchanged",
  );
});

test("syncPlaylist clears the Plex summary when the description is removed", async () => {
  const client = makeClient();
  let detailsParams = null;
  mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: { size: 1, Metadata: [{ ratingKey: "1", playlistItemID: 1 }] },
    },
    "PUT /playlists/111": (opts) => {
      detailsParams = opts.params;
      return {};
    },
  });
  await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Same",
    previousDescription: "Had one before",
    title: "Same",
    description: null,
    ratingKeys: ["1"],
  });
  assert.deepEqual(detailsParams, { title: "Same", summary: "" });
});

test("syncPlaylist deletes the whole playlist when the desired ratingKeys list is empty", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": { MediaContainer: { size: 0 } },
    "DELETE /playlists/111": {},
  });
  const result = await client.syncPlaylist({ ratingKey: "111", title: "Gone", ratingKeys: [] });
  assert.equal(result, null);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/playlists/111"));
});

test("syncPlaylist keeps removing remaining stale items even if one removal fails", async () => {
  const client = makeClient();
  const deletedIds: string[] = [];
  mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        size: 2,
        Metadata: [
          { ratingKey: "1", playlistItemID: 1 },
          { ratingKey: "2", playlistItemID: 2 },
        ],
      },
    },
    "DELETE /playlists/111/items/1": () => {
      throw new Error("Plex hiccup");
    },
    "DELETE /playlists/111/items/2": () => {
      deletedIds.push("2");
      return {};
    },
    "PUT /playlists/111/items": {},
  });
  const result = await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Same",
    title: "Same",
    ratingKeys: ["3"],
  });
  assert.deepEqual(result, { ratingKey: "111" }, "one bad removal shouldn't fail the whole sync");
  assert.deepEqual(deletedIds, ["2"]);
});

test("getTracks rejects a timeout while reading a page body instead of returning a partial library", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], now: 0 });
  let readingBody!: () => void;
  const bodyStarted = new Promise<void>((resolve) => {
    readingBody = resolve;
  });
  let pages = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, { signal } = {}) => {
    pages += 1;
    if (pages === 1)
      return Response.json({
        MediaContainer: { size: 1, totalSize: 2, Metadata: [{ ratingKey: "1" }] },
      });
    const response = Response.json({});
    response.json = () =>
      new Promise<void>((_resolve, reject) => {
        assert.ok(signal != null);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        readingBody();
      });
    return response;
  });
  const tracks = makeClient().getTracks("9");
  const rejected = assert.rejects(tracks, { code: "ECONNABORTED" });
  await bodyStarted;
  vi.advanceTimersByTime(30_001);
  await rejected;
});
