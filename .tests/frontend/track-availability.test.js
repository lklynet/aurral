import test from "node:test";
import assert from "node:assert/strict";
import { countAvailableTracks, getTrackAvailability } from "../../frontend/src/pages/flows/trackAvailability.js";

test("availability counts playable completed tracks, including tracks reused from another playlist", () => {
  const tracks = [
    { status: "done", streamUrl: "/stream/1" },
    { status: "done", streamUrl: "/stream/2", playlistType: "another-playlist" },
    { status: "done" },
    { status: "downloading" },
    { status: "pending" },
    { status: "failed" },
    { status: "blocked" },
  ];
  assert.equal(countAvailableTracks(tracks), 2);
  assert.equal(countAvailableTracks([]), 0);
  assert.deepEqual(tracks.map((track) => getTrackAvailability(track).label), [
    "Available", "Available", "Missing", "Downloading", "Queued", "Missing", "Needs review",
  ]);
  tracks[3] = { status: "done", streamUrl: "/stream/3" };
  assert.equal(countAvailableTracks(tracks), 3);
});
