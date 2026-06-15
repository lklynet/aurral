import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const {
  buildGeneratedPlaylistArtworkBuffer,
  resolvePlaylistSourceImageUrl,
} = await importFromRepo("backend/services/playlistArtworkGenerator.js");

test("resolvePlaylistSourceImageUrl returns a unique random picsum URL", async () => {
  const first = await resolvePlaylistSourceImageUrl();
  const second = await resolvePlaylistSourceImageUrl();
  assert.notEqual(first, second);
  assert.match(first, /^https:\/\/picsum\.photos\/800\/800\?random=/);
});

test("buildGeneratedPlaylistArtworkBuffer returns aurral WebP artwork", async () => {
  const buffer = await buildGeneratedPlaylistArtworkBuffer({
    title: "Road Trip",
    kind: "Playlist",
    signature: "playlist-1",
    style: "aurral",
  });
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 1000);
  assert.equal(metadata.format, "webp");
});
