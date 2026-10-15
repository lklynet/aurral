import test from "node:test";
import assert from "node:assert/strict";
import { selectSoulseekAlbumFolder, soulseekReleaseCopies } from "../../backend/services/albumReleaseSearch.js";
import { SAME_VERSION_LABELS } from "./version-labels.js";

function manifestFor(title, artist, tracks, extra = {}) {
  return {
    releaseMbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
    releaseGroupMbid: "1e0eee38-a9f6-49bf-84d0-45d0b2a5a4d1",
    title,
    artistNames: [artist],
    compilation: false,
    secondaryTypes: [],
    tracks: tracks.map(([disc, number, name, artists = [artist]], index) => ({
      title: name, artists, artistAliases: [], durationMs: 200000 + index * 10000,
      trackNumber: number, discNumber: disc, recordingMbid: null, recordingMbidAliases: [],
    })),
    ...extra,
  };
}

const jobsFor = (manifest) => manifest.tracks.map((track, index) => ({ id: `job-${index}`, trackName: track.title,
  trackNumber: track.trackNumber, discNumber: track.discNumber }));

const results = (user, folder, names, manifest) => names.map((name, index) => ({ user, file: `Music\\${folder}\\${name}.flac`,
  length: manifest.tracks[index] ? manifest.tracks[index].durationMs / 1000 : 190, size: 3e7, bitRate: 1000, slots: 1 }));

const picked = (selection) => selection.selected?.files.map(({ jobId, file }) => [jobId, file.split("\\").at(-1)]) ?? null;

const mellon = manifestFor("Mellon Collie", "Smashing Pumpkins",
  [[1, 1, "Tonight"], [1, 2, "Zero"], [2, 1, "Bodies"], [2, 2, "Thirty-Three"]]);

test("disc folders named by word, format, or subtitle join one release folder", () => {
  for (const [first, second] of [["Disc One", "Disc Two"], ["CD1 [FLAC]", "CD2 [FLAC]"],
    ["Disc 1 - Dawn to Dusk", "Disc 2 - Twilight to Starlight"]]) {
    const offered = [
      ...results("peer", `Smashing Pumpkins - Mellon Collie\\${second}`, ["01 - Bodies", "02 - Thirty-Three"], { tracks: mellon.tracks.slice(2) }),
      ...results("peer", `Smashing Pumpkins - Mellon Collie\\${first}`, ["01 - Tonight", "02 - Zero"], mellon),
    ];
    assert.deepEqual(picked(selectSoulseekAlbumFolder(offered, jobsFor(mellon), { manifest: mellon })), [
      ["job-0", "01 - Tonight.flac"], ["job-1", "02 - Zero.flac"], ["job-2", "01 - Bodies.flac"], ["job-3", "02 - Thirty-Three.flac"],
    ], first);
  }
  const deluxe = [
    ...results("peer", "Smashing Pumpkins - Mellon Collie (Deluxe)\\CD1", ["01 - Tonight", "02 - Zero"], mellon),
    ...results("peer", "Smashing Pumpkins - Mellon Collie (Deluxe)\\CD2", ["01 - Bodies", "02 - Thirty-Three", "03 - Bonus Song"],
      { tracks: mellon.tracks.slice(2) }),
  ];
  assert.equal(selectSoulseekAlbumFolder(deluxe, jobsFor(mellon), { manifest: mellon }).decision, "skip");
});

