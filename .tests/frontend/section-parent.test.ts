import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { createSectionParents } from "../../frontend/src/navigation/sectionParent.ts";

test("detail pages keep the section they were opened from, including after going back", () => {
  const resolve = createSectionParents();
  const sectionAt = (key: string, pathname: string) => resolve(key, pathname)?.id ?? null;

  assert.equal(sectionAt("a", "/discover/trending"), "discover");
  assert.equal(sectionAt("b", "/artist/1"), "discover");
  assert.equal(sectionAt("c", "/library/albums"), "library");
  assert.equal(sectionAt("d", "/album/2"), "library");
  assert.equal(sectionAt("e", "/library/playlists/3"), "library");
  assert.equal(sectionAt("b", "/artist/1"), "discover");
  assert.equal(sectionAt("f", "/album/4"), "discover");
  assert.equal(sectionAt("g", "/flows"), null);
  assert.equal(sectionAt("h", "/artist/5"), "discover");
  assert.equal(sectionAt("i", "/library/artist/6"), "discover");
  assert.equal(sectionAt("j", "/library/playlists/7"), "discover");
});
