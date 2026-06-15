import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("discover-playlist-artwork");
applyIsolatedBackendEnv(isolatedState);

const {
  getDiscoverArtworkDirectory,
  pruneObsoleteDiscoverArtwork,
} = await importFromRepo("backend/services/discoverPlaylistArtworkService.js");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("prunes obsolete discover playlist artwork files", async () => {
  const artworkDir = getDiscoverArtworkDirectory();
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
