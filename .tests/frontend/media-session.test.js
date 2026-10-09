import assert from "node:assert/strict";
import test from "node:test";

import { mediaSessionArtwork, mediaSessionPosition } from "../../frontend/src/utils/mediaSession.js";

const page = "https://aurral.example/library";

test("lock-screen artwork names its size and type when the cover URL shows them", () => {
  assert.deepEqual(
    mediaSessionArtwork("https://e-cdns-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg", page),
    [{
      src: "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg",
      sizes: "500x500",
      type: "image/jpeg",
    }],
  );
  assert.deepEqual(
    mediaSessionArtwork("https://coverartarchive.org/release-group/abc/front-250", page),
    [{ src: "https://coverartarchive.org/release-group/abc/front-250", sizes: "250x250" }],
  );
  assert.deepEqual(mediaSessionArtwork("/api/image-proxy/abc.png", page), [
    { src: "https://aurral.example/api/image-proxy/abc.png", type: "image/png" },
  ]);
  assert.deepEqual(mediaSessionArtwork(null, page), []);
});

test("lock-screen position stays inside the track and clears without a usable duration", () => {
  assert.deepEqual(mediaSessionPosition(60, 12.5), { duration: 60, position: 12.5, playbackRate: 1 });
  assert.deepEqual(mediaSessionPosition(60, 75), { duration: 60, position: 60, playbackRate: 1 });
  assert.deepEqual(mediaSessionPosition(60, Number.NaN), { duration: 60, position: 0, playbackRate: 1 });
  assert.equal(mediaSessionPosition(0, 5), null);
  assert.equal(mediaSessionPosition(Number.POSITIVE_INFINITY, 5), null);
  assert.equal(mediaSessionPosition(Number.NaN, 5), null);
});
