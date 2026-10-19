import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import sharp from "sharp";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, artworkService] = await setupIsolatedBackend(
  "custom-artwork",
  "backend/config/db-sqlite.js",
  "backend/services/customArtworkService.js",
);

const {
  buildCustomArtworkUrl,
  getCustomArtwork,
  getCustomArtworkMap,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} = artworkService;

const sourceImage = await sharp({
  create: { width: 80, height: 60, channels: 3, background: { r: 80, g: 120, b: 200 } },
}).png().toBuffer();

test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(state));

test("custom artwork uploads are validated, optimized, listed, and removed", async () => {
  const saved = await saveCustomArtworkUpload("track", "42", sourceImage, "image/png");
  assert.equal(saved.contentType, "image/webp");
  assert.equal(fs.existsSync(saved.filePath), true);
  assert.equal(getCustomArtworkMap("track", [42]).get("42"), saved.updatedAt);
  assert.equal(
    buildCustomArtworkUrl("track", 42, saved.updatedAt),
    `/api/library/artwork/track/42?v=${saved.updatedAt}`,
  );

  await removeCustomArtwork("track", "42");
  assert.equal(getCustomArtwork("track", "42"), null);
  assert.equal(fs.existsSync(saved.filePath), false);
});

test("custom artwork URLs use the protected image fetcher and become persistent files", async (t) => {
  const sourceUrl = "https://artwork.example/album.png";
  t.mock.method(globalThis, "fetch", async (input) => {
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
