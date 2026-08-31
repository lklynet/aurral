import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { buildGeneratedPlaylistArtworkBuffer } from "../../backend/services/playlistArtworkGenerator.js";

test("buildGeneratedPlaylistArtworkBuffer returns aurral WebP artwork", async () => {
  const buffer = await buildGeneratedPlaylistArtworkBuffer({
    title: "Road Trip",
    kind: "Playlist",
    style: "aurral",
  });
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 1000);
  assert.equal(metadata.format, "webp");
});

test("buildGeneratedPlaylistArtworkBuffer falls back when photo source is unavailable", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 503 });
  try {
    const buffer = await buildGeneratedPlaylistArtworkBuffer({
      title: "Road Trip",
      kind: "Playlist",
      style: "photo",
      paletteSeed: "test",
    });
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.width, 1000);
    assert.equal(metadata.height, 1000);
    assert.equal(metadata.format, "jpeg");
  } finally {
    global.fetch = originalFetch;
  }
});
