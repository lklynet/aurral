import test from "node:test";
import assert from "node:assert/strict";
import { judgeRelease, releaseHolds } from "../../backend/services/trackMatching/releaseJudge.js";
import { parseListingTitle } from "../../backend/services/trackMatching/nativeMatcher.js";
import { OTHER_VERSION_LABELS } from "./version-labels.js";

const RECORDING = "352f7829-a238-4b00-8cc1-2b0c2613c756";
const OTHER_RECORDING = "e0996a37-c13d-44c3-8060-74939d43fa37";

function release(titles, { title = "Album", artist = "The Band", discs = null, ...rest } = {}) {
  return {
    releaseMbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
    releaseGroupMbid: "1e0eee38-a9f6-49bf-84d0-45d0b2a5a4d1",
    title,
    artistNames: [artist],
    compilation: false,
    secondaryTypes: [],
    tracks: titles.map((name, index) => ({
      title: name,
      artists: [artist],
      artistAliases: [],
      durationMs: 180000 + index * 10000,
      trackNumber: discs ? discs[index][1] : index + 1,
      discNumber: discs ? discs[index][0] : 1,
      recordingMbid: null,
      recordingMbidAliases: [],
    })),
    ...rest,
  };
}

const pad = (number) => String(number).padStart(2, "0");

function fileFor(manifest, index, overrides = {}) {
  const track = manifest.tracks[index];
  return {
    title: track.title,
    artists: [],
    durationMs: track.durationMs,
    trackNumber: track.trackNumber,
    discNumber: null,
    recordingMbid: null,
    path: `${manifest.artistNames[0]}/${manifest.title}/${pad(track.trackNumber)} ${track.title}.flac`,
    ...overrides,
  };
}

function listing(manifest, files = manifest.tracks.map((_, index) => fileFor(manifest, index)), labels = {}) {
  return { artistLabel: manifest.artistNames[0], albumLabel: manifest.title, files, ...labels };
}

const album = release(["First Song", "Second Song", "Third Song", "Fourth Song"]);

test("a complete listing pairs every track with its own file in any file order", () => {
  const files = [3, 1, 0, 2].map((index) => fileFor(album, index));
  const verdict = judgeRelease(album, listing(album, files));
  assert.equal(verdict.kind, "exact");
  assert.deepEqual(verdict.fileForTrack, [2, 1, 3, 0]);
  assert.deepEqual(verdict.copiesForTrack, [[2], [1], [3], [0]]);
  assert.equal(releaseHolds(album, listing(album, files), 3), true);

  const orders = (rest) => (rest.length ? rest.flatMap((first) => orders(rest.filter((index) => index !== first))
    .map((order) => [first, ...order])) : [[]]);
  for (const order of orders([0, 1, 2, 3])) {
    const unnumbered = order.map((index) => fileFor(album, index, { trackNumber: null }));
    assert.deepEqual(judgeRelease(album, listing(album, unnumbered)).fileForTrack,
      [0, 1, 2, 3].map((index) => order.indexOf(index)), order.join());
  }
});

test("repeated titles pair by place, then by the closest lengths", () => {
  const interludes = release(["Interlude", "Interlude"]);
  interludes.tracks[1].durationMs = interludes.tracks[0].durationMs;
  const atPlaces = (...places) => places.map((trackNumber) => fileFor(interludes, 0, { trackNumber }));
  assert.deepEqual(judgeRelease(interludes, listing(interludes, atPlaces(2, 1))).fileForTrack, [1, 0]);
  const doubled = judgeRelease(interludes, listing(interludes, atPlaces(2, 2)));
  assert.deepEqual(doubled.missing, [0]);
  assert.deepEqual(doubled.copiesForTrack.map((copies) => copies.toSorted()), [[], [0, 1]]);

  const timed = release(["Interlude", "Interlude"]);
  timed.tracks[0].durationMs = 100000;
  timed.tracks[1].durationMs = 101000;
  const unplaced = [100000, 102000].map((durationMs) => fileFor(timed, 0, { durationMs, trackNumber: null }));
  assert.deepEqual(judgeRelease(timed, listing(timed, unplaced)).fileForTrack, [0, 1]);
});

