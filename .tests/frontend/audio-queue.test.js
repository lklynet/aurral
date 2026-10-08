import assert from "node:assert/strict";
import test from "node:test";

import { normalizePlaylistQueueTrack, normalizePreviewTrack } from "../../frontend/src/utils/audioQueue.js";

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

test("previews and playlist tracks keep their cover so the player and album-art theme can show it", () => {
  const topTrack = normalizePreviewTrack(
    { id: "1", title: "Song", preview_url: "https://p/1.mp3", artworkUrl: "https://c/top.jpg" },
    "Artist",
  );
  assert.equal(topTrack.artwork, "https://c/top.jpg");

  const releaseTrack = normalizePreviewTrack(
    { id: "2", title: "Song", preview_url: "https://p/2.mp3" },
    "Artist",
    { artwork: "https://c/release.jpg" },
  );
  assert.equal(releaseTrack.artwork, "https://c/release.jpg");

  const editorialTrack = normalizePlaylistQueueTrack({ ...track, artworkUrl: "https://c/editorial.jpg" });
  assert.equal(editorialTrack.artwork, "https://c/editorial.jpg");
});
