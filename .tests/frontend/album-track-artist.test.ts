import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { VARIOUS_ARTISTS_MBID, albumTrackArtist } from "../../lib/artistCredit.ts";

test.each([
  ["a compilation credited by name", "Various Artists", null, "Rina Sawayama", "Rina Sawayama"],
  ["a compilation credited by MBID", "Soundtrack", VARIOUS_ARTISTS_MBID, "Fcukers", "Fcukers"],
  ["a compilation whose track has no artist", "VA", null, "", "VA"],
  ["an artist's own album", "Daft Punk", "mbid", "Daft Punk feat. Pharrell", "Daft Punk"],
  ["an album with no artist", null, null, "Arca", "Arca"],
])("names the track on %s for the right artist", (_, album, mbid, track, expected) => {
  assert.equal(albumTrackArtist(album, mbid, track), expected);
});
