import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  countBucket,
  describeUserAgent,
  subsonicClientName,
  telemetryPageForPath,
} from "../../lib/telemetry.ts";

test("counts land in powers-of-ten buckets", () => {
  assert.deepEqual([0, 1, 2, 9, 10, 999, 1000, 99_999, 100_000, 5_000_000].map(countBucket), [
    "0",
    "1",
    "2-9",
    "2-9",
    "10-99",
    "100-999",
    "1k-9k",
    "10k-99k",
    "100k+",
    "100k+",
  ]);
});

test("user agents reduce to device, os, and browser", () => {
  assert.deepEqual(
    describeUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ),
    { device: "mobile", os: "ios", browser: "safari" },
  );
  assert.deepEqual(
    describeUserAgent(
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    ),
    { device: "tablet", os: "android", browser: "chrome" },
  );
  assert.deepEqual(
    describeUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
    ),
    { device: "desktop", os: "windows", browser: "edge" },
  );
});

test("Subsonic client names map to known clients and nothing else", () => {
  assert.equal(subsonicClientName("Symfonium"), "symfonium");
  assert.equal(subsonicClientName("play:Sub"), "playsub");
  assert.equal(subsonicClientName("DSub2000"), "dsub");
  assert.equal(subsonicClientName("my-home-server-script"), "other");
});

test("routes map to pages without carrying ids", () => {
  assert.equal(telemetryPageForPath("/"), "discover");
  assert.equal(telemetryPageForPath("/library/playlists/abc"), "playlists");
  assert.equal(telemetryPageForPath("/library/artist/42"), "library");
  assert.equal(telemetryPageForPath("/discover/news"), "news");
  assert.equal(telemetryPageForPath("/go/artist"), null);
});
