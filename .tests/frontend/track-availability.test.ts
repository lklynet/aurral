import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  countAvailableTracks,
  getTrackAvailability,
  getTrackSearchAction,
} from "../../frontend/src/pages/playlists/trackAvailability.ts";

test("availability counts playable completed tracks, including tracks reused from another playlist", () => {
  const tracks: (Parameters<typeof getTrackAvailability>[0] & { playlistType?: string })[] = [
    { id: "track", status: "done", streamUrl: "/stream/1" },
    { id: "track", status: "done", streamUrl: "/stream/2", playlistType: "another-playlist" },
    { id: "track", status: "done" },
    { id: "track", status: "downloading" },
    { id: "track", status: "pending" },
    { id: "track", status: "failed" },
    { id: "track", status: "blocked" },
  ];
  assert.equal(countAvailableTracks(tracks), 2);
  assert.equal(countAvailableTracks([]), 0);
  assert.deepEqual(
    tracks.map((track) => getTrackAvailability(track).label),
    ["Available", "Available", "Missing", "Downloading", "Queued", "Missing", "Needs review"],
  );
  tracks[3] = { id: "track", status: "done", streamUrl: "/stream/3" };
  assert.equal(countAvailableTracks(tracks), 3);
});

test("completed tracks without a stream URL offer a fresh search when availability is enabled", () => {
  for (const streamUrl of [undefined, null, ""]) {
    for (const qualityState of ["preferred", "upgrade"]) {
      const track = {
        id: "track",
        status: "done" as const,
        streamUrl,
        qualityOwned: true,
        qualityState,
      };
      assert.equal(getTrackAvailability(track).label, "Missing");
      assert.equal(getTrackSearchAction(track, true), "research");
    }
  }
});

test("availability search actions exclude available, queued, downloading and review tracks", () => {
  assert.equal(getTrackSearchAction({ id: "track", status: "failed" }, true), "research");
  for (const status of ["pending", "downloading", "blocked"] as const) {
    assert.equal(getTrackSearchAction({ id: "track", status }, true), null);
  }
  assert.equal(
    getTrackSearchAction(
      {
        id: "track",
        status: "done",
        streamUrl: "/stream/1",
        qualityOwned: true,
        qualityState: "upgrade",
      },
      true,
    ),
    null,
  );
});

test("existing flow searches retain their upgrade eligibility rules", () => {
  assert.equal(getTrackSearchAction({ id: "track", status: "failed" }), "research");
  assert.equal(
    getTrackSearchAction({
      id: "track",
      status: "done",
      qualityOwned: true,
      qualityState: "upgrade",
    }),
    "upgrade",
  );
  assert.equal(
    getTrackSearchAction({
      id: "track",
      status: "done",
      qualityOwned: true,
      qualityState: "preferred",
    }),
    null,
  );
  assert.equal(
    getTrackSearchAction({
      id: "track",
      status: "done",
      qualityOwned: false,
      qualityState: "upgrade",
    }),
    null,
  );
});
