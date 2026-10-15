import test from "node:test";
import assert from "node:assert/strict";
import { selectSoulseekAlbumFolder } from "../../backend/services/albumReleaseSearch.js";

const jobs = [
  { id: "one", artistName: "The Band", albumName: "Album", trackName: "First", durationMs: 200000, trackNumber: 1 },
  { id: "two", artistName: "The Band", albumName: "Album", trackName: "Second", durationMs: 201000, trackNumber: 2 },
];

const manifest = {
  releaseMbid: "requested-edition", releaseGroupMbid: "album-group", title: "Album",
  artistNames: ["The Band"], compilation: false,
  tracks: jobs.map((job) => ({ title: job.trackName, artists: [job.artistName],
    durationMs: job.durationMs, trackNumber: job.trackNumber, discNumber: 1 })),
};

test("a single requested track validates the whole edition and downloads only its file", () => {
  const results = copy("peer");
  const selection = selectSoulseekAlbumFolder(results, [jobs[1]], { manifest });
  assert.equal(selection.decision, "selectable");
  assert.deepEqual(selection.selected.files.map(({ jobId, file }) => [jobId, file]), [["two", results[1].file]]);
  assert.equal(selectSoulseekAlbumFolder(results.slice(1), [jobs[1]], { manifest }).decision, "skip");
});

test("a distinct bonus song rejects a pinned release even when its quality is disabled", () => {
  const results = [...copy("peer"), {
    user: "peer", file: "The Band/Album/03 - Bonus.mp3", length: 202, size: 30000000, bitrate: 128,
  }];
  for (const wanted of [jobs, [jobs[1]]]) {
    assert.equal(selectSoulseekAlbumFolder(results, wanted, {
      manifest, profile: { ...flacFirst, enabled: ["flac-standard"] },
    }).decision, "skip");
    assert.equal(selectSoulseekAlbumFolder(results.map((file) => ({
      ...file, locked: file.file.endsWith("Bonus.mp3"),
    })), wanted, { manifest }).decision, "skip");
  }
});

test("duplicate encodings satisfy one release position and the profile chooses the wanted copy", () => {
  const selected = selectSoulseekAlbumFolder([
    ...copy("peer"), ...copy("peer", { bitrate: 320 }, "mp3"),
  ], [jobs[1]], { manifest, profile: flacFirst });
  assert.equal(selected.decision, "selectable");
  assert.deepEqual(selected.selected.files.map(({ jobId, file }) => [jobId, file]), [
    ["two", "The Band/Album/02 - Second.flac"],
  ]);
});

test("Soulseek album selection chooses one folder with distinct track files", () => {
  const results = [
    { user: "u", file: "The Band/Album/02 - Second.flac", length: 201, size: 30000000 },
    { user: "u", file: "The Band/Album/01 - First.flac", length: 200, size: 30000000 },
    { user: "v", file: "Other Artist/Album/01 - First.flac", length: 200, size: 30000000 },
  ];
  const selected = selectSoulseekAlbumFolder(results, jobs, { manifest });
  assert.equal(selected.decision, "selectable");
  assert.deepEqual(selected.selected.files.map((entry) => entry.file), [
    "The Band/Album/01 - First.flac", "The Band/Album/02 - Second.flac",
  ]);
});

const copy = (user, overrides = {}, extension = "flac") => [
  { user, file: `The Band/Album/01 - First.${extension}`, length: 200, size: 30000000, ...overrides },
  { user, file: `The Band/Album/02 - Second.${extension}`, length: 201, size: 30000000, ...overrides },
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
  ], jobs, { manifest });
  assert.equal(selected.decision, "selectable");
  assert.equal(selected.selected.group.user, "free");
  assert.deepEqual(selected.candidates.map((candidate) => candidate.group.user), ["free", "busy"]);
  assert.deepEqual(selected.selected.files.map((file) => file.jobId), ["one", "two"]);
});

test("Soulseek album selection follows the quality profile", () => {
  const results = [...copy("mp3", { slots: 1, bitrate: 320 }, "mp3"), ...copy("flac", { slots: 0 })];
  assert.equal(selectSoulseekAlbumFolder(results, jobs, { manifest, profile: flacFirst }).selected.group.user, "flac");
  const flacOnly = { ...flacFirst, enabled: ["flac-standard"] };
  const mp3Only = selectSoulseekAlbumFolder(copy("mp3", { bitrate: 320 }, "mp3"), jobs, { manifest, profile: flacOnly });
  assert.equal(mp3Only.decision, "skip");
});

test("Soulseek album selection fits a folder without track lengths by title and position", () => {
  const results = copy("u").map(({ length: _length, ...file }) => file);
  assert.equal(selectSoulseekAlbumFolder(results, jobs, { manifest }).decision, "selectable");
});

