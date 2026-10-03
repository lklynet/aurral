import test from "node:test";
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
const [{ flowPlaylistConfig }, { playlistManager }, { registerArtworkServe }] = await Promise.all(
  [
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/services/playlists/playlistManager.js",
    "backend/routes/playlists/handlers/artworkServe.js",
  ].map(importFromRepo),
);

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("serves playlist artwork from a hidden data directory", async () => {
  const owner = userOps.createUser("listener", hashPassword("listener-password"), "user", { accessFlow: true });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Sunday Morning", ownerUserId: owner.id });
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
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/playlists/artwork/${playlist.id}`, {
      headers: { authorization: `Basic ${Buffer.from("listener:listener-password").toString("base64")}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(artwork.safePath));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
