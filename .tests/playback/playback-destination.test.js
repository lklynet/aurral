import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPlaybackDestination,
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  playbackOperationFailure,
} from "../../backend/services/playback/playbackDestination.js";

test("playlist snapshots keep Aurral identity and exact paths", () => {
  const first = createPlaybackPlaylistSnapshot({
    entityId: "flow-1",
    ownerUserId: 7,
    displayName: "Morning Mix",
    description: "A mix for the morning",
    tracks: [
      {
        path: " /music/Artist/Album/Track.flac ",
        title: "Track",
        artist: "Artist",
        album: "Album",
        durationMs: 245000,
        mbid: "recording-mbid",
      },
    ],
  });
  const renamed = createPlaybackPlaylistSnapshot({ ...first, displayName: "Early Mix" });

  assert.deepEqual(createPlaybackPlaylistIdentity(first), createPlaybackPlaylistIdentity(renamed));
  assert.equal(first.description, "A mix for the morning");
  assert.deepEqual(first.tracks[0], {
    path: " /music/Artist/Album/Track.flac ",
    title: "Track",
    artist: "Artist",
    album: "Album",
    durationMs: 245000,
    mbid: "recording-mbid",
  });
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.tracks));
  assert.ok(Object.isFrozen(first.tracks[0]));
});

test("operation failures are structured and invalid destinations fail early", () => {
  assert.deepEqual(
    playbackOperationFailure({
      code: "DESTINATION_UNAVAILABLE",
      message: "The destination did not respond",
      retryable: true,
    }),
    {
      ok: false,
      error: {
        code: "DESTINATION_UNAVAILABLE",
        message: "The destination did not respond",
        retryable: true,
      },
    },
  );
  assert.throws(
    () => assertPlaybackDestination({ testConnection() {} }),
    /PlaybackDestination\.ensureLibrary must be a function/,
  );
  assert.throws(
    () =>
      createPlaybackPlaylistSnapshot({
        entityId: "flow-1",
        displayName: "Broken",
        tracks: [{ path: "", title: "Track", artist: "Artist" }],
      }),
    /tracks\[0\]\.path must be a non-empty string/,
  );
});
