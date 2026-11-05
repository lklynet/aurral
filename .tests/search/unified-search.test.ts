import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  MATCH,
  matchQuality,
  parseSearchQuery,
  searchDocument,
} from "../../backend/services/searchText.ts";

test("parseSearchQuery joins short words to their neighbours", () => {
  assert.deepEqual(parseSearchQuery("AC/DC")?.terms, ["acdc"]);
  assert.deepEqual(parseSearchQuery("as long as you love me")?.terms, [
    "aslongas",
    "you",
    "loveme",
  ]);
  assert.deepEqual(parseSearchQuery("Beyoncé & Jay-Z")?.terms, ["beyonce", "and", "jayz"]);
  assert.equal(parseSearchQuery(" -- "), null);
});

test("matchQuality ignores case, punctuation, diacritics and a leading article", () => {
  const cases: [query: string, text: string, quality: number][] = [
    ["acdc", "AC/DC", MATCH.exact],
    ["ac dc", "AC/DC", MATCH.exact],
    ["sigur ros", "Sigur Rós", MATCH.exact],
    ["beatles", "The Beatles", MATCH.exact],
    ["dont stop me now", "Don’t Stop Me Now", MATCH.exact],
    ["radio", "Radiohead", MATCH.prefix],
    ["love me as long as you", "As Long As You Love Me", MATCH.words],
    ["the used", "The 1975", MATCH.none],
    ["backstreet boys", "Backstreet", MATCH.words],
    ["backstreet boys", "Boys", MATCH.none],
  ];
  for (const [query, text, quality] of cases) {
    const parsed = parseSearchQuery(query);
    assert.ok(parsed);
    assert.equal(matchQuality(parsed, text), quality, `${query} -> ${text}`);
  }
});

test("searchDocument keys every field once so terms match across fields", () => {
  assert.equal(
    searchDocument("Lantern Song", "Harbor Collective\u001fHarbor Collective", "Quiet Harbor"),
    "lanternsong harborcollective quietharbor",
  );
});
