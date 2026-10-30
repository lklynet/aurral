import * as v from "valibot";
import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  createMockHttpServer,
} from "../helpers/backendTestHarness.ts";

const isolatedState = await createIsolatedStateDir("playlist-artwork-serve", {
  dataDirRelativePath: path.join(".state", "aurral"),
});
applyIsolatedBackendEnv(isolatedState);

const { db } = await import("../../backend/config/db-sqlite.ts");
const { dbOps, userOps } = await import("../../backend/db/helpers/index.ts");
const { hashPassword } = await import("../../backend/middleware/passwordHash.ts");
dbOps.updateSettings({ downloadFolderPath: path.join(isolatedState.dataDir, "downloads") });
const [
  { flowPlaylistConfig },
  { playlistManager },
  { app },
  { createSession },
  { playlistOperationQueue },
  { processPlaylistOperation, playlistOperationSchema },
] = await Promise.all([
  import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  import("../../backend/services/playlists/playlistManager.ts"),
  import("../../backend/app.ts"),
  import("../../backend/config/session-helpers.ts"),
  import("../../backend/services/playlists/playlistOperationQueue.ts"),
  import("../../backend/services/playlists/playlistOperations.ts"),
]);

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("serves playlist artwork from a hidden data directory", async () => {
  const owner = userOps.createUser("listener", hashPassword("listener-password"), "user", {
    accessFlow: true,
  });
  assert.ok(owner != null);
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Sunday Morning",
    ownerUserId: owner.id,
  });
  await playlistManager.generateArtwork(playlist.id);
  const artwork = await playlistManager.resolveArtworkFile(playlist.id);
  assert.ok(artwork != null);
  assert.ok(artwork.safePath.split(path.sep).some((segment: string) => segment.startsWith(".")));

  const server = await createMockHttpServer(getRequestListener(app.fetch));
  try {
    const response = await fetch(`${server.url}/api/playlists/artwork/${playlist.id}`, {
      headers: {
        authorization: `Basic ${Buffer.from("listener:listener-password").toString("base64")}`,
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await fs.readFile(artwork.safePath),
    );
  } finally {
    await server.close();
  }
});

test("a new flow or static playlist has its cover as soon as it is created, with no media server connected", async () => {
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
  });
  userOps.createUser("curator", hashPassword("curator-password"), "admin");
  const authorization = `Basic ${Buffer.from("curator:curator-password").toString("base64")}`;
  const queuedOperations: (
    | import("../../backend/services/honkerDb.ts").HonkerPayload
    | undefined
  )[] = [];
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload) => {
    queuedOperations.push(payload);
    return { queued: true, operationId: queuedOperations.length };
  });
  const server = await createMockHttpServer(getRequestListener(app.fetch));
  const request = async (route: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${server.url}/api/playlists${route}`, {
      method: body ? "POST" : "GET",
      headers: { authorization, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, type: response.headers.get("content-type"), body: response };
  };
  try {
    const flowResponse = await request("/flows", {
      name: "Fresh Flow",
      mix: { discover: 100 },
      size: 10,
      scheduleDays: [1],
    });
    assert.equal(flowResponse.status, 200);
    const { flow } = await flowResponse.body.json();
    const flowCover = await request(`/artwork/${flow.id}`);
    assert.equal(flowCover.status, 200);
    assert.equal(flowCover.type, "image/webp");
    const initialStatus = await (await request("/status")).body.json();
    const initialRevision = initialStatus.flows.find(
      (entry: { id: string }) => entry.id === flow.id,
    )?.artworkRevision;
    const generated = await request(`/artwork/${flow.id}/generate`, { style: "simple" });
    assert.equal(generated.status, 200);
    assert.equal((await generated.body.json()).fallback, false);
    const updatedStatus = await (await request("/status")).body.json();
    const updatedRevision = updatedStatus.flows.find(
      (entry: { id: string }) => entry.id === flow.id,
    )?.artworkRevision;
    assert.equal(typeof initialRevision, "number");
    assert.ok(updatedRevision > initialRevision);
    assert.equal((await request(`/artwork/${flow.id}/generate`, { style: "photo" })).status, 400);
    assert.equal((await request(`/artwork/${flow.id}/restore`, {})).status, 400);

    const playlistResponse = await request("/shared-playlists", { name: "Fresh Playlist" });
    assert.equal(playlistResponse.status, 200);
    const { playlistId } = await playlistResponse.body.json();
    assert.equal(queuedOperations.length, 1);
    await processPlaylistOperation(v.parse(playlistOperationSchema, queuedOperations[0]));
    const playlistCover = await request(`/artwork/${playlistId}`);
    assert.equal(playlistCover.status, 200);
    assert.equal(playlistCover.type, "image/webp");
  } finally {
    await server.close();
  }
});

test("cover previews load from an image tag that can only carry the session token in the URL", async () => {
  const user = userOps.getUserByUsername("curator");
  assert.ok(user != null);
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Wedding MegaMix",
    ownerUserId: user.id,
  });
  const server = await createMockHttpServer(getRequestListener(app.fetch));
  const query = new URLSearchParams({ title: playlist.name, style: "simple", template: "a3" });
  const preview = (token?: string) => {
    const params = new URLSearchParams(query);
    if (token) params.set("token", token);
    return fetch(`${server.url}/api/playlists/artwork/${playlist.id}/preview?${params}`);
  };
  try {
    assert.equal((await preview()).status, 401);
    const response = await preview(createSession(user.id).token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
  } finally {
    await server.close();
  }
});
