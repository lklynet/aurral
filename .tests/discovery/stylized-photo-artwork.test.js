import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const {
  PHOTO_ARTWORK_COLORS,
  pickRandomPhotoArtworkPalette,
  pickSeededPhotoArtworkPalette,
  renderStylizedPhotoArtwork,
} = await importFromRepo("backend/services/stylizedPhotoArtwork.js");
const { FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS } = await importFromRepo(
  "backend/config/discoverPlaylistPresets.js",
);

test("renderStylizedPhotoArtwork returns a square JPEG cover", async () => {
  const sourceBuffer = await sharp({
    create: {
      width: 800,
      height: 800,
      channels: 3,
      background: { r: 72, g: 96, b: 128 },
    },
  })
    .jpeg()
    .toBuffer();

  const output = await renderStylizedPhotoArtwork({
    imageBuffer: sourceBuffer,
    title: "Discover Weekly",
  });

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 1200);
  assert.equal(metadata.format, "jpeg");
  assert.ok(output.length > 10_000);
});

test("fixed discover playlists use stable unique seeded colors", () => {
  const presetIds = Object.keys(FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS);
  const seen = new Set();

  for (const presetId of presetIds) {
    const first = pickSeededPhotoArtworkPalette(presetId);
    const second = pickSeededPhotoArtworkPalette(presetId);
    assert.deepEqual(first, second);
    seen.add(`${first.light.r},${first.light.g},${first.light.b}`);
  }

  assert.equal(seen.size, presetIds.length);
});

test("pickRandomPhotoArtworkPalette uses the configured distinct colors", () => {
  const seen = new Set();
  for (let index = 0; index < 40; index += 1) {
    const palette = pickRandomPhotoArtworkPalette();
    seen.add(`${palette.light.r},${palette.light.g},${palette.light.b}`);
  }
  assert.equal(PHOTO_ARTWORK_COLORS.length, 15);
  assert.ok(seen.size > 1);
});
