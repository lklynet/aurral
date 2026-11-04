import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  matchesPlaylistTrackQuery,
  sortPlaylistTracks,
} from "../../frontend/src/utils/playlistTrackSort.ts";

const tracks = [
  {
    id: "a",
    trackName: "Nights",
    artistName: "Frank Ocean",
    albumName: "Blonde",
    releaseYear: "2016",
  },
  {
    id: "b",
    trackName: "Pink Moon",
    artistName: "Nick Drake",
    albumName: "Pink Moon",
    releaseYear: "1972",
  },
  { id: "c", trackName: "Demo", artistName: "Local Artist", albumName: null, releaseYear: null },
  {
    id: "d",
    trackName: "Holocene",
    artistName: "Bon Iver",
    albumName: "Bon Iver",
    releaseYear: "2011",
  },
];

test("year sort orders by release year and keeps playlist order for ties", () => {
  const ids = (direction: string) =>
    sortPlaylistTracks(tracks, "year", direction).map((track) => track.id);

  assert.deepEqual(ids("asc"), ["c", "b", "d", "a"]);
  assert.deepEqual(ids("desc"), ["a", "d", "b", "c"]);
});

test("track search matches title, artist, or album ignoring the case of track fields", () => {
  const matches = (query: string) =>
    tracks.filter((track) => matchesPlaylistTrackQuery(track, query)).map((track) => track.id);

  assert.deepEqual(matches("drake"), ["b"]);
  assert.deepEqual(matches("blonde"), ["a"]);
  assert.deepEqual(matches("iver"), ["d"]);
  assert.deepEqual(matches("zzz"), []);
});
