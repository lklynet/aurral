import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("image cache migration removes obsolete web image bytes but keeps native bytes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-migration-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const cacheDir = path.join(dataDir, "image-proxy");
    await fs.mkdir(cacheDir, { recursive: true });
    const entries = [
      ["a".repeat(64), "card"],
      ["b".repeat(64), "artist"],
      ["c".repeat(64), undefined],
      ["d".repeat(64), "library"],
    ];
    for (const [cacheKey, profile] of entries) {
      await fs.writeFile(path.join(cacheDir, `${cacheKey}.webp`), cacheKey);
      await fs.writeFile(
        path.join(cacheDir, `${cacheKey}.json`),
        JSON.stringify({
          sourceUrl: `https://images.example/${cacheKey}.jpg`,
          contentType: "image/webp",
          extension: "webp",
          fetchedAt: Date.now(),
          profile,
        }),
      );
    }

    const { getImageProxyCacheSizeBytes } = await import(
      `../backend/services/imageProxyService.js?migration-test=${Date.now()}`
    );
    assert.equal(await getImageProxyCacheSizeBytes(), entries[3][0].length);

    for (const [cacheKey, profile] of entries) {
      if (profile === "library") {
        assert.ok(await fs.stat(path.join(cacheDir, `${cacheKey}.webp`)));
      } else {
        await assert.rejects(fs.access(path.join(cacheDir, `${cacheKey}.webp`)), /ENOENT/);
      }
      assert.ok(await fs.stat(path.join(cacheDir, `${cacheKey}.json`)));
    }
    assert.ok(await fs.stat(path.join(dataDir, ".image-cache-links-v1")));
  } finally {
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
