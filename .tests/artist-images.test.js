import test from "node:test";
import assert from "node:assert/strict";

import {
  selectBestAlbumImage,
  selectBestArtistImage,
} from "../backend/services/imageService.js";

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

  assert.equal(
    selected?.url,
    "https://assets.fanart.tv/fanart/bieber-justin-5375fe939e307.jpg",
  );
});

test("artist image selection keeps source order when image types tie", () => {
  const selected = selectBestArtistImage([
    { kind: "Fanart", url: "https://example.test/first.jpg" },
    { kind: "Fanart", url: "https://example.test/second.jpg" },
  ]);

  assert.equal(selected?.url, "https://example.test/first.jpg");
});

test("album image selection prefers cover art over disc art", () => {
  const selected = selectBestAlbumImage([
    { kind: "Disc", url: "https://example.test/disc.png" },
    { kind: "Cover", url: "https://example.test/cover.jpg" },
  ]);

  assert.equal(selected?.url, "https://example.test/cover.jpg");
});


test("album image selection accepts raw BrainzMash image casing", () => {
  const selected = selectBestAlbumImage([
    { CoverType: "Disc", Url: "https://example.test/disc.png" },
    { CoverType: "Cover", Url: "https://example.test/cover.jpg" },
  ]);

  assert.equal(selected?.Url, "https://example.test/cover.jpg");
});

import { isPrivateHostname } from "../backend/services/imageProxyService.js";

test("isPrivateHostname blocks local and loopback addresses", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("127.0.0.1"), true);
  assert.equal(isPrivateHostname("127.255.0.1"), true);
  assert.equal(isPrivateHostname("10.0.0.1"), true);
  assert.equal(isPrivateHostname("192.168.1.5"), true);
  assert.equal(isPrivateHostname("[::1]"), true);
  assert.equal(isPrivateHostname("example.local"), true);
  assert.equal(isPrivateHostname("example.com"), false);
  assert.equal(isPrivateHostname("127a.com"), false);
});

