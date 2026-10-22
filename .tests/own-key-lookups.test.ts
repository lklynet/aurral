import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { getKoitoPeriod } from "../backend/services/koitoClient.ts";
import { inspectImageBuffer } from "../backend/services/imageProxyService.ts";
import { getSourceLabel } from "../backend/services/downloadSourceService.ts";
import { selectBestAlbumImage } from "../backend/services/imageService.ts";

test("name lookups ignore inherited object properties", async () => {
  assert.equal(getKoitoPeriod("constructor"), "month");
  assert.equal(getSourceLabel("constructor"), "constructor");
  await assert.rejects(
    inspectImageBuffer(new Uint8Array(), "constructor"),
    /Unsupported image content type/,
  );
  const first = { url: "https://example.test/a.jpg", kind: "constructor" };
  const second = { url: "https://example.test/b.jpg", kind: "front" };
  assert.equal(selectBestAlbumImage([first, second]), second);
});
