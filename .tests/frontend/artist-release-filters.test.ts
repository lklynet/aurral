import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  matchesReleaseGroupSearch,
  matchesReleaseGroupTab,
  preferStudioReleases,
} from "../../frontend/src/pages/ArtistDetails/releaseFilters.ts";

const release = (
  primaryType: string,
  secondaryTypes: string[] = [],
  title: string = "Release",
) => ({
  title,
  "primary-type": primaryType,
  "secondary-types": secondaryTypes,
});

test("hiding other releases applies across the regular release tabs", () => {
  const studioAlbum = release("Album");
  const liveAlbum = release("Album", ["Live"]);
  const remixAlbum = release("Album", ["Remix"]);
  const studioCompilation = release("Album", ["Compilation"]);
  const studioEp = release("EP");
  const liveEp = release("EP", ["Live"]);
  const liveCompilation = release("Album", ["Compilation", "Live"]);

  assert.equal(matchesReleaseGroupTab(studioAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all", false), false);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums", false), false);
  assert.equal(matchesReleaseGroupTab(remixAlbum, "albums", false), false);
  assert.equal(matchesReleaseGroupTab(studioCompilation, "compilations", false), true);
  assert.equal(matchesReleaseGroupTab(studioEp, "singles"), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles"), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles", false), false);
  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations"), true);
  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations", false), false);
});

test("studio releases fill a shelf unless the artist has none of that kind", () => {
  const studioAlbum = release("Album", [], "Studio");
  const liveAlbum = release("Album", ["Live"], "Live");
  const remixSingle = release("Single", ["Remix"], "Remix");
  const titles = (releaseGroups: { title: string }[]) => releaseGroups.map(({ title }) => title);

  assert.deepEqual(titles(preferStudioReleases([studioAlbum, liveAlbum], "albums")), ["Studio"]);
  assert.deepEqual(titles(preferStudioReleases([liveAlbum, remixSingle], "albums")), ["Live"]);
  assert.deepEqual(titles(preferStudioReleases([studioAlbum, liveAlbum, remixSingle], "singles")), [
    "Remix",
  ]);
});

test("release search matches titles without case or surrounding whitespace", () => {
  const item = release("Album", [], "Live at Leeds");

  assert.equal(matchesReleaseGroupSearch(item, "  LEEDS "), true);
  assert.equal(matchesReleaseGroupSearch(item, "studio"), false);
});
