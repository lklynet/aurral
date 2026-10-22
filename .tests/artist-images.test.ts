import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { selectBestAlbumImage, selectBestArtistImage } from "../backend/services/imageService.ts";

test("artist image selection prefers poster art over banners for square displays", () => {
  const selected = selectBestArtistImage([
    {
      kind: "Banner",
      url: "https://assets.fanart.tv/fanart/bieber-justin-50788c8b98378.jpg",
    },
    {
      kind: "Fanart",
      url: "https://assets.fanart.tv/fanart/bieber-justin-56167e6110c53.jpg",
    },
    {
      kind: "Logo",
      url: "https://assets.fanart.tv/fanart/bieber-justin-5c19a40664655.png",
    },
    {
      kind: "Poster",
      url: "https://assets.fanart.tv/fanart/bieber-justin-5375fe939e307.jpg",
    },
  ]);

  assert.equal(selected?.url, "https://assets.fanart.tv/fanart/bieber-justin-5375fe939e307.jpg");
});

test("album image selection prefers cover art and accepts BrainzMash casing", () => {
  const selected = selectBestAlbumImage([
    { kind: "Disc", url: "https://example.test/disc.png" },
    { kind: "Cover", url: "https://example.test/cover.jpg" },
  ]);
  assert.equal(selected?.url, "https://example.test/cover.jpg");

  const brainzmash = selectBestAlbumImage([
    { CoverType: "Disc", Url: "https://example.test/disc.png" },
    { CoverType: "Cover", Url: "https://example.test/cover.jpg" },
  ]);
  assert.equal(brainzmash?.Url, "https://example.test/cover.jpg");
});