test("an album named like a disc keeps its own folder, and a vinyl side folder still joins its release", () => {
  const lp4 = manifestFor("LP4", "Ratatat", [[1, 1, "Bilar"], [1, 2, "Neckbrace"], [1, 3, "Drugs"]]);
  const songs = ["01 - Bilar", "02 - Neckbrace", "03 - Drugs"];
  for (const folder of ["Ratatat\\LP4", "Ratatat\\LP4 (2010)", "Ratatat\\LP4 - 2010", "Ratatat\\LP4 - Remastered",
    "Ratatat\\LP4 (2010) [Japan]", "Ratatat\\LP4 (Vinyl Rip)", "Ratatat\\LP4 [XL Recordings]", "Ratatat\\LP 4"]) {
    const offered = [...results("peer", folder, songs, lp4),
      ...results("peer", "Ratatat\\LP3", ["01 - Shempi", "02 - Falcon Jab", "03 - Mirando"], lp4)];
    const selection = selectSoulseekAlbumFolder(offered, jobsFor(lp4), { manifest: lp4 });
    assert.equal(selection.selected?.group.directoryPath, `Music/${folder.replace("\\", "/")}`, folder);
    assert.deepEqual(picked(selection).map(([job]) => job), ["job-0", "job-1", "job-2"], folder);
  }
  const lp1 = manifestFor("LP1", "FKA twigs", [[1, 1, "Preface"], [1, 2, "Lights On"]]);
  const twigs = results("peer", "FKA twigs\\LP1 - Deluxe Edition", ["01 - Preface", "02 - Lights On"], lp1);
  assert.equal(selectSoulseekAlbumFolder(twigs, jobsFor(lp1), { manifest: lp1 }).selected?.group.directoryPath,
    "Music/FKA twigs/LP1 - Deluxe Edition");
  const labelled = results("peer", "FKA twigs\\LP1 [2014] [Young Turks]", ["01 - Preface", "02 - Lights On"], lp1);
  assert.equal(selectSoulseekAlbumFolder(labelled, jobsFor(lp1), { manifest: lp1 }).selected?.group.directoryPath,
    "Music/FKA twigs/LP1 [2014] [Young Turks]");

  for (const [first, second] of [["LP 1", "LP 2"], ["LP1", "LP2"], ["LP 1 - Dawn to Dusk", "LP 2 - Twilight to Starlight"]]) {
    const vinyl = [
      ...results("peer", `Smashing Pumpkins - Mellon Collie (2LP)\\${second}`, ["01 - Bodies", "02 - Thirty-Three"],
        { tracks: mellon.tracks.slice(2) }),
      ...results("peer", `Smashing Pumpkins - Mellon Collie (2LP)\\${first}`, ["01 - Tonight", "02 - Zero"], mellon),
    ];
    assert.deepEqual(picked(selectSoulseekAlbumFolder(vinyl, jobsFor(mellon), { manifest: mellon })).map(([job]) => job),
      ["job-0", "job-1", "job-2", "job-3"], first);
  }
});

test("an album title with no letters or in another script still reaches the judge", () => {
  const divide = manifestFor("÷", "Ed Sheeran", [[1, 1, "Eraser"], [1, 2, "Castle on the Hill"]]);
  const offered = results("peer", "Ed Sheeran\\Ed Sheeran - ÷ (Divide) [FLAC]", ["01 - Eraser", "02 - Castle on the Hill"], divide);
  assert.equal(selectSoulseekAlbumFolder(offered, jobsFor(divide), { manifest: divide }).decision, "selectable");
  const multiply = results("peer", "Ed Sheeran\\Ed Sheeran - x (Multiply)", ["01 - One", "02 - I'm a Mess"], divide);
  assert.equal(selectSoulseekAlbumFolder(multiply, jobsFor(divide), { manifest: divide }).decision, "skip");

  const kino = manifestFor("Группа крови", "Кино", [[1, 1, "Группа крови"], [1, 2, "Закрой за мной дверь"]]);
  const latin = results("peer", "Kino\\Kino - Gruppa Krovi (1988) [FLAC]", ["01 - Группа крови", "02 - Закрой за мной дверь"], kino);
  assert.equal(selectSoulseekAlbumFolder(latin, jobsFor(kino), { manifest: kino }).decision, "selectable");
  const other = results("peer", "Kino\\Kino - Zvezda po imeni Solntse", ["01 - Звезда по имени Солнце", "02 - Пачка сигарет"], kino);
  assert.equal(selectSoulseekAlbumFolder(other, jobsFor(kino), { manifest: kino }).decision, "skip");
});

test("a folder named with artwork, an edition, bonus tracks, or a format holds the release", () => {
  const album = manifestFor("Album", "The Band", [[1, 1, "First"], [1, 2, "Second"]]);
  const names = ["01 - First", "02 - Second"];
  for (const folder of SAME_VERSION_LABELS) {
    assert.equal(selectSoulseekAlbumFolder(results("peer", `The Band\\${folder}`, names, album),
      jobsFor(album), { manifest: album }).decision, "selectable", folder);
  }
});

