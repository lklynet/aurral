import test from "node:test";
import assert from "node:assert/strict";

import { mergeAlbumMetadataTracks } from "../../frontend/src/utils/libraryTrackHydration.js";

test("merges release metadata with owned album tracks in track order", () => {
  const tracks = mergeAlbumMetadataTracks(
    [
      {
        id: 9,
        mbid: "owned-recording",
        title: "Owned title",
        trackNumber: 3,
        available: true,
        files: [{ available: true, durationMs: 180000 }],
      },
    ],
    [
      { mbid: "missing-one", title: "Missing one", position: 1, length: 123000 },
      { mbid: "missing-two", title: "Missing two", position: 2, length: 124000 },
      { mbid: "metadata-recording", title: "Owned title", position: 3, length: 180000 },
    ],
    {
      id: 42,
      title: "Album",
      mbid: "album-mbid",
      releaseGroupMbid: "release-group-mbid",
    },
    { id: 7, name: "Artist", mbid: "artist-mbid" },
  );

  assert.deepEqual(
    tracks.map((track) => [track.trackNumber, track.title, track.available]),
    [
      [1, "Missing one", false],
      [2, "Missing two", false],
      [3, "Owned title", true],
    ],
  );
  assert.equal(tracks[0].durationMs, 123000);
  assert.deepEqual(tracks[0].albums, [{ albumId: 42, discNumber: 1, trackNumber: 1 }]);
});
