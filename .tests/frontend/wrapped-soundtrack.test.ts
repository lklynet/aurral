import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { WrappedRecap } from "../../frontend/src/hooks/useWrapped.ts";
import { wrappedSoundtrack } from "../../frontend/src/utils/wrappedSoundtrack.ts";

const song = (name: string, artist: string, album: string, source: "preview" | "file" | null) => ({
  key: name,
  name,
  artist,
  album,
  plays: 1,
  minutes: null,
  firstPlayedAt: 0,
  artwork: null,
  color: null,
  mbid: null,
  preview: source === "preview" ? `/api/deezer/preview/${name}.mp3` : null,
  libraryTrackId: source === "file" ? 1 : null,
  libraryAlbumId: source === "file" ? 1 : null,
});

const summary = {
  topSongs: [
    song("First", "The Chariot", "Long Live", "preview"),
    song("Ink", "The Used", "The Used", "preview"),
    song("Unplayable", "Nobody", "Nothing", null),
    song("Sheena", "Avoid One Thing", "Avoid One Thing", "file"),
    song("Caroline", "Coma Cinema", "Posthumous Release", "preview"),
    song("Wild", "Head Automatica", "Popaganda", "preview"),
  ],
  topArtists: [{ name: "The Chariot" }],
  topAlbums: [{ name: "Popaganda", artist: "Head Automatica" }],
} as unknown as WrappedRecap;

const kinds = [
  "opening",
  "minutes",
  "variety",
  "genre",
  "artist",
  "artists",
  "song",
  "songs",
  "album",
  "months",
  "day",
  "streak",
  "hour",
  "share",
];

test("each song covers two slides, the opening keeps its own, and nothing repeats early", () => {
  const names = wrappedSoundtrack(summary, kinds).map((cue) => cue?.song.name);
  assert.deepEqual(names, [
    "Ink",
    "Sheena",
    "Sheena",
    "Caroline",
    "Caroline",
    "First",
    "First",
    "Wild",
    "Wild",
    "Wild",
    "Wild",
    "Wild",
    "Wild",
    "Wild",
  ]);
});

test("slides that name a song play it once, and library files fill in for missing previews", () => {
  const cues = wrappedSoundtrack(summary, kinds);
  const named = cues.flatMap((cue, index) => (cue?.named ? [kinds[index]] : []));
  assert.deepEqual(named, ["song", "album"]);
  assert.equal(cues[1]?.song.libraryTrackId, 1);
});
