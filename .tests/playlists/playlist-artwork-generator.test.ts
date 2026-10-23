import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import axios from "../../lib/axiosFetch.ts";

import { writeGeneratedPlaylistArtwork } from "../../backend/services/playlistArtworkGenerator.ts";

test("photo source failures preserve existing playlist artwork", async (t: import("vite-plus/test").TestContext) => {
  vi.spyOn(axios, "get").mockImplementation(async () => {
    const error = Object.assign(new Error("Request failed with status code 503"), {
      response: { status: 503 },
    });

    throw error;
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-playlist-artwork-"));
  const outputPath = path.join(directory, "road-trip.jpg");
  const existingPath = path.join(directory, "road-trip.webp");
  const existing = Buffer.from("existing photo artwork");
  await fs.writeFile(existingPath, existing);
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));

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
