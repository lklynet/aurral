import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir(
  "discover-playlist-artwork",
  { dataDirRelativePath: path.join(".state", "aurral") },
);
applyIsolatedBackendEnv(isolatedState);

const [playlistArtworkBuilder, { registerArtwork }] = await Promise.all(
  [
    "backend/services/discovery/playlistArtworkBuilder.js",
    "backend/routes/discovery/handlers/artwork.js",
  ].map(importFromRepo),
);

const { pruneObsoleteDiscoverArtwork } = playlistArtworkBuilder;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("prunes obsolete discover playlist artwork files", async () => {
  const artworkDir = path.join(isolatedState.dataDir, "discover-artwork");
  await fs.mkdir(artworkDir, { recursive: true });

  await fs.writeFile(path.join(artworkDir, "current.jpg"), "current");
  await fs.writeFile(path.join(artworkDir, "Focused_Rock.webp"), "current");
  await fs.writeFile(path.join(artworkDir, "obsolete.jpg"), "obsolete");
  await fs.writeFile(path.join(artworkDir, "obsolete.webp"), "obsolete");
  await fs.writeFile(path.join(artworkDir, "obsolete.png"), "obsolete");
  await fs.writeFile(path.join(artworkDir, "notes.txt"), "keep");

  const removed = await pruneObsoleteDiscoverArtwork([
    "current",
    "Focused Rock",
  ]);

  assert.equal(removed, 3);
  await assert.doesNotReject(() => fs.access(path.join(artworkDir, "current.jpg")));
  await assert.doesNotReject(() =>
    fs.access(path.join(artworkDir, "Focused_Rock.webp")),
  );
  await assert.doesNotReject(() => fs.access(path.join(artworkDir, "notes.txt")));
  await assert.rejects(() => fs.access(path.join(artworkDir, "obsolete.jpg")));
  await assert.rejects(() => fs.access(path.join(artworkDir, "obsolete.webp")));
  await assert.rejects(() => fs.access(path.join(artworkDir, "obsolete.png")));
});

test("serves discover playlist artwork from a hidden data directory", async () => {
  const artworkDir = path.join(isolatedState.dataDir, "discover-artwork");
  await fs.mkdir(artworkDir, { recursive: true });
  await fs.writeFile(path.join(artworkDir, "focused-rock.jpg"), "artwork");

  const app = express();
  const router = express.Router();
  registerArtwork(router);
  app.use("/api/discover", router);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/discover/artwork/focused-rock`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(await response.text(), "artwork");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
