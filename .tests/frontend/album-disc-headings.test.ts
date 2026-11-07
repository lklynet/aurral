import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { albumDiscHeadings, albumDiscSections } from "../../frontend/src/utils/albumDiscs.ts";

test("a one-disc album gets no headings, whatever releases its files came from", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Houdini (Adam Port mix)" },
        { disc: 1, title: "Houdini (Danny L Harle mix)" },
        { disc: 1, title: "Radical Optimism (extended versions)" },
        { disc: 1, title: "" },
        { disc: 0, title: "" },
      ],
      "Houdini",
    ),
    [null, null, null, null, null],
  );
});

test("a box set gets a heading per disc, named after its discs' own titles", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Mahler: Symphony 4" },
        { disc: 1, title: "" },
        { disc: 1, title: "Mahler: Symphony 4" },
        { disc: 2, title: "Rimsky-Korsakov: Antar" },
        { disc: 0, title: "" },
        { disc: 3, title: "Decca Sound" },
      ],
      "Decca Sound",
    ),
    ["Disc 1 · Mahler: Symphony 4", null, null, "Disc 2 · Rimsky-Korsakov: Antar", null, "Disc 3"],
  );
});

test("a disc whose files disagree on a title is named by its number alone", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Album" },
        { disc: 2, title: "Album (Deluxe)" },
        { disc: 2, title: "Album (Bonus)" },
      ],
      "Album",
    ),
    ["Disc 1", "Disc 2", null],
  );
});

test("a track list's disc headings come from each track's place on this album and its file's album tag", () => {
  const track = (disc: number, album: string | null, otherDisc = 9) => ({
    albums: [
      { albumId: 7, discNumber: otherDisc },
      { albumId: "3", discNumber: disc },
    ],
    metadata: album === null ? null : { tags: { album: ` ${album} ` } },
  });
  assert.deepEqual(
    albumDiscSections({ id: 3, title: "The Box" }, [
      track(1, "Symphony No. 1"),
      track(1, "Symphony No. 1"),
      track(2, null),
      track(2, "Symphony No. 2"),
    ]),
    ["Disc 1 · Symphony No. 1", null, "Disc 2 · Symphony No. 2", null],
  );
  assert.deepEqual(
    albumDiscSections({ id: 3, title: "One Disc" }, [track(1, "One Disc"), track(1, "One Disc")]),
    [null, null],
  );
});

test("a box set with one album title names its discs after each file's disc subtitle", () => {
  const track = (disc: number, discsubtitle?: string[]) => ({
    albums: [{ albumId: 5, discNumber: disc }],
    metadata: { tags: { album: "Decca Sound: The Analogue Years", discsubtitle } },
  });
  assert.deepEqual(
    albumDiscSections({ id: 5, title: "Decca Sound: The Analogue Years" }, [
      track(1, [" Saint-Saëns: Tone Poems "]),
      track(1, ["Saint-Saëns: Tone Poems"]),
      track(2, ["Bruckner: Symphony No.6"]),
      track(3),
    ]),
    ["Disc 1 · Saint-Saëns: Tone Poems", null, "Disc 2 · Bruckner: Symphony No.6", "Disc 3"],
  );
});
