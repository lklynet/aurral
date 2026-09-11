import assert from "node:assert/strict";
import test from "node:test";
import { createMockHttpServer } from "./helpers/backendTestHarness.js";
import { JellyfinClient } from "../backend/services/jellyfin.js";

test("creates private playlists and deletes them with API-key authentication", async () => {
  const requests = [];
  const server = await createMockHttpServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({
      method: req.method,
      url: new URL(req.url || "/", "http://127.0.0.1"),
      headers: req.headers,
      body: body.length ? JSON.parse(Buffer.concat(body).toString()) : null,
    });
    res.writeHead(req.method === "DELETE" ? 204 : 200, {
      "Content-Type": "application/json",
    });
    if (req.method !== "DELETE") {
      res.end(JSON.stringify({ Id: requests.length === 1 ? "created" : "replacement" }));
      return;
    }
    res.end();
  });

  try {
    const client = new JellyfinClient(server.url, "api-key", "user-id");
    const created = await client.createPlaylist({ name: "First", itemIds: ["track-1"] });
    await client.deletePlaylist(created.Id);

    assert.equal(created.Id, "created");
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url.pathname}`),
      [
        "POST /Playlists",
        "DELETE /Items/created",
      ],
    );
    assert.equal(requests[0].body.UserId, "user-id");
    assert.equal(requests[0].body.IsPublic, false);
    assert.equal(requests[1].url.searchParams.get("userId"), "user-id");
    assert.match(requests[0].headers?.authorization || "", /Token="api-key"/);
  } finally {
    await server.close();
  }
});

test("finds Jellyfin users by exact case-insensitive username", async () => {
  const server = await createMockHttpServer(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([
      { Id: "jellyfin-ambi", Name: "ambi" },
      { Id: "jellyfin-hopolis", Name: "Hopolis" },
    ]));
  });

  try {
    const client = new JellyfinClient(server.url, "api-key", "admin-user");

    assert.equal(
      (await client.findUserByUsername(" AMBI "))?.Id,
      "jellyfin-ambi",
    );
    assert.equal(
      (await client.findUserByUsername("hopolis"))?.Id,
      "jellyfin-hopolis",
    );
    assert.equal(await client.findUserByUsername("hop"), null);
  } finally {
    await server.close();
  }
});

function mockPlaylistClient(initialIds, { beforeRequest } = {}) {
  const client = new JellyfinClient("http://jellyfin.test", "api-key", "configured-user");
  const state = {
    metadata: {
      Id: "playlist-1",
      Type: "Playlist",
      Name: "Original",
      Overview: "Keep this description",
      Genres: ["Electronic"],
      LockData: true,
    },
    // Some Jellyfin versions reuse PlaylistItemId for repeated tracks.
    entries: initialIds.map((id) => ({ Id: id, PlaylistItemId: `entry-${id}` })),
    requests: [],
  };
  client.request = async (method, endpoint, options = {}) => {
    const { params, data } = options;
    state.requests.push({ method, endpoint, ...options });
    await beforeRequest?.({ method, endpoint, params, data, state });
    if (method === "GET") assert.equal(params.userId, "matched-owner");
    if (endpoint === "/Items/playlist-1") {
      if (method === "GET") return structuredClone(state.metadata);
      if (method === "POST") {
        state.metadata = structuredClone(data);
        return;
      }
    }
    if (endpoint === "/Playlists/playlist-1/Items") {
      if (method === "GET") {
        return {
          Items: structuredClone(state.entries.slice(params.startIndex, params.startIndex + params.limit)),
          TotalRecordCount: state.entries.length,
        };
      }
      if (method === "DELETE") {
        const entryIds = params.entryIds.split(",");
        assert.ok(entryIds.length <= 50);
        state.entries = state.entries.filter((entry) => !entryIds.includes(entry.PlaylistItemId));
        return;
      }
      if (method === "POST") {
        assert.equal(params.userId, "matched-owner");
        const requestedIds = params.ids.split(",");
        assert.ok(requestedIds.length <= 50);
        // Model servers that discard repeated IDs within a single request.
        const ids = [...new Set(requestedIds)];
        state.entries.push(...ids.map((id) => ({ Id: id, PlaylistItemId: `entry-${id}` })));
        return;
      }
    }
    assert.fail(`Unexpected request: ${method} ${endpoint}`);
  };
  return { client, state };
}

test("updates playlists through API-key-compatible endpoints with pagination and batching", async () => {
  const initialIds = Array.from({ length: 205 }, (_, index) => `old-${index}`);
  const { client, state } = mockPlaylistClient(initialIds);
  const originalMetadata = structuredClone(state.metadata);
  const itemIds = Array.from({ length: 120 }, (_, index) => `new-${index}`);
  itemIds.push(itemIds[0]);

  const result = await client.updatePlaylist("playlist-1", {
    name: "Renamed",
    itemIds,
    userId: "matched-owner",
  });

  assert.deepEqual(result, { Id: "playlist-1" });
  assert.deepEqual(state.metadata, { ...originalMetadata, Name: "Renamed" });
  assert.deepEqual(state.entries.map((entry) => entry.Id), itemIds);
  assert.deepEqual(
    state.requests.filter((request) => request.method === "DELETE")
      .map((request) => request.params.entryIds.split(",").length),
    [50, 50, 50, 50, 5],
  );
  assert.deepEqual(
    state.requests.filter((request) => request.method === "POST" && request.params?.ids)
      .map((request) => request.params.ids.split(",").length),
    [50, 50, 21],
  );
  assert.ok(state.requests.some((request) => request.params?.startIndex === 200));

  state.requests.length = 0;
  await client.updatePlaylist("playlist-1", { name: "Renamed", itemIds, userId: "matched-owner" });
  assert.ok(state.requests.every((request) => request.method === "GET"));
});

test("restores previous playlist contents after a partial batch failure and allows retry", async () => {
  const originalIds = ["old-1", "old-2", "old-1"];
  let addAttempts = 0;
  const { client, state } = mockPlaylistClient(originalIds, {
    beforeRequest: ({ method, params, state: current }) => {
      if (method !== "POST" || !params?.ids) return;
      addAttempts += 1;
      if (addAttempts === 2) {
        assert.equal(current.entries.length, 50);
        throw new Error("Simulated second-batch failure");
      }
    },
  });
  const itemIds = Array.from({ length: 60 }, (_, index) => `new-${index}`);

  await assert.rejects(
    client.updatePlaylist("playlist-1", { name: "Original", itemIds, userId: "matched-owner" }),
    /previous contents restored: Simulated second-batch failure/,
  );
  assert.equal(addAttempts, 4);
  assert.deepEqual(state.entries.map((entry) => entry.Id), originalIds);

  await client.updatePlaylist("playlist-1", { name: "Original", itemIds, userId: "matched-owner" });
  assert.deepEqual(state.entries.map((entry) => entry.Id), itemIds);
});

test("replaces overlapping tracks without deleting newly added repeated entries", async () => {
  const { client, state } = mockPlaylistClient(["track-1", "track-2", "track-1"]);
  const itemIds = ["track-2", "track-1", "track-2"];
  await client.replacePlaylistItems("playlist-1", itemIds, "matched-owner");
  assert.deepEqual(state.entries.map((entry) => entry.Id), itemIds);
});

test("rejects incomplete playlist reads before mutating the playlist", async () => {
  const client = new JellyfinClient("http://jellyfin.test", "api-key", "user-id");
  client.request = async (method, _endpoint, { params }) => {
    assert.equal(method, "GET");
    return {
      Items: params.startIndex === 0 ? [{ Id: "old-1", PlaylistItemId: "entry-1" }] : [],
      TotalRecordCount: 2,
    };
  };
  await assert.rejects(client.replacePlaylistItems("playlist-1", ["new-1"]), /incomplete playlist/);
});

test("reports both update and recovery failures", async () => {
  const { client } = mockPlaylistClient(["old-1"], {
    beforeRequest: ({ method, params }) => {
      if (method === "POST" && params?.ids) throw new Error("Jellyfin unavailable");
    },
  });
  await assert.rejects(
    client.replacePlaylistItems("playlist-1", ["new-1"], "matched-owner"),
    /Restoring previous contents also failed: Jellyfin unavailable/,
  );
});

test("splits repeated IDs into ordered, duplicate-free add batches", async () => {
  const { client, state } = mockPlaylistClient([]);
  const firstBatch = Array.from({ length: 50 }, (_, index) => `track-${index}`);
  const itemIds = [...firstBatch, "track-49", "track-49", "track-1", "track-49"];

  await client.addPlaylistItems("playlist-1", itemIds, "matched-owner");

  const batches = state.requests.map((request) => request.params.ids.split(","));
  assert.deepEqual(batches, [firstBatch, ["track-49"], ["track-49", "track-1"], ["track-49"]]);
  assert.deepEqual(batches.flat(), itemIds);
  assert.ok(batches.every((batch) => new Set(batch).size === batch.length));
  assert.deepEqual(state.entries.map((entry) => entry.Id), itemIds);

  state.requests.length = 0;
  await client.addPlaylistItems("playlist-1", [], "matched-owner");
  assert.equal(state.requests.length, 0);
});

test("falls back to legacy metadata reads on 405, including rename verification", async () => {
  const requests = [];
  const userId = "owner/name";
  const playlistId = "playlist/id";
  const modernPath = "/Items/playlist%2Fid";
  const legacyPath = "/Users/owner%2Fname/Items/playlist%2Fid";
  let metadata = { Id: playlistId, Type: "Playlist", Name: "Original", Overview: "Keep me" };
  const server = await createMockHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({ method: req.method, url, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && url.pathname === modernPath) {
      res.writeHead(405);
      res.end(JSON.stringify({ message: "Method Not Allowed" }));
    } else if (req.method === "GET" && url.pathname === legacyPath) {
      res.end(JSON.stringify(metadata));
    } else if (req.method === "POST" && url.pathname === modernPath) {
      metadata = JSON.parse(Buffer.concat(body).toString());
      res.writeHead(204);
      res.end();
    } else if (req.method === "GET" && url.pathname === "/Playlists/playlist%2Fid/Items") {
      res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    } else {
      res.writeHead(500);
      res.end(JSON.stringify({ message: "Unexpected request" }));
    }
  });

  try {
    const client = new JellyfinClient(server.url, "api-key", "configured-user");
    assert.deepEqual(
      await client.updatePlaylist(playlistId, { name: "Renamed", itemIds: [], userId }),
      { Id: playlistId },
    );
    assert.deepEqual(metadata, { Id: playlistId, Type: "Playlist", Name: "Renamed", Overview: "Keep me" });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url.pathname}`), [
      `GET ${modernPath}`,
      `GET ${legacyPath}`,
      `POST ${modernPath}`,
      `GET ${modernPath}`,
      `GET ${legacyPath}`,
      "GET /Playlists/playlist%2Fid/Items",
    ]);
    for (const request of requests) {
      assert.match(request.headers.authorization, /Token="api-key"/);
      if (request.method === "GET" && request.url.pathname !== legacyPath) {
        assert.equal(request.url.searchParams.get("userId"), userId);
      }
    }
  } finally {
    await server.close();
  }
});

test("does not fall back or mutate playlists on other metadata errors", async (t) => {
  for (const status of [401, 403, 404, 500, undefined]) {
    await t.test(String(status ?? "network failure"), async () => {
      const client = new JellyfinClient("http://jellyfin.test", "api-key", "configured-user");
      const failure = new Error("Metadata read failed");
      if (status !== undefined) failure.response = { status };
      const requests = [];
      client.request = async (method, endpoint) => {
        requests.push({ method, endpoint });
        throw failure;
      };
      await assert.rejects(
        client.updatePlaylist("playlist-1", { name: "Renamed", itemIds: ["track-1"] }),
        (error) => error === failure,
      );
      assert.deepEqual(requests, [{ method: "GET", endpoint: "/Items/playlist-1" }]);
    });
  }
});
