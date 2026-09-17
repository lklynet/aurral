import test from "node:test";
import assert from "node:assert/strict";
import {
  isBeetsMatcherAvailable,
  resetMatcherAvailability,
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

test("exact structured match is accepted with a wide runner-up gap", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("rank_tracks", {
    expected: { ...GET_LUCKY },
    candidates: [
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationMs: 190000 },
      { source: "deemix", title: "Get Lucky", artist: "Lounge Covers Inc", durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.bestCandidateIndex, 0);
  assert.equal(outcome.result.matches[0].distance <= 0.04, true);
  assert.ok(outcome.result.gap > 0.1, `expected a meaningful gap, got ${outcome.result.gap}`);
  // beets reports distances and thresholds; Aurral derives recommendations.
  assert.equal(outcome.result.thresholds.strongRecThresh, 0.04);
});

test("diacritics and punctuation fold into a strong match", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("rank_tracks", {
    expected: { artistName: "Sigur Rós", trackName: "Hoppípolla", durationMs: 275000 },
    candidates: [
      { source: "deemix", title: "Hoppipolla", artist: "Sigur Ros", durationMs: 275000 },
      { source: "deemix", title: "Hoppipolla", artist: "The Cinematic Orchestra", durationMs: 275000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.bestCandidateIndex, 0);
  assert.ok(outcome.result.matches[0].distance <= 0.04);
});

test("remix and radio edit candidates rank below the original mix", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("rank_tracks", {
    expected: { ...GET_LUCKY },
    candidates: [
      { source: "deemix", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", durationMs: 248000 },
      { source: "deemix", title: "Get Lucky (Remix)", artist: "Daft Punk", durationMs: 248000 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.bestCandidateIndex, 1);
  const remix = outcome.result.matches.find((match) => match.candidateIndex === 2);
  assert.ok(remix.distance > outcome.result.matches[1].distance);
});

test("MBID conflicts only count when both sides carry identifiers", { skip: skipReason }, async () => {
  const withMbid = await runMatcherOperation("rank_tracks", {
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

  const mismatched = await runMatcherOperation("rank_tracks", {
    expected: { ...GET_LUCKY, recordingMbid: "rec-known" },
    candidates: [
      { source: "deemix", title: "Get Lucky", artist: "Daft Punk", durationMs: 248000, recordingMbid: "rec-other" },
    ],
  });
  assert.equal(mismatched.ok, true);
  assert.ok(mismatched.result.matches[0].distance > 0.3);
});

test("malformed requests produce structured errors", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("rank_tracks", { candidates: [] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "invalid_request");
});

test("match_release assigns scrambled files to the right release tracks", { skip: skipReason }, async () => {
  const outcome = await runMatcherOperation("match_release", {
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
