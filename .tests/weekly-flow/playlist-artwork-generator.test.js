import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import axios from "../../lib/axiosFetch.js";

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

test("buildGeneratedPlaylistArtworkBuffer falls back when photo source is unavailable", async (t) => {
  t.mock.method(axios, "get", async () => {
    const error = new Error("Request failed with status code 503");
    error.response = { status: 503 };
    throw error;
  });

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
});
