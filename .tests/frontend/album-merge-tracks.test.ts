import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mergeAlbumTracks } from "../../frontend/src/pages/album/mergeAlbumTracks.ts";

const release = (mbid: string, title: string, trackNumber: number, discNumber = 1) => ({
  id: mbid,
  mbid,
  title,
  trackNumber,
  position: trackNumber,
  discNumber,
});
const owned = (
  id: number,
  title: string,
  trackNumber: number,
  { mbid = "", discNumber = 1, albumId = 5 } = {},
) => ({ id, mbid, title, albums: [{ albumId, discNumber, trackNumber }] });

const shape = (rows: ReturnType<typeof mergeAlbumTracks>) =>
  rows.map((row) => [
    row.key,
    row.libraryTrack ? row.libraryTrack.id : null,
    row.releaseTrack ? row.releaseTrack.mbid : null,
    row.disc,
    row.number,
  ]);

test("library tracks attach to the MusicBrainz track with the same recording", () => {
  const rows = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [release("r1", "Intro", 1), release("r2", "Song", 2), release("r3", "Outro", 3)],
    libraryTracks: [
      owned(11, "Intro", 1, { mbid: "r1" }),
      owned(13, "Outro (Live)", 3, { mbid: "r3" }),
    ],
  });
  assert.deepEqual(shape(rows), [
    ["11", 11, "r1", 1, 1],
    ["r2", null, "r2", 1, 2],
    ["13", 13, "r3", 1, 3],
  ]);
});

test("without a shared recording, the same position and title still match", () => {
  const rows = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [release("new-1", "Café Society!", 1)],
    libraryTracks: [owned(21, "cafe society", 1, { mbid: "merged-away" })],
  });
  assert.deepEqual(shape(rows), [["21", 21, "new-1", 1, 1]]);

  const differentTitle = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [release("new-1", "Opening", 1)],
    libraryTracks: [owned(21, "Something Else", 1)],
  });
  assert.deepEqual(shape(differentTitle), [
    ["new-1", null, "new-1", 1, 1],
    ["21", 21, null, 1, 1],
  ]);
});

test("library-only tracks slot in at their disc and track position", () => {
  const rows = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [release("a1", "One", 1), release("a2", "Two", 2), release("b1", "Three", 1, 2)],
    libraryTracks: [
      owned(40, "Hidden Track", 3),
      owned(41, "Disc Two Bonus", 2, { discNumber: 2 }),
      owned(42, "Unnumbered Demo", 0),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.key),
    ["a1", "a2", "40", "42", "b1", "41"],
  );
});

test("an album known only to the library or only to MusicBrainz keeps its order", () => {
  const libraryOnly = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [],
    libraryTracks: [owned(2, "B", 2), owned(1, "A", 1)],
  });
  assert.deepEqual(
    libraryOnly.map((row) => [row.key, row.number]),
    [
      ["1", 1],
      ["2", 2],
    ],
  );

  const releaseOnly = mergeAlbumTracks({
    libraryTracks: null,
    releaseTracks: [{ title: "No Id", trackNumber: 0, position: 0 }],
    releaseKey: "rg",
  });
  assert.deepEqual(
    releaseOnly.map((row) => [row.key, row.number]),
    [["rg-0", 1]],
  );
});

test("a recording is only matched once", () => {
  const rows = mergeAlbumTracks({
    libraryAlbumId: 5,
    releaseTracks: [release("dup", "Same", 1), release("dup", "Same", 2)],
    libraryTracks: [owned(7, "Same", 1, { mbid: "dup" })],
  });
  assert.deepEqual(
    rows.map((row) => [row.key, row.libraryTrack?.id ?? null]),
    [
      ["7", 7],
      ["dup", null],
    ],
  );
});
