import assert from "node:assert/strict";
import test from "node:test";

import { normalizePlaylistQueueTrack } from "../../frontend/src/utils/audioQueue.js";

const track = {
  id: "flow-track",
  trackName: "Track",
  artistName: "Artist",
  streamUrl: "/stream/flow-track",
};

test("flow playback can opt out of listening history", () => {
  assert.equal(normalizePlaylistQueueTrack(track).recordHistory, true);
  assert.equal(
    normalizePlaylistQueueTrack(track, { recordHistory: false }).recordHistory,
    false,
  );
});
