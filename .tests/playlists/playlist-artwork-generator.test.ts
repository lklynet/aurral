import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";
import {
  PLAYLIST_COVER_TEMPLATES,
  renderPlaylistCover,
} from "../../backend/services/playlistCoverTemplates.ts";

const [state, generator, imageSource, imageProxy] = await setupIsolatedBackend(
  "cover-generator",
  () => import("../../backend/services/playlistArtworkGenerator.ts"),
  () => import("../../backend/services/releaseGroupCoverService.ts"),
  () => import("../../backend/services/imageProxyService.ts"),
);
const source = await sharp({
  create: { width: 60, height: 40, channels: 3, background: "#134b98" },
})
  .png()
  .toBuffer();
const sourceMetadata = await sharp(source).metadata();
const outputPath = path.join(state.dataDir, "cover.webp");
beforeEach(() => {
  vi.spyOn(imageSource, "fetchDeezerArtistImageUrl").mockImplementation(
    async ({ artistName } = {}) => `https://images.example.test/${artistName}.png`,
  );
  vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: sourceMetadata,
  });
});
afterAll(() => cleanupIsolatedState(state));

test("regeneration chooses a different playlist artist and advances the template", async () => {
  const artists = [{ artistName: "First" }, { artistName: "First" }, { artistName: "Second" }];
  const first = await generator.writeGeneratedPlaylistArtwork({
    outputPath,
    title: "After hours",
    artists,
  });
  const firstBytes = await fs.readFile(outputPath);
  const next = await generator.writeGeneratedPlaylistArtwork({
    outputPath,
    title: "After hours",
    artists,
    previous: first.state,
  });
  assert.notEqual(next.state.artistKey, first.state.artistKey);
  assert.notEqual(next.state.template, first.state.template);
  assert.notDeepEqual(await fs.readFile(outputPath), firstBytes);
  assert.ok(["first", "second"].includes(next.state.artistKey!));
});

test("simple covers do not request any artist image", async () => {
  const lookup = vi.mocked(imageSource.fetchDeezerArtistImageUrl);
  const result = await generator.writeGeneratedPlaylistArtwork({
    outputPath,
    title: "Focus",
    style: "simple",
    artists: [{ artistName: "Artist" }],
  });
  assert.equal(lookup.mock.calls.length, 0);
  assert.equal(result.state.mode, "simple");
  assert.equal(result.state.artistKey, null);
  assert.equal(result.state.fallbackSignature, null);
  const metadata = await sharp(await fs.readFile(outputPath)).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 1000);
});

test("missing artist images produce a simple cover that can be retried", async () => {
  vi.mocked(imageSource.fetchDeezerArtistImageUrl).mockRejectedValue(new Error("offline"));
  const result = await generator.writeGeneratedPlaylistArtwork({
    outputPath,
    title: "Offline",
    artists: [{ artistName: "Artist" }],
  });
  assert.equal(result.state.mode, "artist");
  assert.equal(result.state.artistKey, null);
  assert.ok(result.state.fallbackSignature);
  assert.equal((await sharp(await fs.readFile(outputPath)).metadata()).width, 1000);
});

test("a failed render preserves existing artwork and legacy sidecars", async () => {
  const legacy = path.join(state.dataDir, "cover.jpg");
  await fs.writeFile(outputPath, "existing cover");
  await fs.writeFile(legacy, "existing legacy cover");
  vi.mocked(imageProxy.fetchRemoteImage).mockResolvedValue({
    buffer: Buffer.from("not an image"),
    contentType: "image/png",
    metadata: sourceMetadata,
  });
  await assert.rejects(
    generator.writeGeneratedPlaylistArtwork({
      outputPath,
      title: "Cover",
      artists: [{ artistName: "Artist" }],
    }),
  );
  assert.equal(await fs.readFile(outputPath, "utf8"), "existing cover");
  assert.equal(await fs.readFile(legacy, "utf8"), "existing legacy cover");
});

test("every template renders a distinct cover with a long Unicode title", async () => {
  const outputs = new Set<string>();
  for (const template of PLAYLIST_COVER_TEMPLATES) {
    const buffer = await renderPlaylistCover({
      title: 'Été, 音楽 & "quiet" evenings with friends',
      imageBuffer: source,
      template,
    });
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.width, 1000, template);
    assert.equal(metadata.height, 1000, template);
    outputs.add(buffer.toString("base64"));
  }
  assert.equal(outputs.size, PLAYLIST_COVER_TEMPLATES.length);
});
