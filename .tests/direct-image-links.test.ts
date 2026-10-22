import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  buildImageProxyUrl,
  buildStableImageProxyUrl,
} from "../backend/services/imageProxyService.ts";
import { withImageCacheBust } from "../frontend/src/utils/normalizeMediaUrl.ts";

test("image links return source URLs by default", () => {
  const source = "https://images.example/artist.jpg?size=512&format=webp";

  assert.equal(buildImageProxyUrl(source), source);
  assert.equal(
    buildStableImageProxyUrl("/api/image-proxy?src=" + encodeURIComponent(source)),
    source,
  );
});

test("image retry URLs bypass a cached browser failure without changing the source path", () => {
  const source = "https://images.example/artist.jpg?size=512#cover";
  const retry = withImageCacheBust(source);

  assert.match(
    retry,
    /^https:\/\/images\.example\/artist\.jpg\?size=512&aurral_image_retry=\d+#cover$/,
  );
});

test("missing local image cache entries do not return dead proxy links", () => {
  const missing = `/api/image-proxy/${"f".repeat(64)}.webp`;

  assert.equal(buildStableImageProxyUrl(missing), null);
});
