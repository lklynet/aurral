import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import sharp from "sharp";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, artworkService] = await setupIsolatedBackend(
  "custom-artwork",
  "backend/config/db-sqlite.ts",
  "backend/services/customArtworkService.ts",
);

const {
  buildCustomArtworkUrl,
  getCustomArtwork,
  getCustomArtworkMap,
  getCustomArtworkRevision,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} = artworkService;

const sourceImage = await sharp({
  create: { width: 80, height: 60, channels: 3, background: { r: 80, g: 120, b: 200 } },
})
  .png()
  .toBuffer();

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(state));

test("custom artwork uploads are validated, optimized, listed, and removed", async () => {
  const saved = await saveCustomArtworkUpload("track", "42", sourceImage, "image/png");
  assert.equal(saved.contentType, "image/webp");
  assert.equal(fs.existsSync(saved.filePath), true);
  assert.equal(getCustomArtworkMap("track", [42]).get("42"), saved.updatedAt);
  const savedRevision = getCustomArtworkRevision("track");
  assert.ok(savedRevision >= saved.updatedAt);
  assert.equal(
    buildCustomArtworkUrl("track", 42, saved.updatedAt),
    `/api/library/artwork/track/42?v=${saved.updatedAt}`,
  );

  await removeCustomArtwork("track", "42");
  assert.equal(getCustomArtwork("track", "42"), null);
  assert.equal(fs.existsSync(saved.filePath), false);
  assert.ok(getCustomArtworkRevision("track") > savedRevision);
});

test("custom artwork URLs use the protected image fetcher and become persistent files", async () => {
  const sourceUrl = "https://artwork.example/album.png";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    assert.equal(String(input), sourceUrl);
    return new Response(sourceImage, { headers: { "Content-Type": "image/png" } });
  });

  const saved = await saveCustomArtworkUrl("album", "7", sourceUrl);
  assert.equal(saved.contentType, "image/webp");
  assert.equal(saved.sourceUrl, sourceUrl);
  assert.equal(fs.existsSync(saved.filePath), true);
});

test("a removal requested during a save cannot delete the replacement file after its row is written", async () => {
  const save = saveCustomArtworkUpload("track", "99", sourceImage, "image/png");
  const remove = removeCustomArtwork("track", "99");

  await Promise.all([save, remove]);

  assert.equal(getCustomArtwork("track", "99"), null);
  assert.equal(getCustomArtworkMap("track", ["99"]).has("99"), false);
});

test("a cached image without a content type is refused instead of saved", async () => {
  const { resolveAurralDataDir } = await importFromRepo("backend/config/data-dir.ts");
  const cacheKey = "a".repeat(64);
  const cacheDir = path.join(resolveAurralDataDir(), "image-proxy");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.png`), sourceImage);
  fs.writeFileSync(
    path.join(cacheDir, `${cacheKey}.json`),
    JSON.stringify({ extension: "png", fetchedAt: Date.now(), profile: "library" }),
  );
  await assert.rejects(
    saveCustomArtworkUrl("album", "8", `/api/image-proxy/${cacheKey}.png`),
    /no known content type/,
  );
  assert.equal(getCustomArtwork("album", "8"), null);
});
