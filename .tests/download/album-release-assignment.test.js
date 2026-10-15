import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assignDownloadedAlbumFiles } from "../../backend/services/albumReleaseAssignment.js";

const audioFixture = async (filePath) => {
  await writeFile(filePath, "");
  await truncate(filePath, 40000000);
};

test("an unverified album must contain the pinned complete edition before importing one wanted track", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-pinned-single-"));
  try {
    const paths = ["01 First.flac", "02 Second.flac", "03 Bonus.flac"].map((name) => join(root, name));
    for (const filePath of paths) await audioFixture(filePath);
    const tracks = ["First", "Second"].map((title, index) => ({
      title, artists: ["The Band"], durationMs: 200000 + index * 1000,
      trackNumber: index + 1, discNumber: 1,
      artistAliases: [], recordingMbidAliases: [],
    }));
    const manifest = { releaseMbid: "expected-edition", releaseGroupMbid: "album-group",
      title: "Album", artistNames: ["The Band"], compilation: false, tracks };
    const jobs = [{ id: "wanted-second", artistName: "The Band", albumName: "Album",
      trackName: "Second", durationMs: 201000, trackNumber: 2, discNumber: 1,
      albumTrackTitles: ["First", "Second"] }];
    const parsed = new Map(paths.map((filePath, index) => [filePath, {
      common: { title: ["First", "Second", "Bonus"][index], artist: "The Band", album: "Album",
        track: { no: index + 1 }, disc: { no: 1 } },
      format: { duration: 200 + index, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" },
    }]));
    const assign = (filePaths, verified = false) => assignDownloadedAlbumFiles({
      jobs, filePaths, source: "usenet", manifest, verified,
      parseAudio: async (filePath) => parsed.get(filePath),
    });
    const bonus = await assign(paths);
    assert.deepEqual(bonus.accepted, []);
    assert.deepEqual(bonus.rejected.map(({ jobId }) => jobId), ["wanted-second"]);
    assert.deepEqual((await assign([paths[1]])).accepted, []);
    const complete = await assign(paths.slice(0, 2));
    assert.deepEqual(complete.accepted.map(({ jobId, filePath }) => [jobId, filePath]), [["wanted-second", paths[1]]]);
    const preverified = await assign([paths[1]], true);
    assert.deepEqual(preverified.accepted.map(({ jobId, filePath }) => [jobId, filePath]), [["wanted-second", paths[1]]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fileTags = (title, no, duration, extra = {}) => ({
  common: { title, artist: "The Band", album: "Album", track: { no }, ...extra },
  format: { duration, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" },
});

function pinned(releaseMbid, tracks) {
  return { releaseMbid, releaseGroupMbid: "album-group", title: "Album", artistNames: ["The Band"],
    compilation: false, tracks: tracks.map((track) => ({ artists: ["The Band"], artistAliases: [],
      recordingMbid: null, recordingMbidAliases: [], discNumber: 1, ...track })) };
}

test("album assignment fills only verified sibling jobs and never reuses a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-assignment-"));
  try {
    const paths = ["02 Second.flac", "01 First.flac", "03 First (Live).flac"]
      .map((name) => join(root, name));
    for (const filePath of paths) await audioFixture(filePath);
    const parsed = new Map([
      [paths[0], fileTags("Second", 2, 201)],
      [paths[1], fileTags("First", 1, 200)],
      [paths[2], fileTags("First (Live)", 3, 200)],
    ]);
    const manifest = pinned("edition", ["First", "Second", "Third"].map((title, index) => ({
      title, trackNumber: index + 1, durationMs: 200000 + index * 1000 })));
    const jobs = ["First", "Second", "Third"].map((trackName, index) => ({ id: trackName.toLowerCase(), trackName,
      artistName: "The Band", albumName: "Album", durationMs: 200000 + index * 1000, trackNumber: index + 1 }));
    const assign = (verified) => assignDownloadedAlbumFiles({
      jobs, filePaths: [...paths, paths[0], join(root, "missing.flac")], source: "deemix", manifest, verified,
      parseAudio: async (filePath) => parsed.get(filePath),
    });
    const result = await assign(true);
    assert.deepEqual(result.accepted.map(({ jobId, filePath }) => [jobId, filePath]),
      [["first", paths[1]], ["second", paths[0]]]);
    assert.deepEqual((await assign(false)).accepted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an album import refuses only the files too small to hold their length", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-silence-"));
  try {
    const titles = ["First", "Second", "Third"];
    const paths = titles.map((title, index) => join(root, `0${index + 1} ${title}.flac`));
    for (const [index, filePath] of paths.entries()) {
      await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", index === 1 ? "anullsrc=r=44100:cl=stereo" : "sine=f=440", "-t", "20", "-c:a", "flac",
        "-metadata", `title=${titles[index]}`, "-metadata", "artist=The Band", "-metadata", "album=Album",
        "-metadata", `track=${index + 1}`, filePath]);
    }
    const manifest = pinned("edition", titles.map((title, index) => ({ title, trackNumber: index + 1, durationMs: 20000 })));
    const jobs = titles.map((trackName, index) => ({ id: trackName.toLowerCase(), trackName, artistName: "The Band",
      albumName: "Album", durationMs: 20000, trackNumber: index + 1 }));
    for (const verified of [true, false]) {
      const result = await assignDownloadedAlbumFiles({ jobs, filePaths: paths, source: "soulseek", manifest, verified });
      assert.deepEqual(result.accepted.map(({ jobId, filePath }) => [jobId, filePath]),
        [["first", paths[0]], ["third", paths[2]]], `verified ${verified}`);
      assert.deepEqual(result.rejected.map(({ jobId }) => jobId), ["second"], `verified ${verified}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album assignment places files on the pinned edition, not the requested numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-edition-"));
  try {
    const titles = ["Intro", "First", "Second", "Third"];
    const paths = titles.map((title, index) => join(root, `0${index + 1} ${title}.flac`));
    for (const filePath of paths) await audioFixture(filePath);
    const parsed = new Map(paths.map((filePath, index) =>
      [filePath, fileTags(titles[index], index + 1, index ? 199 + index : 60)]));
    const manifest = pinned("edition", titles.map((title, index) => ({
      title, trackNumber: index + 1, durationMs: index ? (199 + index) * 1000 : 60000 })));
    const jobs = [
      { id: "first", trackName: "First", artistName: "The Band", albumName: "Album",
        durationMs: 200000, trackNumber: 1, albumTrackTitles: ["First", "Second", "Third"] },
      { id: "second", trackName: "Second", artistName: "The Band", albumName: "Album",
        durationMs: 201000, trackNumber: 2, albumTrackTitles: ["First", "Second", "Third"] },
    ];
    const assign = (filePaths) => assignDownloadedAlbumFiles({
      jobs, filePaths, source: "usenet", manifest,
      parseAudio: async (filePath) => parsed.get(filePath),
    });
    const result = await assign(paths);
    assert.deepEqual(result.accepted.map(({ jobId, trackNumber }) => [jobId, trackNumber]), [["first", 2], ["second", 3]]);

    const themes = ["02 Theme.flac", "06 Theme.flac"].map((name) => join(root, name));
    for (const filePath of themes) await audioFixture(filePath);
    parsed.set(themes[0], fileTags("Theme", 2, 90)).set(themes[1], fileTags("Theme", 6, 90));
    const repeated = await assignDownloadedAlbumFiles({
      jobs: [6, 2].map((trackNumber) => ({ id: `theme-${trackNumber}`, trackName: "Theme",
        artistName: "The Band", albumName: "Album", durationMs: 90000, trackNumber, trackMbid: "theme" })),
      filePaths: themes, source: "soulseek", verified: true,
      manifest: pinned("reprise", [2, 6].map((trackNumber) => ({
        title: "Theme", trackNumber, durationMs: 90000, recordingMbid: "theme" }))),
      parseAudio: async (filePath) => parsed.get(filePath),
    });
    assert.deepEqual(repeated.accepted.map(({ jobId, filePath }) => [jobId, filePath]).sort(),
      [["theme-2", themes[0]], ["theme-6", themes[1]]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album assignment pairs each track of a two-disc download with its own disc", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-discs-"));
  try {
    const tracklist = [[1, 1, "Bomb"], [1, 2, "Swim"], [2, 1, "Bomb"], [2, 2, "Little Things"]];
    const paths = tracklist.map(([disc, position, title]) => join(root, `CD${disc}`, `0${position} ${title}.flac`));
    for (const filePath of paths) {
      await mkdir(dirname(filePath), { recursive: true });
      await audioFixture(filePath);
    }
    const parsed = new Map(paths.map((filePath, index) =>
      [filePath, fileTags(tracklist[index][2], tracklist[index][1], 100 + index)]));
    const manifest = pinned("two-disc", tracklist.map(([discNumber, trackNumber, title], index) => ({
      title, trackNumber, discNumber, durationMs: (100 + index) * 1000 })));
    const jobs = tracklist.map(([discNumber, trackNumber, trackName], index) => ({ id: `job-${index}`, trackName,
      artistName: "The Band", albumName: "Album", durationMs: (100 + index) * 1000, trackNumber, discNumber }));
    const assign = async (filePaths) => (await assignDownloadedAlbumFiles({
      jobs: jobs.toReversed(), filePaths: filePaths.toReversed(), source: "usenet", manifest,
      parseAudio: async (filePath) => parsed.get(filePath),
    })).accepted.map(({ jobId, filePath, discNumber, trackNumber }) => [jobId, filePath, discNumber, trackNumber]).sort();
    assert.deepEqual(await assign(paths),
      jobs.map(({ id, discNumber, trackNumber }, index) => [id, paths[index], discNumber, trackNumber]));

    const running = tracklist.map(([, , title], index) => join(root, `0${index + 1} ${title}.flac`));
    for (const [index, filePath] of running.entries()) {
      await audioFixture(filePath);
      parsed.set(filePath, fileTags(tracklist[index][2], index + 1, 100 + index));
    }
    assert.deepEqual(await assign(running),
      jobs.map(({ id, discNumber, trackNumber }, index) => [id, running[index], discNumber, trackNumber]));

    const lp4 = { ...pinned("lp4", ["Bilar", "Neckbrace"].map((title, index) => ({
      title, trackNumber: index + 1, durationMs: (100 + index) * 1000 }))), title: "LP4" };
    const named = lp4.tracks.map(({ title, trackNumber }) => join(root, "LP4", `0${trackNumber} ${title}.flac`));
    await mkdir(join(root, "LP4"));
    for (const [index, filePath] of named.entries()) {
      await audioFixture(filePath);
      parsed.set(filePath, fileTags(lp4.tracks[index].title, index + 1, 100 + index, { album: "LP4" }));
    }
    const lp4Jobs = lp4.tracks.map(({ title, trackNumber, durationMs }) => ({ id: title, trackName: title,
      artistName: "The Band", albumName: "LP4", durationMs, trackNumber, discNumber: 1 }));
    const placed = await assignDownloadedAlbumFiles({ jobs: lp4Jobs, filePaths: named, source: "slskd", manifest: lp4,
      parseAudio: async (filePath) => parsed.get(filePath) });
    assert.deepEqual(placed.accepted.map(({ jobId, filePath, discNumber }) => [jobId, filePath, discNumber]),
      [["Bilar", named[0], 1], ["Neckbrace", named[1], 1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album assignment accepts a file tagged with a recording ID MusicBrainz merged away", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-merged-"));
  try {
    const paths = ["01 First.flac", "02 Second.flac"].map((name) => join(root, name));
    for (const filePath of paths) await audioFixture(filePath);
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const mergedSecond = "33333333-3333-4333-8333-333333333333";
    const tags = (title, no, mbid) => fileTags(title, no, 200, { musicbrainz_recordingid: mbid });
    const parsed = new Map([[paths[0], tags("First", 1, first)], [paths[1], tags("Second", 2, mergedSecond)]]);
    const jobs = [
      { id: "first", trackName: "First", artistName: "The Band", albumName: "Album", durationMs: 200000, trackNumber: 1, trackMbid: first },
      { id: "second", trackName: "Second", artistName: "The Band", albumName: "Album", durationMs: 200000, trackNumber: 2, trackMbid: second },
    ];
    const manifest = pinned("release", [
      { title: "First", trackNumber: 1, durationMs: 200000, recordingMbid: first },
      { title: "Second", trackNumber: 2, durationMs: 200000, recordingMbid: second, recordingMbidAliases: [mergedSecond] },
    ]);
    const result = await assignDownloadedAlbumFiles({ jobs, filePaths: paths, source: "soulseek", manifest,
      parseAudio: async (filePath) => parsed.get(filePath) });
    assert.deepEqual(result.accepted.map(({ jobId }) => jobId), ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
