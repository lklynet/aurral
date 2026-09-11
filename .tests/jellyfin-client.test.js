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
    managedItemIds: initialIds,
  });

  assert.equal(result.Id, "playlist-1");
  assert.deepEqual([...result.managedItemIds].sort(), [...itemIds].sort());
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

test("sync preserves Jellyfin-only tracks and removes only previously managed tracks", async () => {
  const { client, state } = mockPlaylistClient(["custom", "keep", "remove", "custom"]);
  const managedItemIds = await client.syncPlaylistItems("playlist-1", ["keep", "new"], {
    userId: "matched-owner", managedItemIds: ["keep", "remove"],
  });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom", "keep", "custom", "new"]);
  assert.deepEqual(managedItemIds, ["keep", "new"]);
  assert.deepEqual(
    state.requests.filter((request) => request.method === "DELETE").map((request) => request.params.entryIds),
    ["entry-remove"],
  );

  await client.syncPlaylistItems("playlist-1", [], { userId: "matched-owner", managedItemIds });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom", "custom"]);
});

test("first sync preserves all existing entries, including overlapping Aurral tracks", async () => {
  const { client, state } = mockPlaylistClient(["legacy", "overlap", "custom"]);
  const managedItemIds = await client.syncPlaylistItems("playlist-1", ["overlap", "new"], {
    userId: "matched-owner",
  });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["legacy", "overlap", "custom", "new"]);
  assert.deepEqual(managedItemIds, ["new"]);
  assert.ok(state.requests.every((request) => request.method !== "DELETE"));
  await client.syncPlaylistItems("playlist-1", [], { userId: "matched-owner", managedItemIds });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["legacy", "overlap", "custom"]);
});

test("sync ignores ordering changes and can restore a missing Aurral track", async () => {
  const { client, state } = mockPlaylistClient(["second", "custom", "first"]);
  let managedItemIds = await client.syncPlaylistItems("playlist-1", ["first", "second"], {
    userId: "matched-owner", managedItemIds: ["first", "second"],
  });
  assert.ok(state.requests.every((request) => request.method === "GET"));
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["second", "custom", "first"]);
  state.entries = state.entries.filter((entry) => entry.Id !== "first");
  managedItemIds = await client.syncPlaylistItems("playlist-1", ["first", "second"], {
    userId: "matched-owner", managedItemIds,
  });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["second", "custom", "first"]);
  assert.deepEqual([...managedItemIds].sort(), ["first", "second"]);
});

test("sync retains additions made in Jellyfin while an add request is in flight", async () => {
  const { client, state } = mockPlaylistClient(["owned"], {
    beforeRequest: ({ method, params, state: current }) => {
      if (method === "POST" && params?.ids) {
        current.entries.push({ Id: "concurrent-custom", PlaylistItemId: "entry-custom" });
      }
    },
  });
  await client.syncPlaylistItems("playlist-1", ["new"], {
    userId: "matched-owner", managedItemIds: ["owned"],
  });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["concurrent-custom", "new"]);
});

test("sync checkpoints successful batches and retries a partial add without duplication or clearing", async () => {
  let attempts = 0;
  let saved = ["old"];
  const { client, state } = mockPlaylistClient(["custom", "old"], {
    beforeRequest: ({ method, params }) => {
      if (method === "POST" && params?.ids && ++attempts === 2) throw new Error("second batch failed");
    },
  });
  const desired = Array.from({ length: 60 }, (_, index) => `new-${index}`);
  const options = () => ({
    userId: "matched-owner", managedItemIds: saved,
    onManagedItemsChange: (ids) => { saved = structuredClone(ids); },
  });
  await assert.rejects(client.syncPlaylistItems("playlist-1", desired, options()), /second batch failed/);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom", "old", ...desired.slice(0, 50)]);
  assert.deepEqual(saved, ["old", ...desired.slice(0, 50)]);
  assert.ok(state.requests.every((request) => request.method !== "DELETE"));
  await client.syncPlaylistItems("playlist-1", desired, options());
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom", ...desired]);
  assert.deepEqual(saved, desired);
});

test("a lost add response leaves an uncertain entry protected and retry does not duplicate it", async () => {
  let fail = true;
  let saved = [];
  const { client, state } = mockPlaylistClient(["custom"], {
    beforeRequest: ({ method, params, state: current }) => {
      if (method === "POST" && params?.ids && fail) {
        fail = false;
        current.entries.push({ Id: "new", PlaylistItemId: "entry-new" });
        throw new Error("response lost after server applied add");
      }
    },
  });
  const options = () => ({
    userId: "matched-owner", managedItemIds: saved,
    onManagedItemsChange: (ids) => { saved = structuredClone(ids); },
  });
  await assert.rejects(client.syncPlaylistItems("playlist-1", ["new"], options()), /response lost/);
  await client.syncPlaylistItems("playlist-1", ["new"], options());
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom", "new"]);
  assert.deepEqual(saved, []);
});

