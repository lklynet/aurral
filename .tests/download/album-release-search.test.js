import test from "node:test";
import assert from "node:assert/strict";
import { selectSoulseekAlbumFolder } from "../../backend/services/albumReleaseSearch.js";

const jobs = [
  { id: "one", artistName: "The Band", trackName: "First", durationMs: 200000, trackNumber: 1 },
  { id: "two", artistName: "The Band", trackName: "Second", durationMs: 201000, trackNumber: 2 },
];

test("Soulseek album selection chooses one folder with distinct track files", () => {
  const results = [
    { user: "u", file: "The Band/Album/02 - Second.flac", length: 201, size: 100 },
    { user: "u", file: "The Band/Album/01 - First.flac", length: 200, size: 100 },
    { user: "v", file: "Other Artist/Album/01 - First.flac", length: 200, size: 100 },
  ];
  const selected = selectSoulseekAlbumFolder(results, jobs);
  assert.equal(selected.decision, "selectable");
  assert.deepEqual(selected.selected.files.map((entry) => entry.file), [
    "The Band/Album/01 - First.flac", "The Band/Album/02 - Second.flac",
  ]);
});

test("Soulseek album selection abstains when two folders fit equally", () => {
  const results = ["u", "v"].flatMap((user) => [
    { user, file: "The Band/Album/01 - First.flac", length: 200, size: 100 },
    { user, file: "The Band/Album/02 - Second.flac", length: 201, size: 100 },
  ]);
  assert.equal(selectSoulseekAlbumFolder(results, jobs).decision, "uncertain");
});
