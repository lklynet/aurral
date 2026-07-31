import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("warmPublicImageUrl rejects empty values and failed upstream fetches", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-warm-public-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const { warmPublicImageUrl } = await import(
      `../backend/services/imageProxyService.js?warm-public=${Date.now()}`
    );
    assert.equal(await warmPublicImageUrl(""), null);
    assert.equal(await warmPublicImageUrl("NOT_FOUND"), null);
    assert.equal(await warmPublicImageUrl(null), null);

    global.fetch = async () => {
      throw new Error("upstream down");
    };
    assert.equal(
      await warmPublicImageUrl("https://assets.fanart.tv/fanart/missing.jpg"),
      null,
    );
  } finally {
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
