import test from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_POLICY,
  normalizeMatchText,
  parseListingTitle,
  decideRecording,
  verifyDownloadedRecording,
} from "../../backend/services/trackMatching/nativeMatcher.js";

const request = {
  title: "Hoppípolla",
  artists: ["Sigur Rós"],
  durationMs: 275000,
  recordingMbid: "cc82ee93-62b1-4424-8ea0-a24d775161e5",
};

test("normalization folds diacritics, punctuation, and spacing", () => {
  assert.equal(normalizeMatchText("  Hoppípolla!  "), "hoppipolla");
  assert.equal(normalizeMatchText("Sigur   Rós"), "sigur ros");
});

test("distinct non-Latin titles cannot be selected or verified", () => {
  for (const [expected, offered] of [
    ["時", "詩"], ["愛", "哀"], ["Мой", "Мои"], ["かみ", "がみ"],
    ["Мой любимый город", "Мои любимый город"], ["Song がみ", "Song かみ"], ["कि", "की"],
    ["時", "shi"], ["shi", "時"],
  ]) {
    const wanted = { title: expected, artists: ["X"], durationMs: 200000, recordingMbid: "ff339055-7335-4a88-8377-55e41514beb0" };
    const candidate = { ...wanted, title: offered };
    assert.equal(decideRecording(wanted, [candidate]).decision, "skip", `${expected}/${offered}`);
    assert.equal(verifyDownloadedRecording(wanted, candidate).decision, "no_match", `${expected}/${offered}`);
    assert.equal(verifyDownloadedRecording(wanted, {
      ...wanted, fileNameTitle: offered,
    }).decision, "no_match", `filename ${expected}/${offered}`);
    assert.equal(verifyDownloadedRecording(wanted, {
      ...wanted, title: null, fileNameTitle: offered,
    }).decision, "no_match", `missing tag ${expected}/${offered}`);
  }
});

test("script-safe identity preserves canonical equivalents and allowed title suffixes", () => {
  for (const [expected, offered] of [
    ["Мой", "Мои\u0306"], ["がみ", "か\u3099み"],
    ["Song がみ", "Song か\u3099み"], ["Hoppípolla", "Hoppipolla"],
    ["時", "時 - Remastered 2011"], ["がみ - Radio Edit", "がみ (Radio Edit)"],
    ["कि", "कि"],
  ]) {
    const wanted = { title: expected, artists: ["X"], durationMs: 200000 };
    const candidate = { ...wanted, title: offered };
    assert.equal(decideRecording(wanted, [candidate]).decision, "selectable", `${expected}/${offered}`);
    assert.equal(verifyDownloadedRecording(wanted, candidate).decision, "matched", `${expected}/${offered}`);
  }
});

test("oversized provider titles are not scored or selected", () => {
  const title = "Song ".repeat(110);
  const result = decideRecording({ title, artists: ["The Band"], durationMs: 180000 }, [{
    title, artists: ["The Band"], durationMs: 180000,
  }]);
  assert.equal(result.decision, "skip");
});

test("an artist alias can corroborate a recording without changing its title", () => {
  const result = decideRecording({ ...request, artists: ["Unknown Credit"], artistAliases: ["Sigur Ros"] }, [{
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
  }]);
  assert.equal(result.decision, "selectable");
  assert.ok(result.candidates[0].evidence.includes("artist"));
});

