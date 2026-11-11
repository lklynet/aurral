import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { getArtistType } from "../../frontend/src/pages/ArtistDetails/utils.ts";

test("artist types that are not known labels show as written", () => {
  assert.equal(getArtistType("Person"), "Solo artist");
  assert.equal(getArtistType("constructor"), "constructor");
  assert.equal(getArtistType(null), null);
});
