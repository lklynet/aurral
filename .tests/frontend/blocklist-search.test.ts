import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { buildBlocklistArtistSuggestions } from "../../frontend/src/utils/blocklistSearch.ts";

test("blocklist suggestions include local artists when the catalog bucket is empty", () => {
  const suggestions = buildBlocklistArtistSuggestions({
    top: null,
    catalog: { artists: [] },
    library: {
      artists: [{ id: "radiohead", name: "Radiohead" }],
    },
  });

  assert.deepEqual(suggestions, [{ id: "radiohead", name: "Radiohead" }]);
});

test("blocklist suggestions combine and deduplicate unified artist results", () => {
  const suggestions = buildBlocklistArtistSuggestions(
    {
      top: {
        id: "radiohead",
        name: "Radiohead",
        type: "artist",
        source: "library",
        key: "artist:radiohead",
        sortName: "Radiohead",
        inLibrary: true,
        hasMbid: false,
        score: 1,
      },
      catalog: {
        artists: [
          { id: "radiohead", name: "Radiohead" },
          { id: "the-smile", name: "The Smile" },
        ],
      },
      library: {
        artists: [{ id: "atoms-for-peace", name: "Atoms for Peace" }],
      },
    },
    2,
  );

  assert.deepEqual(suggestions, [
    { id: "radiohead", name: "Radiohead" },
    { id: "the-smile", name: "The Smile" },
  ]);
});
