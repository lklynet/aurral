import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  getMatcherScriptPath,
  isBeetsMatcherAvailable,
  resetMatcherAvailability,
  resolveMatcherPythonPath,
  runMatcherOperation,
} from "../../backend/services/trackMatching/beetsClient.js";
import { evaluateTrackCandidates } from "../../backend/services/trackMatching/decisionEngine.js";
import { buildTrackRequest } from "../../backend/services/trackMatching/trackIdentity.js";

resetMatcherAvailability();
const beetsAvailable = await isBeetsMatcherAvailable();

const skipReason = beetsAvailable ? false : "beets not installed for any available Python interpreter";

const GET_LUCKY = {
  artistName: "Daft Punk",
  trackName: "Get Lucky",
  albumName: "Random Access Memories",
  releaseYear: 2013,
  trackNumber: 8,
  durationMs: 248000,
};

test("health operation reports the pinned beets version", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("health");
  assert.equal(outcome.ok, true);
  assert.match(outcome.result.beetsVersion, /^\d+\.\d+\.\d+$/);
});

test("track distance tolerates providers that send null artist lists", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("track_distance", {
    expected: { artistName: "Daft Punk", trackName: "Get Lucky", durationMs: 248000 },
    candidates: [
      { source: "ytdlp", title: "Get Lucky", artist: null, artists: null, durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.matches[0].distance, 0);
});

test("matcher scores tracks without a writable Beets user config", { skip: skipReason }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aurral-beets-config-"));
  try {
    // Beets must not try to create or read this invalid user-config path.
    const configPath = join(directory, "config-file-not-directory");
    writeFileSync(configPath, "invalid user config");
    for (const request of [
      { protocol: 1, operation: "health" },
      {
        protocol: 1,
        operation: "track_distance",
        expected: { artistName: "Aurral", trackName: "Matcher Probe" },
        candidates: [{ artistName: "Aurral", title: "Matcher Probe" }],
      },
    ]) {
      const result = spawnSync(resolveMatcherPythonPath(), [getMatcherScriptPath()], {
        input: JSON.stringify(request),
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, BEETSDIR: configPath },
      });
      assert.equal(result.status, 0, `${request.operation}: ${result.stderr || result.stdout}`);
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      if (request.operation === "track_distance") {
        assert.equal(response.matches[0].distance, 0);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact structured match is accepted with a wide runner-up gap", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("track_distance", {
    expected: { ...GET_LUCKY },
    candidates: [
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationMs: 190000 },
      { source: "deemix", title: "Get Lucky", artist: "Lounge Covers Inc", durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.matches[0].distance <= 0.04, true);
  const distances = outcome.result.matches
    .map((match) => match.distance)
    .sort((left, right) => left - right);
  assert.ok(distances[1] - distances[0] > 0.1, `expected a meaningful gap, got ${distances}`);
  // beets reports raw distance evidence; Aurral derives recommendations and
  // best-vs-runner-up policy in the shared identity evaluator.
  assert.equal(outcome.result.operation, "track_distance");
});

test("diacritics and punctuation fold into a strong match", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("track_distance", {
    expected: { artistName: "Sigur Rós", trackName: "Hoppípolla", durationMs: 275000 },
    candidates: [
      { source: "deemix", title: "Hoppipolla", artist: "Sigur Ros", durationMs: 275000 },
      { source: "deemix", title: "Hoppipolla", artist: "The Cinematic Orchestra", durationMs: 275000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.result.matches[0].distance <= 0.04);
});

test("remix and radio edit candidates rank below the original mix", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("track_distance", {
    expected: { ...GET_LUCKY },
    candidates: [
      { source: "deemix", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky (Remix)", artist: "Daft Punk", durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  const original = outcome.result.matches.find((match) => match.candidateIndex === 1);
  const radio = outcome.result.matches.find((match) => match.candidateIndex === 0);
  const remix = outcome.result.matches.find((match) => match.candidateIndex === 2);
  assert.ok(radio.distance > original.distance);
  assert.ok(remix.distance > original.distance);
});

test("MBID conflicts only count when both sides carry identifiers", { skip: skipReason }, async () => {
  const withMbid = await runMatcherOperation("track_distance", {
    expected: { ...GET_LUCKY, recordingMbid: "rec-known" },
    candidates: [
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", durationMs: 248000 },
    ],
  });
  assert.equal(withMbid.ok, true);
  assert.ok(
    withMbid.result.matches[0].distance <= 0.04,
    "a missing candidate MBID must not veto an otherwise exact match",
  );

  const mismatched = await runMatcherOperation("track_distance", {
    expected: { ...GET_LUCKY, recordingMbid: "rec-known" },
    candidates: [
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", durationMs: 248000, recordingMbid: "rec-other" },
    ],
  });
  assert.equal(mismatched.ok, true);
  assert.ok(mismatched.result.matches[0].distance > 0.3);
});

test("malformed requests produce structured errors", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("track_distance", { candidates: [] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "invalid_request");
});

test("assign_items assigns scrambled files to the right release tracks", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("assign_items", {
    files: [
      { title: "The Game of Love", artist: "Daft Punk", durationMs: 325000 },
      { title: "Give Life Back to Music", artist: "Daft Punk", durationMs: 271000 },
      { title: "Get Lucky", artist: "Daft Punk feat. Pharrell Williams", durationMs: 249000 },
    ],
    releaseTracks: [
      { title: "Give Life Back to Music", artist: "Daft Punk", trackNumber: 1, durationMs: 271000 },
      { title: "The Game of Love", artist: "Daft Punk", trackNumber: 2, durationMs: 325000 },
      { title: "Get Lucky", artist: "Daft Punk feat. Pharrell Williams", trackNumber: 3, durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  const byFile = new Map(outcome.result.assignments.map((entry) => [entry.fileIndex, entry.releaseTrackIndex]));
  assert.equal(byFile.get(0), 1);
  assert.equal(byFile.get(1), 0);
  assert.equal(byFile.get(2), 2);
  assert.deepEqual(outcome.result.unassignedFileIndexes, []);
});

test("decision engine accepts the structured match and rejects contradictions", { skip: skipReason }, async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [
      { id: "exact", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248 },
      { id: "karaoke", title: "Get Lucky (Karaoke Version)", artist: "Daft Punk", durationSec: 248 },
      { id: "live", title: "Get Lucky (Live at Wembley)", artist: "Daft Punk", durationSec: 260 },
      { id: "wrong-artist", title: "Get Lucky", artist: "Lounge Covers Inc", durationSec: 248 },
      { id: "nightcore", title: "Get Lucky (Nightcore)", artist: "Daft Punk", durationSec: 190 },
    ],
  });
  assert.equal(evaluation.decision, "accept");
  assert.equal(evaluation.summary.bestCandidateIndex, 0);
  assert.equal(evaluation.evaluations[0].decision, "accept");

  const decisionsById = new Map(
    evaluation.evaluations.map((entry) => [entry.candidate.provider?.id || entry.candidateIndex, entry]),
  );
  assert.equal(decisionsById.get("karaoke").decision, "reject");
  assert.ok(decisionsById.get("karaoke").contradictions.includes("karaoke"));
  assert.equal(decisionsById.get("live").decision, "reject");
  assert.ok(decisionsById.get("live").contradictions.includes("live"));
  assert.equal(decisionsById.get("nightcore").decision, "reject");
  assert.ok(decisionsById.get("nightcore").contradictions.includes("nightcore"));
  assert.equal(decisionsById.get("wrong-artist").decision, "reject");
  assert.equal(decisionsById.get("wrong-artist").reason, "artist-mismatch");
});

test("decision engine rejects obvious downloader noise", { skip: skipReason }, async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "ytdlp",
    context: GET_LUCKY,
    candidates: [
      { id: "good", title: "Daft Punk - Get Lucky (Official Audio)", channel: "Daft Punk", durationSec: 249 },
      { id: "loop", title: "Daft Punk Get Lucky 10 hour", channel: "Loops", durationSec: 36000 },
    ],
  });
  assert.equal(evaluation.decision, "accept");
  const byId = new Map(evaluation.evaluations.map((entry) => [entry.candidate.provider?.id, entry]));
  assert.equal(byId.get("loop").decision, "reject");
  const loopReasons = [byId.get("loop").reason, ...(byId.get("loop").noise || [])].flat();
  assert.ok(
    loopReasons.includes("advertised-duration-mismatch") || loopReasons.includes("loop"),
    "the 10-hour upload must be rejected",
  );
});

test("soulseek filename candidates parse and match through the shared engine", { skip: skipReason }, async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "soulseek",
    context: GET_LUCKY,
    candidates: [
      {
        file: "Daft Punk/Random Access Memories (2013)/08. Daft Punk - Get Lucky.flac",
        user: "musicfan",
        slots: true,
        bitrate: 921600,
        length: 248.4,
      },
      {
        file: "Daft Punk/Get Lucky - Single/01. Daft Punk - Get Lucky (Radio Edit).mp3",
        user: "otherfan",
        slots: true,
        bitrate: 320000,
        length: 190,
      },
    ],
  });
  assert.equal(evaluation.decision, "accept");
  assert.equal(evaluation.summary.bestCandidateIndex, 0);
  assert.equal(evaluation.evaluations[0].candidate.filenameTitle, "Get Lucky");
});

test("requested live version accepts live candidate but rejects studio", { skip: skipReason }, async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: { artistName: "Daft Punk", trackName: "Get Lucky (Live at Wembley)", durationMs: 260000 },
    candidates: [
      { id: "live", title: "Get Lucky (Live)", artist: "Daft Punk", durationSec: 260 },
      { id: "studio", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
    ],
  });
  const byId = new Map(evaluation.evaluations.map((entry) => [entry.candidate.provider?.id, entry]));
  assert.equal(byId.get("live").decision, "accept");
  assert.equal(byId.get("studio").decision, "reject");
  assert.ok(byId.get("studio").contradictions.includes("live"));
});