test("listing titles parse common album file layouts without changing song subtitles", () => {
  const examples = [
    ["01 Sexy Boy.flac", "Sexy Boy"],
    ["1-02 - Orfeo ed Euridice: Melodie.flac", "Orfeo ed Euridice: Melodie"],
    ["1-02 Song.flac", "Song"],
    ["Evil Genius - CD1 - 01 Off the Boat.flac", "Off the Boat"],
    ["[1.03] Moscow Olympics.flac", "Moscow Olympics"],
    ["Grateful Dead - 01 - Estimated Prophet.flac", "Estimated Prophet"],
    ["Lost Horizons (01).flac", "Lost Horizons"],
    ["06.flac", null],
  ];
  for (const [path, title] of examples) assert.equal(parseListingTitle(path).title, title);
  assert.equal(parseListingTitle("1-02 Song.flac").trackNumber, 2);
  for (const [path, trackNumber] of [["Track 01.flac", 1], ["Track07.mp3", 7], ["Audio Track 12.flac", 12],
    ["Track Star.flac", null]]) {
    assert.equal(parseListingTitle(path).trackNumber, trackNumber, path);
  }
  for (const [path, discNumber] of [
    ["2-05 Song.flac", 2], ["Evil Genius - CD2 - 01 Off the Boat.flac", 2], ["[3.01] Song.flac", 3],
    ["Album/CD 2/01 Song.flac", 2], ["Album/Disc 02/07.flac", 2], ["Album/01 Song.flac", undefined],
    ["Album/CD 2 - Live/01 Song.flac", 2], ["Album/Disc Two/01 Song.flac", 2], ["Album/CD1 [FLAC]/01 Song.flac", 1],
    ["Album/Disc 1 - Dawn to Dusk/01 Song.flac", 1], ["Album/Discovery/01 Song.flac", undefined],
    ["Album/Disco 2000/01 Song.flac", undefined], ["Album (2LP)/LP 2/01 Song.flac", 2],
    ["Album (3LP)/LP2/D6. Song.mp3", 2], ["Album (2LP)/LP 2 - Side C/01 Song.flac", 2],
  ]) assert.equal(parseListingTitle(path).discNumber, discNumber, path);
  for (const [path, album, discNumber] of [
    ["Ratatat/LP4 [FLAC]/01 Bilar.flac", "LP4", undefined], ["Liam Payne/LP1 (2019)/01 Strip That Down.flac", "LP1", undefined],
    ["Ratatat/LP4/01 Bilar.mp3", "LP3", 4], ["Album (2LP)/LP 2/01 Song.flac", "Album", 2], ["Album/CD2/01 Song.flac", "Album", 2],
    ["Ratatat/LP4 - Other Album/01 Bilar.flac", "LP4", 4],
  ]) assert.equal(parseListingTitle(path, { album }).discNumber, discNumber, `${path} on ${album}`);
});

test("known recording, variant, and duration contradictions cannot be rescued by title", () => {
  for (const candidate of [
    { title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000, recordingMbid: "d0941e68-da8f-4815-8ff8-6a61fc59f7c5" },
    { title: "Hoppipolla (Live)", artists: ["Sigur Ros"], durationMs: 275000 },
    { title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 320000 },
  ]) {
    const result = decideRecording(request, [candidate]);
    assert.equal(result.decision, "skip");
    assert.ok(result.candidates[0].contradictions.length > 0);
  }
});

test("matching live versions compare the song core while retaining variant identity", () => {
  const result = decideRecording({ ...request, title: "Hoppipolla (Live at Wembley)" }, [{
    title: "Hoppipolla (Live)", artists: ["Sigur Ros"], durationMs: 275000,
  }]);
  assert.equal(result.decision, "selectable");
});

test("a version the request's album or title names is no contradiction, and one it does not name is", () => {
  const liveAlbum = { ...request, title: "Hoppipolla", albumName: "Live at Wembley" };
  assert.equal(decideRecording(liveAlbum, [{
    title: "Hoppipolla (Live)", artists: ["Sigur Ros"], durationMs: 275000,
  }]).decision, "selectable");
  assert.equal(decideRecording(request, [{
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000, album: "Takk... (Acoustic)",
  }]).decision, "skip");
});

test("a declared extended mix conflicts with a plain request", () => {
  const result = decideRecording(request, [{
    title: "Hoppipolla (Extended Mix)", artists: ["Sigur Ros"], durationMs: 275000,
  }]);
  assert.equal(result.decision, "skip");
  assert.ok(result.candidates[0].contradictions.includes("extended-mix"));
});

test("an explicit different artist cannot be rescued by exact title and duration", () => {
  const result = decideRecording(request, [{
    title: "Hoppipolla", artists: ["Other Band"], durationMs: 275000,
  }]);
  assert.equal(result.decision, "skip");
  assert.ok(result.candidates[0].contradictions.includes("artist"));
});

