import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { buildTasteArtist } from "../../frontend/src/pages/ArtistDetails/utils.ts";
import { buildArtistFeedbackPayload } from "../../frontend/src/utils/artistTaste.ts";

test("artist page feedback sends tag names", () => {
  const artist = buildTasteArtist({
    id: "artist-1",
    name: "Plaid",
    tags: [
      { name: "idm", count: 12 },
      { name: "electronic", count: 9 },
    ],
    genres: ["IDM"],
  });
  const payload = buildArtistFeedbackPayload(artist, "more_like_this", {
    sourceContext: "artist_page",
  });
  assert.deepEqual(payload.tagContext, ["idm", "electronic"]);
});
