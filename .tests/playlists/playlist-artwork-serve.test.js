import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-artwork-serve", {
  dataDirRelativePath: path.join(".state", "aurral"),
});
applyIsolatedBackendEnv(isolatedState);

const { db } = await importFromRepo("backend/config/db-sqlite.js");
const { dbOps, userOps } = await importFromRepo("backend/db/helpers/index.js");
const { hashPassword } = await importFromRepo("backend/middleware/passwordHash.js");
dbOps.updateSettings({ downloadFolderPath: path.join(isolatedState.dataDir, "downloads") });
const [
  { flowPlaylistConfig },
  { playlistManager },
  { registerArtworkServe },
  { default: playlistsRouter },
  { authMiddleware },
  { playlistOperationQueue },
  { processPlaylistOperation },
] = await Promise.all(
  [
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/services/playlists/playlistManager.js",
    "backend/routes/playlists/handlers/artworkServe.js",
    "backend/routes/playlists/index.js",
    "backend/middleware/auth.js",
    "backend/services/playlists/playlistOperationQueue.js",
    "backend/services/playlists/playlistOperations.js",
  ].map(importFromRepo),
);

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("serves playlist artwork from a hidden data directory", async () => {
  const owner = userOps.createUser("listener", hashPassword("listener-password"), "user", {
    accessFlow: true,
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Sunday Morning",
    ownerUserId: owner.id,
  });
  await playlistManager.generateArtwork(playlist.id);
  const artwork = await playlistManager.resolveArtworkFile(playlist.id);
  assert.ok(artwork.safePath.split(path.sep).some((segment) => segment.startsWith(".")));

  const app = express();
  const router = express.Router();
  registerArtworkServe(router);
  app.use("/api/playlists", router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/playlists/artwork/${playlist.id}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from("listener:listener-password").toString("base64")}`,
        },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await fs.readFile(artwork.safePath),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a new flow or static playlist has its cover as soon as it is created, with no media server connected", async () => {
  dbOps.updateSettings({
    integrations: {},
    playlistArtwork: { style: "aurral" },
    onboardingComplete: true,
  });
  userOps.createUser("curator", hashPassword("curator-password"), "admin");
  const authorization = `Basic ${Buffer.from("curator:curator-password").toString("base64")}`;
  const queuedOperations = [];
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload) => {
    queuedOperations.push(payload);
    return { queued: true, operationId: `operation-${queuedOperations.length}` };
  });
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/playlists", playlistsRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(`${baseUrl}/api/playlists${route}`, {
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

    const playlistResponse = await request("/shared-playlists", { name: "Fresh Playlist" });
    assert.equal(playlistResponse.status, 200);
    const { playlistId } = await playlistResponse.body.json();
    assert.equal(queuedOperations.length, 1);
    await processPlaylistOperation(queuedOperations[0]);
    const playlistCover = await request(`/artwork/${playlistId}`);
    assert.equal(playlistCover.status, 200);
    assert.equal(playlistCover.type, "image/webp");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
