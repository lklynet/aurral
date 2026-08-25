import assert from "node:assert/strict";
import test from "node:test";
import { createMockHttpServer } from "./helpers/backendTestHarness.js";
import { JellyfinClient } from "../backend/services/jellyfin.js";

test("updates playlists with API-key-compatible replacement requests", async () => {
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
    const replacement = await client.updatePlaylist("created", {
      name: "Second",
      itemIds: ["track-2"],
    });
    await client.deletePlaylist(replacement.Id);

    assert.equal(created.Id, "created");
    assert.equal(replacement.Id, "replacement");
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url.pathname}`),
      [
        "POST /Playlists",
        "POST /Playlists",
        "DELETE /Items/created",
        "DELETE /Items/replacement",
      ],
    );
    assert.equal(requests[0].body.UserId, "user-id");
    assert.equal(requests[1].body.Name, "Second");
    assert.equal(requests[2].url.searchParams.get("userId"), "user-id");
    assert.match(requests[0].headers?.authorization || "", /Token="api-key"/);
  } finally {
    await server.close();
  }
});
