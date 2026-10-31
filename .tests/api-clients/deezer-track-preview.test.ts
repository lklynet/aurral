import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { selectDeezerTrackPreview } from "../../backend/services/apiClients/deezer.ts";

test("Deezer preview matching requires the requested artist and track", () => {
  const preview = selectDeezerTrackPreview(
    [
      {
        id: 1,
        title: "Song",
        title_short: "Song",
        artist: { name: "Wrong Artist" },
        preview: "wrong.mp3",
      },
      {
        id: 2,
        title: "Song",
        title_short: "Song",
        artist: { name: "Artist" },
        preview: "right.mp3",
      },
    ],
    { artistName: "Artist", trackName: "Song" },
  );

  assert.equal(preview?.preview, "right.mp3");
});

test("Deezer preview matching accepts the main artist of a shared credit", () => {
  const preview = selectDeezerTrackPreview(
    [{ id: 1, title: "Wild Flower (with youjeen)", artist: { name: "RM" }, preview: "rm.mp3" }],
    { artistName: "RM, youjeen", trackName: "Wild Flower (with youjeen)" },
  );

  assert.equal(preview?.preview, "rm.mp3");
});