test("Soulseek album selection uses the requested edition rather than choosing another tracklist", () => {
  const editionJobs = jobs.map((job) => ({ ...job, durationMs: null }));
  const results = [
    { user: "u", file: "The Band/Album/01 - Intro.flac", size: 30000000 },
    { user: "u", file: "The Band/Album/02 - First.flac", size: 30000000 },
    { user: "u", file: "The Band/Album/03 - Second.flac", size: 30000000 },
  ];
  assert.equal(selectSoulseekAlbumFolder(results, editionJobs, { manifest }).decision, "skip");
  const edition = { ...manifest, releaseMbid: "edition", tracks: [
    { title: "Intro", trackNumber: 1 },
    { title: "First", trackNumber: 2 },
    { title: "Second", trackNumber: 3 },
  ].map((track) => ({ ...track, artists: ["The Band"], discNumber: 1 })) };
  const selected = selectSoulseekAlbumFolder(results, editionJobs, { manifest: edition });
  assert.equal(selected.decision, "selectable");
  assert.deepEqual(selected.selected.files.map((file) => file.file), [
    "The Band/Album/02 - First.flac", "The Band/Album/03 - Second.flac",
  ]);
});

test("Soulseek album selection combines disc directories into one batch", () => {
  const results = [
    { user: "u", file: "The Band/Album/CD1/01 - First.flac", length: 200, size: 30000000 },
    { user: "u", file: "The Band/Album/CD2/01 - Second.flac", length: 201, size: 30000000 },
  ];
  const discJobs = jobs.map((job, index) => ({ ...job, trackNumber: 1, discNumber: index + 1 }));
  const discManifest = { ...manifest, tracks: manifest.tracks.map((track, index) => ({
    ...track, trackNumber: 1, discNumber: index + 1,
  })) };
  const selected = selectSoulseekAlbumFolder(results, discJobs, { manifest: discManifest });
  assert.equal(selected.decision, "selectable");
  assert.equal(selected.selected.files.length, 2);
});

test("Soulseek album selection accepts artist-album folder labels and an album titled for its version, not a Various Artists, live, or bootleg copy", () => {
  const folderDecision = (folder) => selectSoulseekAlbumFolder([
    { user: "u", file: `${folder}/01 - First.flac`, length: 200, size: 30000000 },
    { user: "u", file: `${folder}/02 - Second.flac`, length: 201, size: 30000000 },
  ], jobs, { manifest }).decision;
  for (const folder of ["The Band - Album", "The Band - Discography/Album"]) {
    assert.equal(folderDecision(folder), "selectable", folder);
  }
  assert.equal(folderDecision("Various Artists/Album"), "skip");
  for (const folder of ["The Band - Album (Live)", "The Band/Album [Bootleg]"]) {
    assert.notEqual(folderDecision(folder), "selectable", folder);
  }
  const acousticJobs = jobs.map((job) => ({ ...job, albumName: "Album (Acoustic)" }));
  assert.equal(selectSoulseekAlbumFolder([
    { user: "u", file: "The Band - Album (Acoustic)/01 - First.flac", length: 200, size: 30000000 },
    { user: "u", file: "The Band - Album (Acoustic)/02 - Second.flac", length: 201, size: 30000000 },
  ], acousticJobs, { manifest: { ...manifest, title: "Album (Acoustic)" } }).decision, "selectable");
});

test("Soulseek album selection fits a compilation folder by its album title", () => {
  const albumName = "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack";
  const folder = "Music/VA - Guardians of the Galaxy Awesome Mix Vol. 1 (2014)";
  const results = [
    { user: "u", file: `${folder}/01 - Blue Swede - Hooked on a Feeling.flac`, length: 173, size: 30000000 },
    { user: "u", file: `${folder}/02 - Raspberries - Go All the Way.flac`, length: 203, size: 30000000 },
  ];
  const tracks = [["Blue Swede", "Hooked on a Feeling", 173000], ["Raspberries", "Go All the Way", 203000]];
  for (const credit of ["track artists", "Various Artists"]) {
    const compilationJobs = tracks.map(([artistName, trackName, durationMs], index) => ({
      id: `job-${index}`, albumName, trackName, durationMs, trackNumber: index + 1,
      artistName: credit === "Various Artists" ? credit : artistName,
    }));
    const compilationManifest = { ...manifest, title: albumName, artistNames: ["Various Artists"], compilation: true,
      tracks: tracks.map(([artist, title, durationMs], index) => ({
        title, artists: [artist], durationMs, trackNumber: index + 1, discNumber: 1,
      })) };
    const selected = selectSoulseekAlbumFolder(results, compilationJobs, { manifest: compilationManifest });
    assert.equal(selected.decision, "selectable", credit);
    assert.deepEqual(selected.selected.files.map((file) => file.jobId), ["job-0", "job-1"], credit);
  }
});
