import test from "node:test";
import assert from "node:assert/strict";

import {
  pickBestCatalogAlbum,
  pickBestCatalogArtist,
  pickBestCatalogTrack,
} from "../../backend/services/weeklyFlowTrackResolver.js";

test("pickBestCatalogArtist prefers exact name match", () => {
  const match = pickBestCatalogArtist(
    [
      { id: "a1", name: "Radiohead", score: 90 },
      { id: "a2", name: "Radio Head", score: 95 },
    ],
    "Radiohead",
  );
  assert.equal(match?.id, "a1");
});

test("pickBestCatalogAlbum weighs artist and title together", () => {
  const match = pickBestCatalogAlbum(
    [
      {
        id: "rg1",
        title: "OK Computer",
        artistName: "Radiohead",
        artistMbid: "artist-1",
        score: 80,
      },
      {
        id: "rg2",
        title: "OK Computer",
        artistName: "Various Artists",
        artistMbid: "artist-2",
        score: 85,
      },
    ],
    "OK Computer",
    "Radiohead",
    "artist-1",
  );
  assert.equal(match?.id, "rg1");
});

test("pickBestCatalogTrack prefers aligned artist and album mbids", () => {
  const match = pickBestCatalogTrack(
    [
      {
        id: "rec-1",
        title: "Paranoid Android",
        artistName: "Radiohead",
        artistMbid: "artist-1",
        albumTitle: "OK Computer",
        albumMbid: "rg-1",
        score: 70,
      },
      {
        id: "rec-2",
        title: "Paranoid Android",
        artistName: "Radio Head",
        artistMbid: "artist-2",
        albumTitle: "Covers",
        albumMbid: "rg-2",
        score: 90,
      },
    ],
    {
      trackName: "Paranoid Android",
      artistName: "Radiohead",
      albumName: "OK Computer",
      artistMbid: "artist-1",
      albumMbid: "rg-1",
    },
  );
  assert.equal(match?.id, "rec-1");
});
