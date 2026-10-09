import assert from "node:assert/strict";
import test from "node:test";

import { formatPlaybackTime } from "../../frontend/src/utils/playbackTime.js";

test("playback times show minutes and seconds, and hours once a track reaches an hour", () => {
  assert.equal(formatPlaybackTime(0), "0:00");
  assert.equal(formatPlaybackTime(59.9), "0:59");
  assert.equal(formatPlaybackTime(61), "1:01");
  assert.equal(formatPlaybackTime(3599), "59:59");
  assert.equal(formatPlaybackTime(3600), "1:00:00");
  assert.equal(formatPlaybackTime(3725), "1:02:05");
  assert.equal(formatPlaybackTime(36125), "10:02:05");
});

test("missing or broken times read as zero", () => {
  assert.equal(formatPlaybackTime(Number.NaN), "0:00");
  assert.equal(formatPlaybackTime(-5), "0:00");
  assert.equal(formatPlaybackTime(Number.POSITIVE_INFINITY), "0:00");
});
