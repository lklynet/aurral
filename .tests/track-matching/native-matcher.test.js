import test from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_POLICY,
  normalizeMatchText,
  parseListingTitle,
  decideRecording,
  assignReleaseFiles,
  assessRelease,
  selectReleaseSession,
  verifyDownloadedRecording,
} from "../../backend/services/trackMatching/nativeMatcher.js";

const request = {
  title: "Hoppípolla",
  artists: ["Sigur Rós"],
  durationMs: 275000,
  recordingMbid: "recording-studio",
};

test("normalization folds diacritics, punctuation, and spacing", () => {
  assert.equal(normalizeMatchText("  Hoppípolla!  "), "hoppipolla");
  assert.equal(normalizeMatchText("Sigur   Rós"), "sigur ros");
});

test("distinct non-Latin titles cannot be selected, assigned, or verified", () => {
  for (const [expected, offered] of [
    ["時", "詩"], ["愛", "哀"], ["Мой", "Мои"], ["かみ", "がみ"],
    ["Мой любимый город", "Мои любимый город"], ["Song がみ", "Song かみ"], ["कि", "की"],
    ["時", "shi"], ["shi", "時"],
  ]) {
    const wanted = { title: expected, artists: ["X"], durationMs: 200000, recordingMbid: "same" };
    const candidate = { ...wanted, title: offered };
    assert.equal(decideRecording(wanted, [candidate]).decision, "skip", `${expected}/${offered}`);
    assert.deepEqual(assignReleaseFiles([wanted], [candidate]).pairs, [], `${expected}/${offered}`);
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
});

test("known recording, variant, and duration contradictions cannot be rescued by title", () => {
  for (const candidate of [
    { title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000, recordingMbid: "other" },
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

test("one-to-one release assignment handles scrambled files and leaves wrong variants out", () => {
  const tracks = [
    { title: "First Song", artists: ["The Band"], durationMs: 180000, trackNumber: 1 },
    { title: "Second Song", artists: ["The Band"], durationMs: 200000, trackNumber: 2 },
  ];
  const files = [
    { title: "Second Song", artists: ["The Band"], durationMs: 200000, trackNumber: 2 },
    { title: "First Song", artists: ["The Band"], durationMs: 180000, trackNumber: 1 },
    { title: "First Song (Live)", artists: ["The Band"], durationMs: 180000 },
  ];
  const assignment = assignReleaseFiles(tracks, files);
  assert.deepEqual(assignment.pairs.map((pair) => [pair.trackIndex, pair.fileIndex]), [[0, 1], [1, 0]]);
  assert.deepEqual(assignment.unassignedFileIndexes, [2]);
  const assessment = assessRelease({ tracks }, { files });
  assert.equal(assessment.decision, "selectable");
  assert.equal(assessment.coverage, 1);
});

test("release assignment keeps the highest-scoring complete pairing", () => {
  const tracks = [
    { title: "Interlude", artists: ["The Band"], durationMs: 100000 },
    { title: "Interlude", artists: ["The Band"], durationMs: 101000 },
  ];
  const files = [
    { title: "Interlude", artists: ["The Band"], durationMs: 100000 },
    { title: "Interlude", artists: ["The Band"], durationMs: 102000 },
  ];
  assert.deepEqual(assignReleaseFiles(tracks, files).pairs.map((pair) => pair.fileIndex), [0, 1]);
});

test("an exact album listing can fit when filenames lack artist tags", () => {
  const titles = Array.from({ length: 11 }, (_, index) => `Song ${index + 1}`);
  const result = assessRelease(
    { tracks: titles.map((title) => ({
      title, artists: ["The Band"], durationMs: 180000,
    })) },
    { files: titles.map((title) => ({
      title, durationMs: 180000,
    })) },
  );
  assert.equal(result.decision, "selectable");
  assert.equal(result.coverage, 1);
});

test("release context assigns a numbered file with no title only when position and duration agree", () => {
  const tracks = [
    { title: "First Song", artists: ["The Band"], durationMs: 180000, trackNumber: 1 },
    { title: "Second Song", artists: ["The Band"], durationMs: 200000, trackNumber: 2 },
  ];
  const files = [
    { title: "First Song", durationMs: 180000, trackNumber: 1 },
    { ...parseListingTitle("02.flac"), durationMs: 200000 },
  ];
  assert.deepEqual(assignReleaseFiles(tracks, files).pairs.map((pair) => pair.fileIndex), [0, 1]);
  assert.equal(assessRelease({ tracks }, { files }).decision, "selectable");
  files[1] = { title: "Different Song", durationMs: 200000, trackNumber: 2 };
  assert.deepEqual(assignReleaseFiles(tracks, files).unassignedTrackIndexes, [1]);
});

test("a listing without lengths fits when exact titles sit at their positions", () => {
  const tracks = ["First Song", "Second Song", "Third Song"].map((title, index) => ({
    title, artists: ["The Band"], durationMs: 180000 + index * 10000, trackNumber: index + 1,
  }));
  const files = tracks.map(({ title, trackNumber }) => ({ title, trackNumber }));
  assert.equal(assessRelease({ tracks }, { files }).decision, "selectable");
  const shuffled = [
    { title: "First Song", trackNumber: 2 },
    { title: "Second Song", trackNumber: 3 },
    { title: "Third Song", trackNumber: 1 },
  ];
  assert.equal(assessRelease({ tracks }, { files: shuffled }).decision, "skip");
});

test("every three-track file order keeps a one-to-one assignment", () => {
  const tracks = ["Alpha", "Bravo", "Charlie"].map((title, index) => ({
    title, durationMs: 180000 + index * 10000,
  }));
  for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) for (const c of [0, 1, 2]) {
    if (new Set([a, b, c]).size !== 3) continue;
    const order = [a, b, c];
    const files = order.map((index) => ({ ...tracks[index] }));
    const result = assignReleaseFiles(tracks, files);
    assert.deepEqual(result.pairs.map((pair) => pair.fileIndex),
      [0, 1, 2].map((index) => order.indexOf(index)));
  }
});

test("duplicate titles use track position and leave a duplicate file unassigned", () => {
  const tracks = [
    { title: "Interlude", artists: ["The Band"], durationMs: 50000, trackNumber: 1 },
    { title: "Interlude", artists: ["The Band"], durationMs: 50000, trackNumber: 2 },
  ];
  const files = [
    { title: "Interlude", artists: ["The Band"], durationMs: 50000, trackNumber: 2 },
    { title: "Interlude", artists: ["The Band"], durationMs: 50000, trackNumber: 2 },
  ];
  const result = assignReleaseFiles(tracks, files);
  assert.deepEqual(result.pairs.map(({ trackIndex }) => trackIndex), [1]);
  assert.deepEqual(result.unassignedTrackIndexes, [0]);
});

test("post-download verification requires corroboration and rejects original tag conflicts", () => {
  assert.equal(verifyDownloadedRecording(request, {
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
    recordingMbid: "other",
  }).decision, "no_match");
  assert.equal(verifyDownloadedRecording(request, {
    title: "Hoppipolla", artists: ["Sigur Ros"], durationMs: 275000,
    recordingMbid: "recording-studio",
  }).decision, "matched");
});

test("release session requires the requested slot and abstains between equal folders", () => {
  const release = { key: "release", tracks: [
    { title: "First Song", artists: ["The Band"], durationMs: 180000, recordingMbid: "first" },
    { title: "Second Song", artists: ["The Band"], durationMs: 200000, recordingMbid: "second" },
  ] };
  const good = { key: "good", files: [
    { title: "First Song", durationMs: 180000 },
    { title: "Second Song", durationMs: 200000 },
  ] };
  const wrongSlot = { key: "wrong", files: [
    { title: "First Song", durationMs: 180000 },
    { title: "Second Song (Live)", durationMs: 200000 },
  ] };
  assert.equal(selectReleaseSession({ releases: [release], folders: [good, wrongSlot],
    requestedRecordingMbid: "second" }).selected?.folder.key, "good");
  assert.equal(selectReleaseSession({ releases: [release], folders: [wrongSlot],
    requestedRecordingMbid: "second" }).decision, "skip");
  assert.equal(selectReleaseSession({ releases: [release], folders: [good, { ...good, key: "copy" }],
    requestedRecordingMbid: "second" }).decision, "uncertain");
});
