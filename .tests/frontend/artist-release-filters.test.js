import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesReleaseGroupSearch,
  matchesReleaseGroupTab,
} from "../../frontend/src/pages/ArtistDetails/releaseFilters.js";

const release = (primaryType, secondaryTypes = [], title = "Release") => ({
  title,
  "primary-type": primaryType,
  "secondary-types": secondaryTypes,
});

test("the live toggle applies across the regular release tabs", () => {
  const studioAlbum = release("Album");
  const liveAlbum = release("Album", ["Live"]);
  const studioEp = release("EP");
  const liveEp = release("EP", ["Live"]);
  const liveCompilation = release("Album", ["Compilation", "Live"]);

  assert.equal(matchesReleaseGroupTab(studioAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all", false), false);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums", false), false);
  assert.equal(matchesReleaseGroupTab(studioEp, "singles"), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles"), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles", false), false);
  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations"), true);
  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations", false), false);
});

test("release search matches titles without case or surrounding whitespace", () => {
  const item = release("Album", [], "Live at Leeds");

  assert.equal(matchesReleaseGroupSearch(item, "  LEEDS "), true);
  assert.equal(matchesReleaseGroupSearch(item, "studio"), false);
});