test("a distinct bonus song rejects the release for the whole album and for one wanted track", () => {
  for (const bonus of [
    { title: "Bonus Song", durationMs: 222000, trackNumber: 5, path: "The Band/Album/05 Bonus Song.mp3", bitrate: 96 },
    { title: "Hidden Track", durationMs: 95000, trackNumber: null, path: "The Band/Album/Hidden Track.flac" },
  ]) {
    const offered = listing(album, [...album.tracks.map((_, index) => fileFor(album, index)), { artists: [], ...bonus }]);
    const verdict = judgeRelease(album, offered);
    assert.equal(verdict.kind, "rejected", bonus.title);
    assert.equal(verdict.reason, "extra-tracks");
    assert.deepEqual(verdict.extras, [4]);
    assert.deepEqual(verdict.missing, []);
    assert.equal(releaseHolds(album, offered, 0), false);
  }
});

test("a missing unrequested track rejects the release but the listing still holds the wanted track", () => {
  const offered = listing(album, [0, 1, 3].map((index) => fileFor(album, index)));
  const verdict = judgeRelease(album, offered);
  assert.equal(verdict.kind, "rejected");
  assert.equal(verdict.reason, "missing-tracks");
  assert.deepEqual(verdict.missing, [2]);
  assert.deepEqual(verdict.fileForTrack, [0, 1, null, 2]);
  assert.equal(releaseHolds(album, offered, 0), true);
  assert.equal(releaseHolds(album, offered, 2), false);
});

test("another encoding of every track is a copy, not an extra", () => {
  const files = album.tracks.flatMap((track, index) => [
    fileFor(album, index),
    fileFor(album, index, { durationMs: track.durationMs + 400, path: `The Band/Album/${pad(index + 1)} ${track.title}.mp3` }),
  ]);
  const verdict = judgeRelease(album, listing(album, files));
  assert.equal(verdict.kind, "exact");
  assert.deepEqual(verdict.copiesForTrack.map((copies) => copies.toSorted()), [[0, 1], [2, 3], [4, 5], [6, 7]]);
});

test("a copy whose length misses the window beside its verified copy is not an extra song", () => {
  const mp3 = (index, shift) => fileFor(album, index, { durationMs: album.tracks[index].durationMs + shift,
    path: `The Band/Album/${pad(index + 1)} ${album.tracks[index].title}.mp3` });
  const flacs = album.tracks.map((_, index) => fileFor(album, index));
  const withFlac = listing(album, [...flacs, mp3(3, 4000)]);
  const verdict = judgeRelease(album, withFlac);
  assert.equal(verdict.kind, "exact");
  assert.deepEqual(verdict.copiesForTrack, [[0], [1], [2], [3]]);
  assert.equal(releaseHolds(album, withFlac, 0), true);

  const withoutFlac = listing(album, [...flacs.slice(0, 3), mp3(3, 4000)]);
  assert.equal(judgeRelease(album, withoutFlac).reason, "missing-tracks");
  assert.equal(releaseHolds(album, withoutFlac, 0), true);
  assert.equal(releaseHolds(album, withoutFlac, 3), false);
  const withBonus = listing(album, [...withoutFlac.files, { title: "Bonus Song", artists: [], durationMs: 222000,
    trackNumber: 5, path: "The Band/Album/05 Bonus Song.flac" }]);
  assert.equal(judgeRelease(album, withBonus).reason, "extra-tracks");
  assert.equal(releaseHolds(album, withBonus, 0), false);
});

test("a second file is a copy only when it is the same song at a compatible place and length", () => {
  const parts = release(["Part 1", "Part 2", "Closer"]);
  const complete = parts.tracks.map((_, index) => fileFor(parts, index));
  for (const [name, extra, reason] of [
    ["live copy", fileFor(parts, 0, { title: "Part 1 (Live)", trackNumber: null }), "unrequested-variant"],
    ["copy eleven seconds longer", fileFor(parts, 0, { durationMs: parts.tracks[0].durationMs + 11000, trackNumber: null }),
      "extra-tracks"],
    ["copy at another place", fileFor(parts, 0, { trackNumber: 3 }), "extra-tracks"],
    ["similar title", fileFor(parts, 0, { title: "Part 3", trackNumber: null }), "extra-tracks"],
  ]) {
    const verdict = judgeRelease(parts, listing(parts, [...complete, extra]));
    assert.equal(verdict.kind, "rejected", name);
    assert.equal(verdict.reason, reason, name);
    assert.deepEqual(verdict.extras, [3], name);
  }
});

