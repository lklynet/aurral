import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
import { serveGroups } from "../helpers/releaseFixture.js";

const audioFixture = async (filePath) => {
  await writeFile(filePath, "");
  await truncate(filePath, 40000000);
};

const [isolatedState, { toReleaseManifest, mapRequest, trackRequestFor }, { resolveReleaseManifest }, libraryStore,
  { buildTrackRequest }, { buildSourceCandidates }, { validateDownloadedTrackFile, selectVerifiedDownloadedFile }, { judgeRelease },
  { assignDownloadedAlbumFiles }] = await setupIsolatedBackend(
  "release-manifest",
  "backend/services/releaseManifest.js",
  "backend/services/releaseResolver.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/trackMatching/trackIdentity.js",
  "backend/services/trackMatching/sourceSearch.js",
  "backend/services/trackMatching/postDownloadValidator.js",
  "backend/services/trackMatching/releaseJudge.js",
  "backend/services/albumReleaseAssignment.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const GROUP = "a1a1a1a1-0000-4000-8000-000000000001";
const track = (trackname, recordingid, trackposition, durationms, extra = {}) =>
  ({ id: `${recordingid}-track`, trackname, recordingid, trackposition, mediumnumber: 1, durationms, artistid: "band", ...extra });
const releases = {
  "std-a": [track("Opener", "rec-1", 1, 200000, { oldrecordingids: ["rec-1-old"] }), track("Middle", "rec-2", 2, 210000),
    track("Closer", "rec-3", 3, 220000)],
  "std-b": [track("Opener", "rec-1", 1, 202000), track("Middle", "rec-2", 2, 212000), track("Closer", "rec-3", 3, 222000)],
  deluxe: [track("Opener", "rec-1", 1, 201000), track("Middle", "rec-2", 2, 211000), track("Closer", "rec-3", 3, 221000),
    track("Middle (Acoustic)", "rec-2a", 4, 190000), track("Bonus", "rec-b", 5, 180000, { artistid: "guest" })],
};
const group = {
  id: GROUP,
  title: "The Album",
  secondarytypes: ["Live"],
  artistid: "band",
  artists: [{ id: "band", artistname: "The Band", artistaliases: ["Band"] }, { id: "guest", artistname: "Guest Singer" }],
  releases: [
    ...Object.entries(releases).map(([id, tracks]) => ({ id, title: "The Album", status: "Official", tracks })),
    { id: "truncated", title: "The Album", status: "Bootleg", track_count: 12, tracks: releases["std-a"] },
  ],
};

const stubMetadata = (t, groups = [group]) => serveGroups(t, groups);

let albumCount = 0;
function libraryAlbum(metadata) {
  albumCount += 1;
  const artist = libraryStore.upsertLibraryArtist({ identityKey: `mbid:band-${albumCount}`, mbid: `band-${albumCount}`, name: "The Band" });
  libraryStore.upsertLibraryAlbum({ identityKey: `release-group:${GROUP}`, mbid: GROUP, releaseGroupMbid: GROUP,
    artistId: artist.id, title: "The Album", metadata });
}

const job = (trackName, trackMbid, extra = {}) => ({ id: trackName, artistName: "The Band", trackName, albumName: "The Album",
  albumMbid: GROUP, trackMbid, ...extra });
const titles = (manifest) => manifest?.tracks.map((entry) => entry.title);

// A downloaded album on disk: each file at its path under the folder, read
// with its title, place, and length.
async function downloadedAlbum(t, folder, files) {
  const root = await mkdtemp(join(tmpdir(), "aurral-release-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = new Map();
  for (const file of files) {
    const filePath = join(root, folder, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await audioFixture(filePath);
    parsed.set(filePath, { common: { title: file.title, artist: "The Band", track: { no: file.trackNumber },
      disc: { no: file.discNumber || 1 } },
    format: { duration: file.durationMs / 1000, container: "FLAC", lossless: true, sampleRate: 44100, bitsPerSample: 16 } });
  }
  return { filePaths: [...parsed.keys()], parseAudio: async (filePath) => parsed.get(filePath) };
}

const imported = async (t, manifest, jobs, folder, files) => {
  const album = await downloadedAlbum(t, folder, files);
  const result = await assignDownloadedAlbumFiles({ jobs, source: "usenet", manifest, ...album });
  return result.accepted.map((entry) => entry.jobId);
};

test("a request takes the commonest edition's whole tracklist, with the lengths that release lists", async (t) => {
  await stubMetadata(t);
  const manifest = await resolveReleaseManifest(job("Middle", "rec-2"));
  assert.equal(manifest.releaseMbid, "std-a");
  assert.equal(manifest.releaseGroupMbid, GROUP);
  assert.deepEqual(titles(manifest), ["Opener", "Middle", "Closer"]);
  assert.deepEqual(manifest.tracks.map((entry) => entry.durationMs), [200000, 210000, 220000]);
  assert.deepEqual(manifest.tracks[0].recordingMbidAliases, ["rec-1-old"]);
  assert.deepEqual(manifest.tracks[0].artists, ["The Band"]);
  assert.equal(manifest.compilation, false);
  assert.deepEqual(manifest.secondaryTypes, ["Live"]);
});

test("a pressing without a length takes the midpoint of its pressings' lengths", async (t) => {
  const pressed = "a1a1a1a1-0000-4000-8000-000000000002";
  const names = ["Alpha", "Beta", "Gamma"];
  const pressing = (id, lengths) => ({ id, title: "Pressed", status: "Official",
    tracks: names.map((name, index) => track(name, `pressed-${index + 1}`, index + 1, lengths[index])) });
  await serveGroups(t, [{ id: pressed, title: "Pressed", artistid: "band", artists: [{ id: "band", artistname: "The Band" }],
    releases: [pressing("original", [200000, 210000, 220000]), pressing("remaster", [206000, 216000, 226000]),
      pressing("vinyl", [0, 212000, 0])] }]);
  const vinyl = await resolveReleaseManifest({ ...job("Alpha", "pressed-1"), albumMbid: pressed, albumName: "Pressed",
    releaseMbid: "vinyl" });
  assert.deepEqual(vinyl.tracks.map((entry) => entry.durationMs), [203000, 212000, 223000]);
});

test("a rip of another official pressing of the same recordings in the same running order matches the pinned one", async (t) => {
  const pressed = "a1a1a1a1-0000-4000-8000-000000000003";
  const names = ["First Song", "Second Song", "Third Song"];
  const pressing = (id, lengths, { status = "Official", order = names, recording = "old", merged = false } = {}) => ({
    id, title: "Old Album", status, tracks: order.map((name, index) => track(name, `${recording}-${names.indexOf(name) + 1}`,
      index + 1, lengths[index], merged ? { oldrecordingids: [`old-${names.indexOf(name) + 1}`] } : {})) });
  const sleeve = [203000, 207000, 224000];
  const cd = [200100, 210200, 220300];
  const remastered = [185000, 190000, 195000];
  const rerecorded = [290000, 300000, 310000];
  await serveGroups(t, [{ id: pressed, title: "Old Album", artistid: "band", artists: [{ id: "band", artistname: "The Band" }],
    releases: [pressing("vinyl", sleeve), pressing("cd", cd), pressing("cd-again", cd),
      pressing("promo", [230000, 240000, 250000], { status: "Promotion" }),
      pressing("reordered", [260000, 270000, 280000], { order: [names[1], names[0], names[2]] }),
      pressing("remastered", remastered, { recording: "merged", merged: true }),
      pressing("rerecorded", rerecorded, { recording: "new" }), pressing("unlisted", [0, 210200, 0]),
      pressing("lone", [0, 0, 0], { recording: "lone" })] }]);
  const pinned = (releaseMbid, recording = "old-1") => resolveReleaseManifest({ ...job("First Song", recording),
    albumMbid: pressed, albumName: "Old Album", releaseMbid });
  const rip = (lengths) => ({ artistLabel: "The Band", albumLabel: "The Band - Old Album", files: names.map((title, index) => ({
    title, artists: ["The Band"], durationMs: lengths[index], trackNumber: index + 1, discNumber: 1,
    filename: `0${index + 1} - ${title}.flac` })) });

  const vinyl = await pinned("vinyl");
  assert.deepEqual(vinyl.tracks.map((entry) => entry.durationMs), sleeve);
  assert.deepEqual((await pinned("unlisted")).tracks.map((entry) => entry.durationMs), [200100, 210200, 220300]);
  assert.deepEqual((await pinned("lone", "lone-1")).tracks.map((entry) => entry.durationMs), [null, null, null]);
  assert.equal(judgeRelease(vinyl, rip(cd)).kind, "exact");
  assert.equal(judgeRelease(vinyl, rip(sleeve)).kind, "exact");
  assert.equal(judgeRelease(await pinned("cd"), rip(sleeve)).kind, "exact");
  assert.equal(judgeRelease(vinyl, rip(remastered)).kind, "exact");
  for (const lengths of [[230000, 240000, 250000], [270000, 260000, 280000], cd.map((length) => length + 3000), rerecorded]) {
    assert.equal(judgeRelease(vinyl, rip(lengths)).kind, "rejected", String(lengths));
  }

  const jobs = names.map((name, index) => ({ ...job(name, `old-${index + 1}`), id: `job-${index + 1}`, albumMbid: pressed,
    albumName: "Old Album", releaseMbid: "vinyl" }));
  assert.deepEqual(await imported(t, vinyl, jobs, "The Band - Old Album", rip(cd).files.map((file) => ({ ...file,
    path: file.filename }))), jobs.map((entry) => entry.id));

  const offered = async (durationMs) => (await buildSourceCandidates({ source: "soulseek",
    request: trackRequestFor({ ...job("First Song", "old-1"), albumMbid: pressed }, vinyl),
    results: [{ file: "The Band/Old Album/01 - First Song.flac", filename: "The Band/Old Album/01 - First Song.flac", durationMs }],
  })).evaluations[0].decision;
  assert.equal(await offered(203000), "accept");
  assert.equal(await offered(200100), "accept");
  assert.notEqual(await offered(197000), "accept");
});

test("a pinned edition with a live disc imports from a folder naming that disc, and a standard pin does not", async (t) => {
  const expanded = "a1a1a1a1-0000-4000-8000-000000000004";
  const studio = ["First Song", "Second Song"];
  const live = studio.map((name) => `${name} (Live at the Paramount)`);
  const disc = (names, mediumnumber, from) => names.map((name, index) => track(name, `big-${from + index}`, index + 1,
    200000 + (from + index) * 10000, { mediumnumber }));
  await serveGroups(t, [{ id: expanded, title: "Big Album", artistid: "band", artists: [{ id: "band", artistname: "The Band" }],
    releases: [{ id: "standard", title: "Big Album", status: "Official", tracks: disc(studio, 1, 1) },
      { id: "deluxe", title: "Big Album", status: "Official", tracks: [...disc(studio, 1, 1), ...disc(live, 2, 3)] }] }]);
  const jobsFor = (releaseMbid) => studio.map((name, index) => ({ ...job(name, `big-${index + 1}`), id: `${releaseMbid}-${index + 1}`,
    albumMbid: expanded, albumName: "Big Album", releaseMbid }));
  const files = (manifest) => manifest.tracks.map((entry, index) => ({ title: entry.title, trackNumber: entry.trackNumber,
    discNumber: entry.discNumber, durationMs: entry.durationMs,
    path: `CD${entry.discNumber}/0${entry.trackNumber} ${entry.title}.flac` }));
  const folder = "The Band - Big Album (Deluxe Edition) (Bonus Live Disc)";

  const deluxe = await resolveReleaseManifest(jobsFor("deluxe")[0]);
  assert.equal(deluxe.releaseMbid, "deluxe");
  assert.deepEqual(await imported(t, deluxe, jobsFor("deluxe"), folder, files(deluxe)), ["deluxe-1", "deluxe-2"]);
  const standard = await resolveReleaseManifest(jobsFor("standard")[0]);
  assert.deepEqual(await imported(t, standard, jobsFor("standard"), folder, files(standard)), []);
  assert.deepEqual(await imported(t, standard, jobsFor("standard"), "The Band - Big Album (Deluxe Edition)", files(standard)),
    ["standard-1", "standard-2"]);

  const liveAlbum = "The Band/The Band - Live in Paris (2004)/01 First Song.flac";
  const offered = await buildSourceCandidates({ source: "soulseek", request: trackRequestFor(jobsFor("deluxe")[0], deluxe),
    results: [{ file: liveAlbum, filename: liveAlbum, durationMs: 210000 }] });
  assert.equal(offered.evaluations[0].decision, "reject");
  const arena = await downloadedAlbum(t, "The Band - Live at the Arena (Live)", [{ title: "Second Song", trackNumber: 7,
    discNumber: 1, durationMs: deluxe.tracks[1].durationMs, path: "07 Second Song.flac" }]);
  const downloaded = await selectVerifiedDownloadedFile({ request: trackRequestFor(jobsFor("deluxe")[1], deluxe),
    filePaths: arena.filePaths, source: "usenet", options: { parseFile: arena.parseAudio, release: deluxe } });
  assert.equal(downloaded.filePath, null);
});

test("a pinned edition without the track, or with a cut-short tracklist, leaves the request unresolved", async (t) => {
  await stubMetadata(t);
  assert.equal(await resolveReleaseManifest(job("Bonus", "rec-b", { releaseMbid: "std-a" })), null);
  assert.equal(await resolveReleaseManifest(job("Opener", "rec-1", { releaseMbid: "truncated" })), null);
  assert.equal((await resolveReleaseManifest(job("Middle", "rec-2", { releaseMbid: "deluxe" }))).releaseMbid, "deluxe");
});

test("a pinned edition MusicBrainz no longer lists is chosen again", async (t) => {
  await stubMetadata(t);
  assert.equal((await resolveReleaseManifest(job("Opener", "rec-1", { releaseMbid: "merged-away" }))).releaseMbid, "std-a");
  libraryAlbum({ requestedRelease: "merged-away", edition: "standard" });
  const library = { playlistId: "library", playlistType: "library" };
  assert.equal((await resolveReleaseManifest(job("Bonus", "rec-b", library))).releaseMbid, "deluxe");
});

test("a Library album's requested edition is its jobs' edition even after its files list another", async (t) => {
  await stubMetadata(t);
  libraryAlbum({ requestedRelease: "deluxe", edition: "standard", trackList: { release: "std-b" } });
  const library = { playlistId: "library", playlistType: "library" };
  assert.equal((await resolveReleaseManifest(job("Middle", "rec-2", library))).releaseMbid, "deluxe");

  libraryAlbum({ requestedRelease: "std-b", edition: "standard" });
  assert.equal(await resolveReleaseManifest(job("Bonus", "rec-b", library)), null);
  assert.equal((await resolveReleaseManifest(job("Bonus", "rec-b"))).releaseMbid, "deluxe");
  assert.equal((await resolveReleaseManifest(job("Opener", "rec-1"))).releaseMbid, "std-b");
});

test("a Library album that wants the expanded edition asks for it without a stored release", async (t) => {
  await stubMetadata(t);
  libraryAlbum({ requestedRelease: null, edition: "expanded", trackList: { release: "std-b" } });
  const manifest = await resolveReleaseManifest(job("Opener", "rec-1", { playlistId: "library" }));
  assert.equal(manifest.releaseMbid, "deluxe");
});

test("unavailable metadata leaves the request unresolved instead of guessing a tracklist from the jobs", async (t) => {
  await stubMetadata(t, []);
  assert.equal(await resolveReleaseManifest(job("Middle", "rec-2", {
    albumTrackTitles: ["Opener", "Middle", "Closer"], trackNumber: 2, durationMs: 210000,
  })), null);
});

test("jobs map onto the edition by recording, then place and title, then a title it lists once", () => {
  const twoDiscs = toReleaseManifest({ id: GROUP, artists: [{ id: "band", name: "The Band" }] }, { id: "two-discs", tracks: [
    { title: "Bomb", recordingId: "bomb", trackPosition: 1, mediumNumber: 1 },
    { title: "Swim", recordingId: "swim", trackPosition: 2, mediumNumber: 1, oldRecordingIds: ["swim-old"] },
    { title: "Bomb", recordingId: "bomb", trackPosition: 1, mediumNumber: 2 },
    { title: "Live Song (Live)", recordingId: "live", trackPosition: 2, mediumNumber: 2 },
    { title: "Untagged", recordingId: null, trackPosition: 3, mediumNumber: 2 },
  ] });
  const { wanted, offManifest } = mapRequest(twoDiscs, [
    { id: "second-bomb", trackName: "Bomb", trackMbid: "bomb", trackNumber: 1, discNumber: 2 },
    { id: "first-bomb", trackName: "Bomb", trackMbid: "bomb", trackNumber: 1, discNumber: 1 },
    { id: "merged-swim", trackName: "Swim", trackMbid: "swim-old" },
    { id: "studio-title", trackName: "Live Song" },
    { id: "other-recording", trackName: "Live Song (Live)", trackMbid: "another-live", trackNumber: 2, discNumber: 2 },
    { id: "by-title", trackName: "Untagged" },
  ]);
  assert.deepEqual([...wanted], [[0, "first-bomb"], [1, "merged-swim"], [2, "second-bomb"], [4, "by-title"]]);
  assert.deepEqual(offManifest.toSorted(), ["other-recording", "studio-title"]);
  assert.deepEqual(mapRequest(twoDiscs, [{ id: "which-bomb", trackName: "Bomb" }]).offManifest, ["which-bomb"]);
  const placed = (trackName) => [...mapRequest(twoDiscs, [{ id: trackName, trackName, trackNumber: 1, discNumber: 1 }]).wanted];
  assert.deepEqual(placed("Bomb"), [[0, "Bomb"]]);
  assert.deepEqual(placed("Bomb (Alternate Mix)"), []);
  assert.deepEqual(placed("Bomb (In Concert)"), []);
});

test("a track request names the whole edition and the track's place on it, whatever else is still wanted", async (t) => {
  await stubMetadata(t);
  const manifest = await resolveReleaseManifest(job("Bonus", "rec-b"));
  const request = trackRequestFor(job("Opener", "rec-1-old", { trackNumber: 7, durationMs: 1000,
    albumTrackTitles: ["Opener"], artistAliases: ["Band"] }), manifest);
  assert.equal(request.releaseMbid, "deluxe");
  assert.equal(request.albumMbid, GROUP);
  assert.equal(request.trackMbid, "rec-1");
  assert.deepEqual(request.recordingMbidAliases, ["rec-1-old"]);
  assert.equal(request.trackNumber, 1);
  assert.equal(request.discNumber, 1);
  assert.equal(request.durationMs, 201000);
  assert.equal(request.albumTrackCount, 5);
  assert.deepEqual(request.albumTrackTitles, ["Opener", "Middle", "Closer", "Middle (Acoustic)", "Bonus"]);
  assert.equal(buildTrackRequest(request).releaseMbid, "deluxe");
  assert.equal(trackRequestFor(job("Not On It", "rec-x"), manifest), null);
  const bonus = trackRequestFor(job("Bonus", "rec-b"), manifest);
  assert.deepEqual(bonus.artistAliases, ["Guest Singer"]);
});

test("a track search on a live release group takes the track's live copy and still refuses another version", async (t) => {
  await stubMetadata(t);
  const live = await resolveReleaseManifest(job("Closer", "rec-3"));
  const studio = { ...live, secondaryTypes: [] };
  const offered = async (manifest, name) => {
    const result = await buildSourceCandidates({ source: "soulseek", request: trackRequestFor(job("Closer", "rec-3"), manifest),
      results: [{ file: `The Band/The Album/03 - ${name}.flac`, filename: `The Band/The Album/03 - ${name}.flac`, durationMs: 220000 }] });
    return result.evaluations[0].decision;
  };
  const downloaded = async (manifest, name) => (await validateDownloadedTrackFile({
    request: trackRequestFor(job("Closer", "rec-3"), manifest), source: "soulseek", filePath: `/tmp/${name}.flac`,
    options: { parseFile: async () => ({ common: { title: name, artist: "The Band", album: "The Album" },
      format: { duration: 220, container: "FLAC", lossless: true, sampleRate: 44100, bitsPerSample: 16 } }) },
  })).decision;
  assert.equal(await offered(live, "Closer (Live)"), "accept");
  assert.equal(await downloaded(live, "Closer (Live)"), "VERIFIED");
  assert.equal(await offered(live, "Closer (Acoustic)"), "reject");
  assert.equal(await offered(studio, "Closer (Live)"), "reject");
  assert.equal(await downloaded(studio, "Closer (Live)"), "CONFLICTED");
});

test("a compilation keeps its Various Artists credit and names only the artists its tracks credit", () => {
  const manifest = toReleaseManifest({ id: "va-group", title: "Hits", artistId: "89ad4ac3-39f7-470e-963a-56509c546377",
    artists: [{ id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" }, { id: "singer", name: "A Singer", aliases: ["Singer"] }],
  }, { id: "va-release", tracks: [
    { title: "One", recordingId: "one", trackPosition: 1, artistId: "singer" },
    { title: "Two", recordingId: "two", trackPosition: 2, artistId: "unlisted" },
    { title: "Three", recordingId: "three", trackPosition: 3 },
  ] });
  assert.equal(manifest.compilation, true);
  assert.deepEqual(manifest.artistNames, ["Various Artists", "A Singer"]);
  assert.deepEqual(manifest.tracks.map((entry) => entry.artists), [["A Singer"], [], []]);
  assert.deepEqual(manifest.tracks[0].artistAliases, ["Singer"]);
  assert.deepEqual(manifest.secondaryTypes, []);
});

test("an edition is refused unless each disc lists every place from the first, every title, and the whole declared tracklist", () => {
  const edition = (tracks, extra = {}) => toReleaseManifest({ id: "g" }, { id: "edition", ...extra,
    tracks: tracks.map(([mediumNumber, trackPosition], index) => ({ title: `Song ${index + 1}`, mediumNumber, trackPosition })) });
  assert.ok(edition([[1, 1], [1, 2], [2, 1], [2, 2]]));
  assert.equal(edition([[1, 1], [1, 2], [1, 4]]), null);
  assert.equal(edition([[1, 1], [1, 2], [2, 2], [2, 3]]), null);
  assert.equal(edition([[1, 1], [1, 2]], { trackCount: 3 }), null);
  assert.equal(edition([[1, 1], [1, 1]]), null);
  assert.equal(toReleaseManifest({ id: "g" }, { id: "untitled", tracks: [{ title: "", trackPosition: 1 }] }), null);
});
