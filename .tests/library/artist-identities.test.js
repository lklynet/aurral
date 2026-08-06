import test from "node:test";
import assert from "node:assert/strict";

import { dbOps } from "../../backend/db/helpers/index.js";
import { libraryManager } from "../../backend/services/libraryManager.js";

const canonicalMbid = "b1f5d7e2-1d5c-4c9f-9d5f-3e7b4c1a2f68";
const providerArtistId = "1182@deezer";

test.after(() => {
  dbOps.deleteLidarrArtistIdMap(canonicalMbid);
});

test("mapped Lidarr artists expose canonical and provider IDs separately", () => {
  dbOps.setLidarrArtistIdMap(canonicalMbid, providerArtistId);

  const artist = libraryManager.mapLidarrArtist({
    id: 42,
    foreignArtistId: providerArtistId,
    artistName: "Arctic Monkeys",
  });

  assert.equal(artist.mbid, canonicalMbid);
  assert.equal(artist.foreignArtistId, providerArtistId);
});

test("unmapped provider IDs are not exposed as canonical MBIDs", () => {
  const artist = libraryManager.mapLidarrArtist({
    id: 43,
    foreignArtistId: "999999@deezer",
    artistName: "Unmapped Artist",
  });

  assert.equal(artist.mbid, null);
  assert.equal(artist.foreignArtistId, "999999@deezer");
});