test("files or a label naming another artist reject the release despite matching titles and lengths", () => {
  const tagged = album.tracks.map((_, index) => fileFor(album, index, { artists: ["Other Artist"] }));
  const byTags = judgeRelease(album, listing(album, tagged, { artistLabel: null }));
  assert.equal(byTags.kind, "rejected");
  assert.deepEqual(byTags.missing, [0, 1, 2, 3]);
  const byLabel = judgeRelease(album, listing(album, undefined, { artistLabel: "Other Artist" }));
  assert.equal(byLabel.kind, "rejected");
  assert.equal(byLabel.reason, "artist-conflict");
});

test("Various Artists labels and artists or albums named with version words are not conflicts", () => {
  const compilation = {
    ...release(["Hooked on a Feeling", "Go All the Way"], { title: "Awesome Mix Vol. 1", artist: "Various Artists" }),
    compilation: true,
  };
  compilation.tracks[0].artists = ["Blue Swede"];
  compilation.tracks[1].artists = ["Raspberries"];
  const credited = compilation.tracks.map((track, index) => fileFor(compilation, index, { artists: track.artists }));
  assert.equal(judgeRelease(compilation, listing(compilation, credited, { artistLabel: "Various Artists" })).kind, "exact");
  assert.equal(judgeRelease(album, listing(album, undefined, { artistLabel: "VA" })).kind, "exact");

  const hole = release(["Violet", "Miss World"], { title: "Live Through This", artist: "Hole" });
  assert.equal(judgeRelease(hole, listing(hole)).kind, "exact");

  const utada = release(["Automatic", "Movin' on Without You"], { title: "First Love", artist: "宇多田ヒカル" });
  assert.equal(judgeRelease(utada, listing(utada, undefined, { artistLabel: "Utada Hikaru" })).kind, "exact");
  assert.equal(judgeRelease(album, listing(album, undefined, { albumLabel: "アルバム" })).kind, "exact");
});

test("a multi-disc listing pairs each track with its own disc", () => {
  const twoDiscs = release(["Intro", "Song A", "Intro", "Song B"], { discs: [[1, 1], [1, 2], [2, 1], [2, 2]] });
  twoDiscs.tracks[2].durationMs = twoDiscs.tracks[0].durationMs;
  const discFile = (index, disc) => {
    const track = twoDiscs.tracks[index];
    const path = `The Band/Album/CD${disc}/${pad(track.trackNumber)} ${track.title}.flac`;
    return { ...parseListingTitle(path), artists: [], durationMs: track.durationMs, recordingMbid: null, path };
  };
  const folders = [discFile(2, 2), discFile(3, 2), discFile(0, 1), discFile(1, 1)];
  const verdict = judgeRelease(twoDiscs, listing(twoDiscs, folders));
  assert.equal(verdict.kind, "exact");
  assert.deepEqual(verdict.fileForTrack, [2, 3, 0, 1]);

  const runningNumbers = twoDiscs.tracks.map((_, index) => fileFor(twoDiscs, index, { trackNumber: index + 1 }));
  assert.equal(judgeRelease(twoDiscs, listing(twoDiscs, runningNumbers)).kind, "exact");

  const wrongDisc = [discFile(0, 1), discFile(1, 2), discFile(2, 2), discFile(3, 2)];
  const rejected = judgeRelease(twoDiscs, listing(twoDiscs, wrongDisc));
  assert.equal(rejected.kind, "rejected");
  assert.deepEqual(rejected.missing, [1]);
});

test("a file at a known wrong place does not fill the track", () => {
  const files = album.tracks.map((_, index) => fileFor(album, index));
  files[0] = { ...files[0], trackNumber: 2 };
  files[1] = { ...files[1], trackNumber: 1 };
  const verdict = judgeRelease(album, listing(album, files));
  assert.equal(verdict.kind, "rejected");
  assert.deepEqual(verdict.missing, [0, 1]);
});

test("without a length a file needs its exact title at its place", () => {
  const untimed = (overrides) => album.tracks.map((_, index) => fileFor(album, index, { durationMs: null, ...overrides(index) }));
  assert.equal(judgeRelease(album, listing(album, untimed(() => ({})))).kind, "exact");
  const misspelled = untimed((index) => (index === 0 ? { title: "Frist Song" } : {}));
  assert.deepEqual(judgeRelease(album, listing(album, misspelled)).missing, [0]);
  const unnumbered = untimed((index) => (index === 0 ? { trackNumber: null } : {}));
  assert.deepEqual(judgeRelease(album, listing(album, unnumbered)).missing, [0]);
});