test("Various Artists and a band named Live keep their folders, and the band's live album does not", () => {
  const mix = manifestFor("Awesome Mix Vol. 1", "Various Artists",
    [[1, 1, "Hooked on a Feeling", ["Blue Swede"]], [1, 2, "Go All the Way", ["Raspberries"]]], { compilation: true });
  const credited = results("peer", "Various Artists - Awesome Mix Vol. 1",
    ["01 - Blue Swede - Hooked on a Feeling", "02 - Raspberries - Go All the Way"], mix);
  assert.equal(selectSoulseekAlbumFolder(credited, jobsFor(mix), { manifest: mix }).decision, "selectable");

  const copper = manifestFor("Throwing Copper", "Live", [[1, 1, "Selling the Drama"], [1, 2, "Lightning Crashes"]]);
  const names = ["01 - Selling the Drama", "02 - Lightning Crashes"];
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Live\\Live - Throwing Copper", names, copper),
    jobsFor(copper), { manifest: copper }).decision, "selectable");
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Live\\Live - Live at the Paradiso", names, copper),
    jobsFor(copper), { manifest: copper }).decision, "skip");
  const accented = { ...copper, artistNames: ["Lïve"], tracks: copper.tracks.map((track) => ({ ...track, artists: ["Lïve"] })) };
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Live\\Live - Throwing Copper (1994) [FLAC]", names, accented),
    jobsFor(accented), { manifest: accented }).decision, "selectable");
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Lïve\\Lïve - Throwing Copper (Live at Woodstock 1999)", names, accented),
    jobsFor(accented), { manifest: accented }).decision, "skip");
});

test("a title or album named with a version word keeps its folder", () => {
  const single = manifestFor("Live and Let Die", "Wings", [[1, 1, "Live and Let Die"], [1, 2, "I Lie Around"]]);
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Wings\\Wings - Live and Let Die (1973)",
    ["01 - Live and Let Die", "02 - I Lie Around"], single), jobsFor(single), { manifest: single }).decision, "selectable");
  const acoustic = manifestFor("Ocean Avenue Acoustic", "Yellowcard", [[1, 1, "Way Away"], [1, 2, "Breathing"]]);
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Yellowcard\\Yellowcard - Ocean Avenue Acoustic (2013)",
    ["01 - Way Away", "02 - Breathing"], acoustic), jobsFor(acoustic), { manifest: acoustic }).decision, "selectable");
  const studio = { ...acoustic, title: "Ocean Avenue" };
  assert.equal(selectSoulseekAlbumFolder(results("peer", "Yellowcard\\Yellowcard - Ocean Avenue Acoustic (2013)",
    ["01 - Way Away", "02 - Breathing"], studio), jobsFor(studio), { manifest: studio }).decision, "skip");
});

test("placeholder file names fit by their number like untitled files", () => {
  const album = manifestFor("Album", "The Band", [[1, 1, "Intro"], [1, 2, "Second"], [1, 3, "Third"]]);
  for (const names of [["Track 01", "Track 02", "Track 03"], ["Track01", "Track02", "Track03"],
    ["01 Track 01", "02 Track 02", "03 Track 03"]]) {
    assert.deepEqual(picked(selectSoulseekAlbumFolder(results("peer", "The Band\\Album", names, album), jobsFor(album),
      { manifest: album })), [["job-0", `${names[0]}.flac`], ["job-1", `${names[1]}.flac`], ["job-2", `${names[2]}.flac`]], names[0]);
  }
  const shuffled = results("peer", "The Band\\Album", ["Track 02", "Track 01", "Track 03"], album);
  assert.equal(selectSoulseekAlbumFolder(shuffled, jobsFor(album), { manifest: album }).decision, "skip");
});