test("unified matcher failure surfaces a clean error decision", async () => {
  resetMatcherAvailability();
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [{ id: "x", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 }],
    options: {
      pythonPath: "/nonexistent/python-binary",
      scriptPath: "/nonexistent/aurral_matcher.py",
      timeoutMs: 2000,
    },
  });
  assert.equal(evaluation.decision, "error");
  resetMatcherAvailability();
});

test("candidates rejected by semantic policy do not invoke the matcher", async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [{ id: "karaoke", title: "Get Lucky (Karaoke Version)", artist: "Daft Punk", durationSec: 248 }],
    options: {
      pythonPath: "/nonexistent/python-binary",
      scriptPath: "/nonexistent/aurral_matcher.py",
    },
  });
  assert.equal(evaluation.decision, "reject");
  assert.equal(evaluation.summary.decision, "reject");
  assert.equal(evaluation.evaluations[0].decision, "reject");
  assert.equal(evaluation.error, undefined);
});

test("canonical track request normalization is stable for the corpus", () => {
  const request = buildTrackRequest({
    ...GET_LUCKY,
    artistAliases: ["Daft Punk"],
  });
  assert.equal(request.trackName, "Get Lucky");
  assert.equal(request.artistMbid, null);
  assert.equal(request.recordingMbid, null);
  assert.equal(request.variants.live, false);
});