test("missing evidence is not counted as agreement", () => {
  const result = decideRecording(request, [{ title: "Hoppipolla" }]);
  assert.notEqual(result.decision, "selectable");
  assert.equal(result.candidates[0].evidence.includes("artist"), false);
  assert.equal(result.candidates[0].evidence.includes("duration"), false);
});

test("equal distinct candidates abstain in stable input order", () => {
  const candidates = [
    { key: "a", title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000 },
    { key: "b", title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000 },
  ];
  const result = decideRecording(request, candidates);
  assert.equal(result.decision, "uncertain");
  assert.equal(result.selectedIndex, null);
  assert.deepEqual(result.candidates.map((item) => item.index), [0, 1]);
  assert.equal(result.policyVersion, MATCH_POLICY.version);
});

test("a track-only listing without a recording ID needs a close duration", () => {
  const result = decideRecording(request, [{
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 279000,
  }]);
  assert.equal(result.decision, "uncertain");
  assert.equal(result.selectedIndex, null);
});

test("one uncorroborated candidate needs an exact duration for automatic selection", () => {
  const result = decideRecording(request, [{
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275680,
  }]);
  assert.equal(result.decision, "uncertain");
  assert.equal(decideRecording(request, [{
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
  }]).decision, "selectable");
});

test("post-download verification reads versions from the title, file name, album, and folder together", () => {
  const acoustic = { title: "Apology (Acoustic)", artists: ["The Band"], durationMs: 200000, albumName: "Album" };
  const file = { title: "Apology (Acoustic)", artists: ["The Band"], durationMs: 200000 };
  assert.equal(verifyDownloadedRecording(acoustic, { ...file, filename: "15 Apology.flac", fileNameTitle: "Apology" }).decision, "matched");
  assert.equal(verifyDownloadedRecording(acoustic, { ...file, album: "Album (Acoustic)", path: "/staging/Album (Acoustic)/15 Apology.flac" }).decision, "matched");
  const plain = { ...acoustic, title: "Apology" };
  const offered = { ...file, title: "Apology" };
  for (const [observed, variant] of [
    [{ ...offered, path: "/staging/The Band/Album (Acoustic)/15 Apology.flac" }, "acoustic"],
    [{ ...offered, filename: "15 Apology (Live).flac", fileNameTitle: "Apology (Live)" }, "live"],
  ]) {
    const result = verifyDownloadedRecording(plain, observed);
    assert.equal(result.decision, "no_match", JSON.stringify(observed));
    assert.ok(result.contradictions.includes(variant), JSON.stringify(result.contradictions));
  }
  assert.equal(verifyDownloadedRecording({ title: "Live Forever", artists: ["Oasis"], durationMs: 276000 }, {
    title: "Live Forever", artists: ["Oasis"], durationMs: 276000,
    filename: "05 - Live Forever.flac", fileNameTitle: "Live Forever",
  }).decision, "matched");
});

test("post-download verification requires corroboration and rejects original tag conflicts", () => {
  assert.equal(verifyDownloadedRecording(request, {
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
    recordingMbid: "d0941e68-da8f-4815-8ff8-6a61fc59f7c5",
  }).decision, "no_match");
  assert.equal(verifyDownloadedRecording(request, {
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
    recordingMbid: "cc82ee93-62b1-4424-8ea0-a24d775161e5",
  }).decision, "matched");
});

test("a Various Artists credit on the request neither conflicts with nor confirms an artist", () => {
  const wanted = { title: "Hooked on a Feeling", artists: ["Various Artists"], durationMs: 173000 };
  const file = { title: "Hooked on a Feeling", artists: ["Blue Swede"], durationMs: 173000 };
  assert.notEqual(verifyDownloadedRecording(wanted, file).decision, "no_match");
  assert.equal(verifyDownloadedRecording({ ...wanted, recordingMbid: "e2862b5d-6c43-4368-8af6-4aadec5cb2ff" },
    { ...file, recordingMbid: "e2862b5d-6c43-4368-8af6-4aadec5cb2ff" }).decision, "matched");
  assert.equal(decideRecording(wanted, [{ ...file, artists: ["A Cover Band"] }]).decision, "uncertain");
  assert.equal(decideRecording({ ...wanted, artistAliases: ["Blue Swede"] }, [file]).decision, "selectable");
});