test("sync preserves ambiguous repeated copies instead of removing a Jellyfin user's copy", async () => {
  const { client, state } = mockPlaylistClient(["same", "same", "custom"]);
  const managedItemIds = await client.syncPlaylistItems("playlist-1", [], {
    userId: "matched-owner", managedItemIds: ["same"],
  });
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["same", "same", "custom"]);
  assert.deepEqual(managedItemIds, []);
  assert.ok(state.requests.every((request) => request.method === "GET"));
});

test("sync never deletes a shared entry group to reduce its repetition count", async () => {
  const { client, state } = mockPlaylistClient(["same", "same"]);
  const managedItemIds = await client.syncPlaylistItems("playlist-1", ["same"], {
    userId: "matched-owner", managedItemIds: ["same", "same"],
  });
  assert.deepEqual(managedItemIds, ["same"]);
  assert.equal(state.entries.length, 2);
  assert.ok(state.requests.every((request) => request.method === "GET"));
});

test("sync can remove owned repeated tracks when the whole group is no longer wanted", async () => {
  const { client, state } = mockPlaylistClient(["same", "same", "custom"]);
  const managedItemIds = await client.syncPlaylistItems("playlist-1", [], {
    userId: "matched-owner", managedItemIds: ["same", "same"],
  });
  assert.deepEqual(managedItemIds, []);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom"]);
});

test("sync fails safely on incomplete reads and invalid IDs", async () => {
  const client = new JellyfinClient("http://jellyfin.test", "api-key", "user-id");
  client.request = async (method, _endpoint, { params }) => {
    assert.equal(method, "GET");
    return {
      Items: params.startIndex === 0 ? [{ Id: "old", PlaylistItemId: "entry-old" }] : [],
      TotalRecordCount: 2,
    };
  };
  await assert.rejects(client.syncPlaylistItems("playlist-1", ["new"]), /incomplete playlist/);
  await assert.rejects(client.syncPlaylistItems("playlist-1", [null]), /non-empty strings/);
  await assert.rejects(client.syncPlaylistItems("playlist-1", [], { managedItemIds: [""] }), /non-empty strings/);
});

test("sync verifies deletions and retries without deleting unrelated entries", async () => {
  let fail = true;
  let saved = ["owned"];
  const { client, state } = mockPlaylistClient(["owned", "custom"], {
    beforeRequest: ({ method }) => {
      if (method === "DELETE" && fail) {
        fail = false;
        throw new Error("delete unavailable");
      }
    },
  });
  const options = () => ({
    userId: "matched-owner", managedItemIds: saved,
    onManagedItemsChange: (ids) => { saved = structuredClone(ids); },
  });
  await assert.rejects(client.syncPlaylistItems("playlist-1", [], options()), /delete unavailable/);
  assert.deepEqual(saved, ["owned"]);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["owned", "custom"]);
  await client.syncPlaylistItems("playlist-1", [], options());
  assert.deepEqual(saved, []);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom"]);
});

test("sync detects a server that acknowledges a deletion without applying it", async () => {
  const { client, state } = mockPlaylistClient(["owned", "custom"]);
  client.removePlaylistItems = async () => {};
  let saved = ["owned"];
  await assert.rejects(client.syncPlaylistItems("playlist-1", [], {
    userId: "matched-owner", managedItemIds: saved,
    onManagedItemsChange: (ids) => { saved = structuredClone(ids); },
  }), /removal verification failed/);
  assert.deepEqual(saved, ["owned"]);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["owned", "custom"]);
});

test("sync handles partial deletion batches on retry without clearing the playlist", async () => {
  const owned = Array.from({ length: 60 }, (_, index) => `owned-${index}`);
  let attempts = 0;
  const { client, state } = mockPlaylistClient([...owned, "custom"], {
    beforeRequest: ({ method }) => {
      if (method === "DELETE" && ++attempts === 2) throw new Error("second delete failed");
    },
  });
  let saved = owned;
  const options = () => ({
    userId: "matched-owner", managedItemIds: saved,
    onManagedItemsChange: (ids) => { saved = structuredClone(ids); },
  });
  await assert.rejects(client.syncPlaylistItems("playlist-1", [], options()), /second delete failed/);
  assert.deepEqual(state.entries.map((entry) => entry.Id), [...owned.slice(50), "custom"]);
  await client.syncPlaylistItems("playlist-1", [], options());
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["custom"]);
  assert.deepEqual(saved, []);
});

test("sync preserves a retained track if another track unexpectedly shares its entry ID", async () => {
  const { client, state } = mockPlaylistClient(["owned", "custom"]);
  state.entries.forEach((entry) => { entry.PlaylistItemId = "shared"; });
  const managedItemIds = await client.syncPlaylistItems("playlist-1", [], {
    userId: "matched-owner", managedItemIds: ["owned"],
  });
  assert.deepEqual(managedItemIds, []);
  assert.deepEqual(state.entries.map((entry) => entry.Id), ["owned", "custom"]);
  assert.ok(state.requests.every((request) => request.method === "GET"));
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
      { Id: playlistId, managedItemIds: [] },
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
