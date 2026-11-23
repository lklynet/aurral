import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  buildImageProxyUrl,
  buildStableImageProxyUrl,
} from "../backend/services/imageProxyService.ts";
import { normalizeMediaUrl, withImageCacheBust } from "../frontend/src/utils/normalizeMediaUrl.ts";

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

test("Wikimedia Special:FilePath and Lidarr CAA proxy URLs rewrite to direct CORS-enabled hosts", () => {
  assert.equal(
    buildStableImageProxyUrl(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Four_Letter_Lie_post_hardcore_band_based_out_of_Minneapolis_MN.jpg?width=960",
    ),
    "https://upload.wikimedia.org/wikipedia/commons/4/4d/Four_Letter_Lie_post_hardcore_band_based_out_of_Minneapolis_MN.jpg",
  );
  assert.equal(
    buildStableImageProxyUrl("https://imagecache.lidarr.audio/v1/caa/r1/123.jpg"),
    "https://coverartarchive.org/release/r1/123.jpg",
  );
  assert.equal(
    normalizeMediaUrl("https://imagecache.lidarr.audio/v1/caa/r1/123.jpg"),
    "https://coverartarchive.org/release/r1/123.jpg",
  );
});