test("a numbered file without a title fits only beside the release's artist with its length", () => {
  const numbered = (shift = 0) => album.tracks.map((track, index) => ({
    ...parseListingTitle(`${pad(index + 1)}.flac`),
    artists: [],
    durationMs: track.durationMs + (index === 0 ? shift : 0),
    recordingMbid: null,
    path: `The Band/Album/${pad(index + 1)}.flac`,
  }));
  assert.equal(judgeRelease(album, listing(album, numbered())).kind, "exact");
  assert.equal(judgeRelease(album, listing(album, numbered(), { artistLabel: null })).kind, "rejected");
  assert.deepEqual(judgeRelease(album, listing(album, numbered(3000))).missing, [0]);
});

test("a recording ID names its track, tells repeated recordings apart by place, and rejects another recording", () => {
  const repeated = release(["Theme", "Middle", "Other", "Theme"]);
  repeated.tracks[0].recordingMbid = RECORDING;
  repeated.tracks[3].recordingMbid = RECORDING;
  const files = [3, 1, 2, 0].map((index) => fileFor(repeated, index, {
    title: index === 0 || index === 3 ? "Track" : repeated.tracks[index].title,
    recordingMbid: index === 0 || index === 3 ? RECORDING : null,
    durationMs: index === 0 || index === 3 ? null : repeated.tracks[index].durationMs,
  }));
  const verdict = judgeRelease(repeated, listing(repeated, files));
  assert.equal(verdict.kind, "exact");
  assert.deepEqual(verdict.fileForTrack, [3, 1, 2, 0]);

  const named = release(["First Song", "Second Song"]);
  named.tracks[0].recordingMbid = RECORDING;
  const wrong = named.tracks.map((_, index) => fileFor(named, index, { recordingMbid: index === 0 ? OTHER_RECORDING : null }));
  assert.deepEqual(judgeRelease(named, listing(named, wrong)).missing, [0]);
});

test("a known length must agree within the selection window", () => {
  const shifted = (gap) => album.tracks.map((track, index) => fileFor(album, index, { durationMs: track.durationMs + (index === 1 ? gap : 0) }));
  assert.equal(judgeRelease(album, listing(album, shifted(1900))).kind, "exact");
  assert.deepEqual(judgeRelease(album, listing(album, shifted(-2500))).missing, [1]);
});

test("a requested live album accepts its live tracks", () => {
  const live = release(["Song A (Live)", "Song B (Live)"], { title: "Live at Wembley" });
  const files = live.tracks.map((track, index) => fileFor(live, index, {
    path: `The Band/2015 - Live at Wembley/${pad(index + 1)} ${track.title}.flac`,
  }));
  assert.equal(judgeRelease(live, listing(live, files, { albumLabel: "2015 - Live at Wembley" })).kind, "exact");
});

test("an unrequested version in a label, folder, or file rejects the release", () => {
  const remixFolder = album.tracks.map((track, index) => fileFor(album, index, {
    path: `The Band/Album (Remixes)/${pad(index + 1)} ${track.title}.flac`,
  }));
  const instrumental = album.tracks.map((track, index) => fileFor(album, index, {
    title: index === 1 ? `${track.title} (Instrumental)` : track.title,
  }));
  for (const [name, offered, marker] of [
    ["artist label", listing(album, undefined, { artistLabel: "The Band Karaoke" }), "karaoke"],
    ["release folder", listing(album, remixFolder), "remix"],
    ["file title", listing(album, instrumental), "instrumental"],
  ]) {
    const verdict = judgeRelease(album, offered);
    assert.equal(verdict.kind, "rejected", name);
    assert.ok(verdict.markers.includes(marker), `${name}: ${JSON.stringify(verdict.markers)}`);
  }
});

test("a file naming its release's mix, such as mono or a stereo mix, still fills its place", () => {
  const labels = ["", " (Mono)", " - Mono Version", " (Stereo Mix)"];
  const files = album.tracks.map((track, index) => fileFor(album, index, { title: `${track.title}${labels[index]}` }));
  const verdict = judgeRelease(album, listing(album, files));
  assert.equal(verdict.kind, "exact", JSON.stringify(verdict.markers));
  assert.deepEqual(verdict.fileForTrack, [0, 1, 2, 3]);
});

