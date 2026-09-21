import test from "node:test";
import assert from "node:assert/strict";
import {
  countAvailableTracks,
  getTrackAvailability,
  getTrackSearchAction,
  shouldShowAddToLibrary,
} from "../../frontend/src/pages/flows/trackAvailability.js";

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

test("completed tracks without a stream URL offer a fresh search when availability is enabled", () => {
  for (const streamUrl of [undefined, null, ""]) {
    for (const qualityState of ["preferred", "upgrade"]) {
      const track = { status: "done", streamUrl, qualityOwned: true, qualityState };
      assert.equal(getTrackAvailability(track).label, "Missing");
      assert.equal(getTrackSearchAction(track, true), "research");
    }
  }
});

test("availability search actions exclude available, queued, downloading and review tracks", () => {
  assert.equal(getTrackSearchAction({ status: "failed" }, true), "research");
  for (const status of ["pending", "downloading", "blocked"]) {
    assert.equal(getTrackSearchAction({ status }, true), null);
  }
  assert.equal(getTrackSearchAction({ status: "done", streamUrl: "/stream/1", qualityOwned: true, qualityState: "upgrade" }, true), null);
});

test("existing flow searches retain their upgrade eligibility rules", () => {
  assert.equal(getTrackSearchAction({ status: "failed" }), "research");
  assert.equal(getTrackSearchAction({ status: "done", qualityOwned: true, qualityState: "upgrade" }), "upgrade");
  assert.equal(getTrackSearchAction({ status: "done", qualityOwned: true, qualityState: "preferred" }), null);
  assert.equal(getTrackSearchAction({ status: "done", qualityOwned: false, qualityState: "upgrade" }), null);
});

test("library-owned tracks do not offer the add-to-library action", () => {
  const addToLibrary = () => {};

  assert.equal(shouldShowAddToLibrary({ libraryOwned: true }, addToLibrary), false);
  assert.equal(shouldShowAddToLibrary({ libraryOwned: false }, addToLibrary), true);
  assert.equal(shouldShowAddToLibrary({}, addToLibrary), true);
  assert.equal(shouldShowAddToLibrary({ libraryOwned: true }, null), false);
});
