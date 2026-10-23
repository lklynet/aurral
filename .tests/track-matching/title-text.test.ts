import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { withoutFeaturedArtists } from "../../backend/services/trackMatching/titleText.ts";

test("withoutFeaturedArtists keeps the lead artist or title", () => {
  assert.equal(withoutFeaturedArtists("Koyo feat. DRAIN"), "Koyo");
  assert.equal(withoutFeaturedArtists("Song ft Guest & Other"), "Song");
  assert.equal(withoutFeaturedArtists("Featuring Ghosts"), "Featuring Ghosts");
});

test("withoutFeaturedArtists stays fast on long runs of spaces", { timeout: 1_000 }, () => {
  const spaces = " ".repeat(100_000);
  assert.equal(withoutFeaturedArtists(`a${spaces}b`), `a${spaces}b`);
  assert.equal(withoutFeaturedArtists(`a ft${spaces}b`), "a");
});