test("a label naming another product, album, or live show rejects the release, and one naming only artist, year, or format does not", () => {
  for (const [albumLabel, reason] of [["The Band - Discography", "other-product"], ["A Tribute to The Band", "other-product"],
    ["The Band - Greatest Hits", "other-product"], ["The Band - Other Record (2001)", "album-conflict"],
    ["Album (Live In London)", "unrequested-variant"], ["The Band - Live 2017", "unrequested-variant"],
    ["The Band - Live in Paris (2004)", "unrequested-variant"], ["Album (Covers Album)", "unrequested-variant"]]) {
    const verdict = judgeRelease(album, listing(album, undefined, { albumLabel }));
    assert.equal(verdict.kind, "rejected", albumLabel);
    assert.equal(verdict.reason, reason, albumLabel);
  }
  const otherTag = album.tracks.map((_, index) => fileFor(album, index, { album: "Other Record" }));
  assert.equal(judgeRelease(album, listing(album, otherTag)).reason, "album-conflict");
  for (const albumLabel of ["The Band - 2001 [FLAC 24bit]", "(2001) Album [FLAC]", "The.Band-Album-2001-WEB-FLAC", "Album (Deluxe Edition)", null]) {
    assert.equal(judgeRelease(album, listing(album, undefined, { albumLabel })).kind, "exact", String(albumLabel));
  }
});

test("every version word in a label names the folder's version, however the label notes it", () => {
  for (const [albumLabel, markers] of OTHER_VERSION_LABELS) {
    const verdict = judgeRelease(album, listing(album, undefined, { albumLabel }));
    assert.equal(verdict.reason, "unrequested-variant", albumLabel);
    assert.deepEqual(verdict.markers.toSorted(), markers.toSorted(), albumLabel);
  }
});

test("a live release group accepts live tracks and a live label without the word in its title", () => {
  const alive = release(["Deuce", "Strutter"], { title: "Alive!", artist: "KISS", secondaryTypes: ["Live"] });
  const liveFiles = alive.tracks.map((track, index) => fileFor(alive, index, {
    title: `${track.title} (Live)`, path: `KISS/Alive! (Live 1975)/${pad(index + 1)} ${track.title} (Live).flac`,
  }));
  assert.equal(judgeRelease(alive, listing(alive, liveFiles, { albumLabel: "Alive! (Live 1975)" })).kind, "exact");

  const studio = { ...alive, secondaryTypes: [] };
  assert.equal(judgeRelease(studio, listing(studio, liveFiles, { albumLabel: "Alive! (Live 1975)" })).reason, "unrequested-variant");
  const acoustic = alive.tracks.map((track, index) => fileFor(alive, index, { title: `${track.title} (Acoustic)` }));
  assert.deepEqual(judgeRelease(alive, listing(alive, acoustic)).markers, ["acoustic"]);
});

test("a pinned edition with a live disc accepts a label naming that disc, but not a live copy of a studio track", () => {
  const live = ["First Song (Live at the Paramount)", "Second Song (Live at the Paramount)"];
  const deluxe = release(["First Song", "Second Song", ...live], { discs: [[1, 1], [1, 2], [2, 1], [2, 2]] });
  const files = (folder, overrides = () => ({})) => deluxe.tracks.map((track, index) => fileFor(deluxe, index, {
    discNumber: track.discNumber, path: `The Band/${folder}/CD${track.discNumber}/${pad(track.trackNumber)} ${track.title}.flac`,
    ...overrides(index),
  }));
  for (const albumLabel of ["The Band - Album (Deluxe Edition) (Bonus Live Disc)", "The Band - Album (Deluxe & Live Bonus Edition)"]) {
    assert.equal(judgeRelease(deluxe, listing(deluxe, files(albumLabel), { albumLabel })).kind, "exact", albumLabel);
  }
  const liveStudio = judgeRelease(deluxe, listing(deluxe, files("Album (Deluxe Edition)",
    (index) => (index === 0 ? { title: "First Song (Live)" } : {}))));
  assert.equal(liveStudio.reason, "unrequested-variant");
  assert.deepEqual(liveStudio.missing, [0]);
  const standard = release(["First Song", "Second Song"]);
  assert.deepEqual(judgeRelease(standard, listing(standard, undefined,
    { albumLabel: "The Band - Album (Deluxe Edition) (Bonus Live Disc)" })).markers, ["live"]);
});

