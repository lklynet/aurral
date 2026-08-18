import test from "node:test";
import assert from "node:assert/strict";

import {
  findCanonicalArtistByName,
  findCanonicalAlbumByName,
} from "../../frontend/src/utils/libraryTrackNavigation.js";

test("finds an imported artist when canonical metadata has no MBID", () => {
  const artist = findCanonicalArtistByName(
    [{ id: 906098, name: "Circle Jerks", mbid: null }],
    "Circle Jerks",
  );

  assert.equal(artist?.id, 906098);
});

test("finds an imported album by title and artist when canonical metadata has no MBID", () => {
  const album = findCanonicalAlbumByName(
    [{ id: 906098, title: "Wild In The Streets", albumArtist: "Circle Jerks" }],
    "Wild in the Streets",
    "Circle Jerks",
  );

  assert.equal(album?.id, 906098);
});
