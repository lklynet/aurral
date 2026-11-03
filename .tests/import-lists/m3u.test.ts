import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseM3u } from "../../lib/m3u.ts";

test("reads artist and title from EXTINF and skips duplicates", () => {
  const { tracks, skipped, name } = parseM3u(
    [
      "\uFEFF#EXTM3U",
      "#PLAYLIST:Road Trip",
      "#EXTINF:215,Boards of Canada - Roygbiv",
      "../Boards of Canada/Music Has the Right to Children/05 Roygbiv.flac",
      "#EXTINF:-1,boards of canada - roygbiv",
      "C:\\Music\\other.mp3",
    ].join("\r\n"),
  );
  assert.equal(name, "Road Trip");
  assert.deepEqual(tracks, [
    {
      artistName: "Boards of Canada",
      trackName: "Roygbiv",
      albumName: "Music Has the Right to Children",
      durationMs: 215_000,
    },
  ]);
  assert.equal(skipped, 1);
});

test("falls back to the Artist/Album/Track folder layout", () => {
  const { tracks } = parseM3u(
    [
      "/music/Aphex Twin/Syro/01 - minipops 67 [120.2][source field mix].flac",
      "file:///music/Burial/Untrue/1-02%20Archangel.mp3",
      "Burial - Near Dark.mp3",
    ].join("\n"),
  );
  assert.deepEqual(
    tracks.map((track) => [track.artistName, track.trackName, track.albumName]),
    [
      ["Aphex Twin", "minipops 67 [120.2][source field mix]", "Syro"],
      ["Burial", "Archangel", "Untrue"],
      ["Burial", "Near Dark", null],
    ],
  );
});

test("uses EXTART and EXTALB and skips entries it cannot name", () => {
  const { tracks, skipped } = parseM3u(
    [
      "#EXTINF:180,Windowlicker",
      "#EXTART:Aphex Twin",
      "#EXTALB:Windowlicker",
      "track.flac",
      "https://stream.example/radio",
      "untitled.mp3",
    ].join("\n"),
  );
  assert.deepEqual(tracks, [
    {
      artistName: "Aphex Twin",
      trackName: "Windowlicker",
      albumName: "Windowlicker",
      durationMs: 180_000,
    },
  ]);
  assert.equal(skipped, 2);
});

test("keeps a title with a dash when EXTART names the artist", () => {
  const { tracks } = parseM3u(
    [
      "#EXTART:Wilco",
      "#EXTINF:200,Love - Part II",
      "a.mp3",
      "#EXTART:Wilco",
      "#EXTINF:200,wilco - Jesus, Etc.",
      "b.mp3",
    ].join("\n"),
  );
  assert.deepEqual(
    tracks.map((track) => [track.artistName, track.trackName]),
    [
      ["Wilco", "Love - Part II"],
      ["Wilco", "Jesus, Etc."],
    ],
  );
});
