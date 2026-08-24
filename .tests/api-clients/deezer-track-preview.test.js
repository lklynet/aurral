import assert from "node:assert/strict";
import test from "node:test";

import { selectDeezerTrackPreview } from "../../backend/services/apiClients/deezer.js";

test("Deezer preview matching requires the requested artist and track", () => {
  const preview = selectDeezerTrackPreview([
    { id: 1, title_short: "Song", artist: { name: "Wrong Artist" }, preview: "wrong.mp3" },
    { id: 2, title_short: "Song", artist: { name: "Artist" }, preview: "right.mp3" },
  ], { artistName: "Artist", trackName: "Song" });

  assert.equal(preview?.preview, "right.mp3");
});
