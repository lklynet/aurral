import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import axios from "../../lib/axiosFetch.js";

import {
  buildGeneratedPlaylistArtworkBuffer,
  writeGeneratedPlaylistArtwork,
} from "../../backend/services/playlistArtworkGenerator.js";

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

test("photo source failures preserve existing playlist artwork", async (t) => {
  t.mock.method(axios, "get", async () => {
    const error = new Error("Request failed with status code 503");
    error.response = { status: 503 };
    throw error;
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-playlist-artwork-"));
  const outputPath = path.join(directory, "road-trip.jpg");
  const existingPath = path.join(directory, "road-trip.webp");
  const existing = Buffer.from("existing photo artwork");
  await fs.writeFile(existingPath, existing);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    writeGeneratedPlaylistArtwork({
      outputPath,
      title: "Road Trip",
      kind: "Playlist",
      style: "photo",
      paletteSeed: "test",
    }),
    /503/,
  );
  assert.deepEqual(await fs.readFile(existingPath), existing);
  await assert.rejects(fs.access(outputPath));
});
