import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { imageSizes, resizedImageWidth } from "../../lib/imageSizes.ts";

const urlsByWidth = (url: string) =>
  Object.fromEntries(imageSizes(url).map((size) => [size.width, size.url]));

test("artwork from fanart, Deezer, and Aurral covers offers every size its host serves", () => {
  assert.deepEqual(urlsByWidth("https://assets.fanart.tv/fanart/plaid-4fe86e55a9e8e.jpg"), {
    200: "https://assets.fanart.tv/preview/plaid-4fe86e55a9e8e.jpg",
    400: "https://assets.fanart.tv/bigpreview/plaid-4fe86e55a9e8e.jpg",
  });
  assert.deepEqual(
    urlsByWidth("https://cdn-images.dzcdn.net/images/artist/638e69b9/1000x1000-000000-80-0-0.jpg"),
    {
      120: "https://cdn-images.dzcdn.net/images/artist/638e69b9/120x120-000000-80-0-0.jpg",
      250: "https://cdn-images.dzcdn.net/images/artist/638e69b9/250x250-000000-80-0-0.jpg",
      500: "https://cdn-images.dzcdn.net/images/artist/638e69b9/500x500-000000-80-0-0.jpg",
      1000: "https://cdn-images.dzcdn.net/images/artist/638e69b9/1000x1000-000000-80-0-0.jpg",
    },
  );
  assert.deepEqual(urlsByWidth("/api/playlists/artwork/p1?v=7:0"), {
    128: "/api/playlists/artwork/p1?v=7:0&w=128",
    256: "/api/playlists/artwork/p1?v=7:0&w=256",
    512: "/api/playlists/artwork/p1?v=7:0&w=512",
    1000: "/api/playlists/artwork/p1?v=7:0",
  });
  assert.equal(
    imageSizes("/api/discover/playlists/mix/m1/cover?v=ab")[0]?.url,
    "/api/discover/playlists/mix/m1/cover?v=ab&w=128",
  );
  assert.equal(
    imageSizes("/api/playlists/flow-templates/release-radar/cover?v=b4")[0]?.url,
    "/api/playlists/flow-templates/release-radar/cover?v=b4&w=128",
  );
  assert.deepEqual(imageSizes("/api/playlists/artwork/p1/preview?title=x"), []);
  assert.deepEqual(
    imageSizes("https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg"),
    [],
  );
  assert.deepEqual(imageSizes("https://imagecache.lidarr.audio/v1/caa/r/1-1200.jpg"), []);
});

test("a requested width rounds up to a size Aurral resizes to, and past the largest keeps the original", () => {
  assert.equal(resizedImageWidth(60), 128);
  assert.equal(resizedImageWidth(300), 512);
  assert.equal(resizedImageWidth(600), null);
  assert.equal(resizedImageWidth(0), null);
  assert.equal(resizedImageWidth(Number.NaN), null);
});