test("duplicate uploads do not create runner-up ambiguity; distinct competitors do", { skip: skipReason }, async () => {
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [
      { id: "copy-a", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
      { id: "copy-b", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
      { id: "copy-c", title: "Get Lucky", artist: "Daft Punk", durationSec: 248.2 },
    ],
  });
  // Three identical uploads of the same recording: no distinct runner-up
  // exists, so the accept stands and the gap is null.
  assert.equal(evaluation.decision, "accept");
  assert.equal(evaluation.gap, null);
  assert.equal(evaluation.evaluations.filter((entry) => entry.duplicateOfBest).length, 2);

  // A distinct competitor (different artist identity) reintroduces the
  // separation requirement. A remaster of the same recording would NOT:
  // the dedup key deliberately treats same-title/same-artist/same-duration
  // remasters as the same acceptable recording.
  const withCompetitor = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [
      { id: "copy-a", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
      { id: "copy-b", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
      { id: "near-artist", title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk feat. Pharrell Williams", durationSec: 248 },
    ],
  });
  assert.ok(withCompetitor.gap != null, "gap is measured to the first distinct runner-up");
  assert.equal(withCompetitor.gap > 0, true);
});

test("same-recording duplicates (deluxe/remaster cuts) keep a single accept and stay usable", { skip: skipReason }, async () => {
  // Same title, artist, and duration but a different release: per the
  // same-recording policy these are the same recording, so they share the
  // semantic dedup key. They must not create runner-up ambiguity.
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: GET_LUCKY,
    candidates: [
      { id: "album-cut", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248 },
      { id: "deluxe-cut", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories (10th Anniversary Edition)", durationSec: 248 },
    ],
  });
  const usable = evaluation.evaluations.filter(
    (entry) => entry.decision === "accept" || entry.decision === "verify",
  );
  // Duplicates of an accepted recording are equally acceptable — the point
  // is that they neither create nor relieve runner-up ambiguity.
  assert.equal(usable.length, 2);
  assert.equal(usable.filter((entry) => entry.duplicateOfBest).length, 1);
  assert.equal(evaluation.gap, null, "no distinct runner-up: no ambiguity to resolve");
  assert.equal(evaluation.decision, "accept");
});

