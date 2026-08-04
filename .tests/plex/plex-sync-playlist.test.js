import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { PlexClient } from "../../backend/services/plex.js";

function makeClient() {
  const client = new PlexClient("http://plex.local:32400", "token", "client-id");
  client._machineIdentifier = "machine-1";
  return client;
}

function mockRequests(client, responses) {
  const calls = [];
  mock.method(client, "request", async (path, opts = {}) => {
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

test.afterEach(() => {
  mock.restoreAll();
});

test("syncPlaylist creates fresh when no ratingKey is provided - no title search involved", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "POST /playlists": { MediaContainer: { Metadata: [{ ratingKey: "500" }] } },
  });
  const result = await client.syncPlaylist({
    ratingKey: null,
    title: "Discover Weekly",
    ratingKeys: ["1", "2", "3"],
  });
  assert.deepEqual(result, { ratingKey: "500" });
  assert.equal(calls.length, 1, "only the create call - no lookup by title");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].params.title, "Discover Weekly");
  assert.match(calls[0].params.uri, /metadata\/1,2,3$/);
});

test("syncPlaylist sets the summary as a follow-up call right after creating a brand new playlist", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "POST /playlists": { MediaContainer: { Metadata: [{ ratingKey: "700" }] } },
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
      const error = new Error("Not found");
      error.response = { status: 404 };
      throw error;
    },
    "POST /playlists": { MediaContainer: { Metadata: [{ ratingKey: "222" }] } },
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
      const error = new Error("Server exploded");
      error.response = { status: 500 };
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
        Metadata: [
          { ratingKey: "1", playlistItemID: "pi-1" },
          { ratingKey: "2", playlistItemID: "pi-2" },
          { ratingKey: "3", playlistItemID: "pi-3" },
        ],
      },
    },
    "DELETE /playlists/111/items/pi-2": {},
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
  assert.equal(deleteCalls[0].path, "/playlists/111/items/pi-2");

  const addCalls = calls.filter((c) => c.method === "PUT" && c.path === "/playlists/111/items");
  assert.equal(addCalls.length, 1, "additions are batched into a single call");
  assert.match(addCalls[0].params.uri, /metadata\/4$/);

  const renameCalls = calls.filter((c) => c.method === "PUT" && c.path === "/playlists/111");
  assert.equal(renameCalls.length, 0, "title unchanged - no details PUT expected");
});

test("syncPlaylist skips the add call entirely when nothing new needs adding", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        Metadata: [
          { ratingKey: "1", playlistItemID: "pi-1" },
          { ratingKey: "2", playlistItemID: "pi-2" },
        ],
      },
    },
    "DELETE /playlists/111/items/pi-2": {},
  });
  await client.syncPlaylist({
    ratingKey: "111",
    previousTitle: "Same",
    title: "Same",
    ratingKeys: ["1"],
  });
  assert.ok(!calls.some((c) => c.method === "PUT" && c.path === "/playlists/111/items"));
});

test("syncPlaylist makes no add/remove calls at all when the track set is already identical", async () => {
  const client = makeClient();
  const calls = mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        Metadata: [
          { ratingKey: "1", playlistItemID: "pi-1" },
          { ratingKey: "2", playlistItemID: "pi-2" },
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
      MediaContainer: { Metadata: [{ ratingKey: "1", playlistItemID: "pi-1" }] },
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
      MediaContainer: { Metadata: [{ ratingKey: "1", playlistItemID: "pi-1" }] },
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
    "GET /playlists/111/items": { MediaContainer: { Metadata: [] } },
    "DELETE /playlists/111": {},
  });
  const result = await client.syncPlaylist({ ratingKey: "111", title: "Gone", ratingKeys: [] });
  assert.equal(result, null);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/playlists/111"));
});

test("syncPlaylist keeps removing remaining stale items even if one removal fails", async () => {
  const client = makeClient();
  const deletedIds = [];
  mockRequests(client, {
    "GET /playlists/111/items": {
      MediaContainer: {
        Metadata: [
          { ratingKey: "1", playlistItemID: "pi-1" },
          { ratingKey: "2", playlistItemID: "pi-2" },
        ],
      },
    },
    "DELETE /playlists/111/items/pi-1": () => {
      throw new Error("Plex hiccup");
    },
    "DELETE /playlists/111/items/pi-2": () => {
      deletedIds.push("pi-2");
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
  assert.deepEqual(deletedIds, ["pi-2"]);
});
