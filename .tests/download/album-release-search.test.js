import test from "node:test";
import assert from "node:assert/strict";
import { selectSoulseekAlbumFolder } from "../../backend/services/albumReleaseSearch.js";

const jobs = [
  { id: "one", artistName: "The Band", albumName: "Album", trackName: "First", durationMs: 200000, trackNumber: 1 },
  { id: "two", artistName: "The Band", albumName: "Album", trackName: "Second", durationMs: 201000, trackNumber: 2 },
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

const copy = (user, overrides = {}, extension = "flac") => [
  { user, file: `The Band/Album/01 - First.${extension}`, length: 200, size: 100, ...overrides },
  { user, file: `The Band/Album/02 - Second.${extension}`, length: 201, size: 100, ...overrides },
];

const flacFirst = {
  order: ["flac-standard", "mp3-320"],
  enabled: ["flac-standard", "mp3-320"],
  cutoff: "flac-standard",
};

test("Soulseek album selection takes one of several identical copies by upload slot", () => {
  const selected = selectSoulseekAlbumFolder([
    ...copy("busy", { slots: 0, queueLength: 40 }),
    ...copy("free", { slots: 1, queueLength: 0 }),
  ], jobs);
  assert.equal(selected.decision, "selectable");
  assert.equal(selected.selected.group.user, "free");
  assert.deepEqual(selected.candidates.map((candidate) => candidate.group.user), ["free", "busy"]);
  assert.deepEqual(selected.selected.files.map((file) => file.jobId), ["one", "two"]);
});

test("Soulseek album selection follows the quality profile", () => {
  const results = [...copy("mp3", { slots: 1, bitrate: 320 }, "mp3"), ...copy("flac", { slots: 0 })];
  assert.equal(selectSoulseekAlbumFolder(results, jobs, { profile: flacFirst }).selected.group.user, "flac");
  const flacOnly = { ...flacFirst, enabled: ["flac-standard"] };
  const mp3Only = selectSoulseekAlbumFolder(copy("mp3", { bitrate: 320 }, "mp3"), jobs, { profile: flacOnly });
  assert.equal(mp3Only.decision, "skip");
});

test("Soulseek album selection fits a folder without track lengths by title and position", () => {
  const results = copy("u").map(({ length: _length, ...file }) => file);
  assert.equal(selectSoulseekAlbumFolder(results, jobs).decision, "selectable");
});

test("Soulseek album selection matches the numbering of another edition", () => {
  const editionJobs = jobs.map((job) => ({ ...job, durationMs: null }));
  const results = [
    { user: "u", file: "The Band/Album/01 - Intro.flac", size: 100 },
    { user: "u", file: "The Band/Album/02 - First.flac", size: 100 },
    { user: "u", file: "The Band/Album/03 - Second.flac", size: 100 },
  ];
  assert.equal(selectSoulseekAlbumFolder(results, editionJobs).decision, "skip");
  const releases = [{ id: "edition", tracks: [
    { title: "Intro", trackNumber: 1 },
    { title: "First", trackNumber: 2 },
    { title: "Second", trackNumber: 3 },
  ] }];
  const selected = selectSoulseekAlbumFolder(results, editionJobs, { releases });
  assert.equal(selected.decision, "selectable");
  assert.equal(selected.selected.releaseId, "edition");
  assert.deepEqual(selected.selected.files.map((file) => file.file), [
    "The Band/Album/02 - First.flac", "The Band/Album/03 - Second.flac",
  ]);
});

test("Soulseek album selection combines disc directories into one batch", () => {
  const results = [
    { user: "u", file: "The Band/Album/CD1/01 - First.flac", length: 200, size: 100 },
    { user: "u", file: "The Band/Album/CD2/02 - Second.flac", length: 201, size: 100 },
  ];
  const selected = selectSoulseekAlbumFolder(results, jobs);
  assert.equal(selected.decision, "selectable");
  assert.equal(selected.selected.files.length, 2);
});

test("Soulseek album selection accepts artist-album and compilation folder labels, not live or bootleg copies", () => {
  const folderDecision = (folder) => selectSoulseekAlbumFolder([
    { user: "u", file: `${folder}/01 - First.flac`, length: 200, size: 100 },
    { user: "u", file: `${folder}/02 - Second.flac`, length: 201, size: 100 },
  ], jobs).decision;
  for (const folder of ["The Band - Album", "Various Artists/Album", "The Band - Discography/Album"]) {
    assert.equal(folderDecision(folder), "selectable", folder);
  }
  for (const folder of ["The Band - Album (Live)", "The Band/Album [Bootleg]"]) {
    assert.notEqual(folderDecision(folder), "selectable", folder);
  }
});

test("Soulseek album selection fits a compilation folder by its album title", () => {
  const albumName = "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack";
  const folder = "Music/VA - Guardians of the Galaxy Awesome Mix Vol. 1 (2014)";
  const results = [
    { user: "u", file: `${folder}/01 - Blue Swede - Hooked on a Feeling.flac`, length: 173, size: 100 },
    { user: "u", file: `${folder}/02 - Raspberries - Go All the Way.flac`, length: 203, size: 100 },
  ];
  const tracks = [["Blue Swede", "Hooked on a Feeling", 173000], ["Raspberries", "Go All the Way", 203000]];
  for (const credit of ["track artists", "Various Artists"]) {
    const compilationJobs = tracks.map(([artistName, trackName, durationMs], index) => ({
      id: `job-${index}`, albumName, trackName, durationMs, trackNumber: index + 1,
      artistName: credit === "Various Artists" ? credit : artistName,
    }));
    const selected = selectSoulseekAlbumFolder(results, compilationJobs);
    assert.equal(selected.decision, "selectable", credit);
    assert.deepEqual(selected.selected.files.map((file) => file.jobId), ["job-0", "job-1"], credit);
  }
});