test("metadata-indistinguishable re-recording is accepted today (fingerprinting gap)", { skip: skipReason }, async () => {
  // An artist re-records their own song years later. Title and duration are
  // nearly identical and no descriptor marks the new version. Metadata
  // alone cannot separate the performances: this pins today's behavior so
  // the future fingerprint escalation changes it deliberately.
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: {
      artistName: "Jonny Kestrel",
      trackName: "Northern Line",
      releaseYear: 2013,
      durationMs: 215000,
    },
    candidates: [
      // The 2019 re-recording, indistinguishable by metadata.
      { id: "rerecording", title: "Northern Line", artist: "Jonny Kestrel", durationSec: 215.4 },
    ],
  });
  assert.equal(evaluation.decision, "accept");
  assert.equal(
    (evaluation.evaluations[0].contradictions ?? []).length,
    0,
    "no metadata evidence exists to reject this candidate",
  );
});

test("recording MBID comparisons never cross entity types", { skip: skipReason }, async () => {
  // A release-group MBID in the expected album slot must neither satisfy nor
  // contradict the recording check.
  const request = { ...GET_LUCKY, albumMbid: "rg-abc", recordingMbid: null };
  const candidateWithReleaseGroupAsRecording = {
    id: "weird-provider",
    title: "Get Lucky",
    artist: "Daft Punk",
    durationSec: 248,
    recordingMbid: "rg-abc",
  };
  const evaluation = await evaluateTrackCandidates({
    source: "deemix",
    context: request,
    candidates: [candidateWithReleaseGroupAsRecording],
  });
  // No expected recording MBID: no identifier comparison happens at all, so
  // the candidate is judged on metadata alone.
  assert.notEqual(evaluation.evaluations[0].reason, "recording-mbid-conflict");
  assert.equal(evaluation.evaluations[0].aurralEvidence.recordingMbid, null);

  // A conflicting recording MBID stays a hard contradiction.
  const conflict = await evaluateTrackCandidates({
    source: "deemix",
    context: { ...GET_LUCKY, recordingMbid: "rec-real" },
    candidates: [{ id: "c", title: "Get Lucky", artist: "Daft Punk", durationSec: 248, recordingMbid: "rec-other" }],
  });
  assert.equal(conflict.evaluations[0].reason, "recording-mbid-conflict");
});