test("a release's own versions excuse a label only where they make up half of a disc of a quarter of the release", () => {
  const onDiscs = (manifest) => manifest.tracks.map((track, index) => fileFor(manifest, index, { discNumber: track.discNumber }));
  const judged = (manifest, albumLabel) => judgeRelease(manifest, listing(manifest, onDiscs(manifest), { albumLabel }));
  const bonus = release(["First Song", "Second Song", "Third Song", "Second Song (Live at the Troubadour)"]);
  const studio = Array.from({ length: 7 }, (_, index) => `Song ${index + 1}`);
  const bonusDisc = (extra) => release([...studio, ...extra],
    { discs: [...studio.map((_, index) => [1, index + 1]), ...extra.map((_, index) => [2, index + 1])] });
  for (const albumLabel of ["The Band - Album (Live at Wembley)", "The Band - Album [Live]"]) {
    assert.deepEqual(judged(bonus, albumLabel).markers, ["live"], albumLabel);
    assert.deepEqual(judged(bonusDisc(["Song 2 (Live at the Troubadour)"]), albumLabel).markers, ["live"], albumLabel);
    assert.deepEqual(judged(bonusDisc(["Song 2 (Live at the Troubadour)", "Song 8"]), albumLabel).markers, ["live"], albumLabel);
  }
  const liveDisc = release(["First Song", "Second Song", "Third Song", "First Song (Live)", "Second Song (Live)"],
    { discs: [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]] });
  assert.equal(judged(liveDisc, "The Band - Album (Deluxe Edition) (Bonus Live Disc)").kind, "exact");
  const single = release(["One", "One (XXXchange Remix)", "One (Demo Version)", "One (Instrumental)"], { title: "One" });
  assert.equal(judged(single, "[2010] One (Remixes) - EP").kind, "exact");
  assert.deepEqual(judged(single, "One (Live)").markers, ["live"]);
});

test("a title in another script fits like an untitled file at its place, and a near spelling in that script does not fit", () => {
  const yoasobi = release(["夜に駆ける", "群青"], { title: "THE BOOK", artist: "YOASOBI" });
  const romanized = (overrides = () => ({})) => yoasobi.tracks.map((track, index) => fileFor(yoasobi, index, {
    title: ["Yoru ni Kakeru", "Gunjou"][index], path: `YOASOBI/THE BOOK/${pad(index + 1)} ${["Yoru ni Kakeru", "Gunjou"][index]}.flac`,
    ...overrides(index),
  }));
  assert.equal(judgeRelease(yoasobi, listing(yoasobi, romanized())).kind, "exact");
  assert.deepEqual(judgeRelease(yoasobi, listing(yoasobi, romanized(), { artistLabel: null })).missing, [0, 1]);
  assert.deepEqual(judgeRelease(yoasobi, listing(yoasobi, romanized((index) => (index ? {} : { durationMs: 183000 + 3000 })))).missing, [0]);
  assert.deepEqual(judgeRelease(yoasobi, listing(yoasobi, romanized((index) => ({ trackNumber: 2 - index })))).missing, [0, 1]);

  for (const [expected, offered] of [["時", "詩"], ["愛", "哀"], ["Мой", "Мои"], ["かみ", "がみ"],
    ["Мой любимый город", "Мои любимый город"], ["Song がみ", "Song かみ"], ["कि", "की"], ["First Song", "Different Song"]]) {
    const single = release([expected]);
    assert.deepEqual(judgeRelease(single, listing(single, [fileFor(single, 0, { title: offered })])).missing, [0], offered);
  }
});

test("files numbered disc by hundred pair with their own disc", () => {
  const twoDiscs = release(["Alpha", "Beta", "Gamma", "Delta"], { discs: [[1, 1], [1, 2], [2, 1], [2, 2]] });
  const hundreds = twoDiscs.tracks.map((track) => {
    const path = `The Band/Album/${track.discNumber}${pad(track.trackNumber)} - ${track.title}.flac`;
    return { ...parseListingTitle(path), artists: [], durationMs: track.durationMs, recordingMbid: null, path };
  });
  assert.equal(judgeRelease(twoDiscs, listing(twoDiscs, hundreds)).kind, "exact");
  const swapped = hundreds.map((file, index) => ({ ...file, trackNumber: [201, 202, 101, 102][index] }));
  assert.deepEqual(judgeRelease(twoDiscs, listing(twoDiscs, swapped)).missing, [0, 1, 2, 3]);
});