test("a folder missing one other track still holds the wanted track's copy", () => {
  const album = manifestFor("Album", "The Band", [[1, 1, "First"], [1, 2, "Second"], [1, 3, "Third"]]);
  const offered = results("peer", "The Band - Album", ["01 - First", "02 - Second", "03 - Third"], album)
    .map((entry, index) => (index === 2 ? { ...entry, length: entry.length + 3 } : entry));
  assert.deepEqual([...soulseekReleaseCopies(offered, album, jobsFor(album)[0])],
    offered.map((entry) => `peer\0${entry.file}`));
  assert.equal(soulseekReleaseCopies(offered, album, jobsFor(album)[2]).size, 0);
});

test("a folder of generated silence at the release's lengths is not that release, though two of its files are real", () => {
  const lengths = [217720, 204667, 190693, 238720, 227173, 166013, 168253, 210187, 185400, 231000, 220787, 199300, 211733];
  const titles = ["Take It Away", "I Caught Fire", "Let It Bleed", "All That I've Got", "Cut Up Angels", "Listening",
    "Yesterday's Feelings", "Light With a Sharpened Edge", "Sound Effects and Overdramatics", "Hard to Say",
    "Lunacy Fringe", "I'm a Fake", "Under Pressure"];
  const base = manifestFor("In Love and Death", "The Used", titles.map((title, index) => [1, index + 1, title]));
  const album = { ...base, tracks: base.tracks.map((track, index) => ({ ...track, durationMs: lengths[index] })) };
  const number = (index) => String(index + 1).padStart(2, "0");
  const poisoned = results("driftwoodcassette7", "The Used\\In Love and Death (2004)",
    titles.map((title, index) => `The Used - In Love and Death - ${number(index)} - ${title}`), album)
    .map((entry, index) => ({ ...entry, size: index < 2 ? 26700000 : Math.round(entry.length * 206), speed: 9000000 }));
  const honest = results("hyot2", "The Used\\(2005) In Love And Death",
    titles.map((title, index) => `${number(index)} - ${title}`), album)
    .map((entry) => ({ ...entry, size: Math.round(entry.length * 125000), slots: 0, speed: 100000 }));

  const selection = selectSoulseekAlbumFolder([...poisoned, ...honest], jobsFor(album), { manifest: album });
  assert.deepEqual(selection.candidates.map(({ group }) => group.user), ["hyot2"]);
  assert.equal(selectSoulseekAlbumFolder(poisoned, jobsFor(album), { manifest: album }).decision, "skip");
  assert.deepEqual([...soulseekReleaseCopies([...poisoned, ...honest], album, jobsFor(album)[0])],
    honest.map((entry) => `hyot2\0${entry.file}`));
});

test("a release's own silent track does not condemn a real rip, and one damaged file only ranks its folder lower", () => {
  const lengths = [217720, 204667, 190693, 238720, 227173, 166013, 4000, 210187, 185400, 231000, 220787, 199300, 211733];
  const titles = ["Take It Away", "I Caught Fire", "Let It Bleed", "All That I've Got", "Cut Up Angels", "Listening",
    "[silence]", "Light With a Sharpened Edge", "Sound Effects and Overdramatics", "Hard to Say",
    "Lunacy Fringe", "I'm a Fake", "Under Pressure"];
  const base = manifestFor("In Love and Death", "The Used", titles.map((title, index) => [1, index + 1, title]));
  const album = { ...base, tracks: base.tracks.map((track, index) => ({ ...track, durationMs: lengths[index] })) };
  const number = (index) => String(index + 1).padStart(2, "0");
  const rip = (user, damaged, speed) => results(user, "The Used\\In Love and Death (2004)",
    titles.map((title, index) => `${number(index)} - ${title}`), album)
    .map((entry, index) => ({ ...entry, speed,
      size: index === 6 ? 10755 : damaged.includes(index) ? Math.round(entry.length * 206) : Math.round(entry.length * 125000) }));

  const selection = selectSoulseekAlbumFolder([...rip("damaged", [2], 9000000), ...rip("clean", [], 100000),
    ...rip("poisoned", [2, 4], 9000000)], jobsFor(album), { manifest: album });
  assert.deepEqual(selection.candidates.map(({ group }) => group.user), ["clean", "damaged"]);
});
