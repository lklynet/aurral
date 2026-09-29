import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrackCandidates } from "../../backend/services/trackMatching/decisionEngine.js";
import { buildTrackRequest } from "../../backend/services/trackMatching/trackIdentity.js";

const request = {
  artistName: "Daft Punk", trackName: "Get Lucky",
  albumName: "Random Access Memories", durationMs: 248000,
};

test("structured results select the recording and reject wrong variants and artists", async () => {
  const evaluation = await evaluateTrackCandidates({ source: "deemix", context: request,
    candidates: [
      { id: "exact", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
      { id: "karaoke", title: "Get Lucky (Karaoke)", artist: "Daft Punk", durationSec: 248 },
      { id: "other", title: "Get Lucky", artist: "Lounge Covers Inc", durationSec: 248 },
    ] });
  const byId = new Map(evaluation.evaluations.map((entry) => [entry.candidate.provider.id, entry]));
  assert.equal(byId.get("exact").decision, "accept");
  assert.equal(byId.get("karaoke").decision, "reject");
  assert.equal(byId.get("other").decision, "reject");
});

test("source candidates with a visible wrong recording ID never become usable", async () => {
  const evaluation = await evaluateTrackCandidates({ source: "deemix",
    context: { ...request, recordingMbid: "wanted" },
    candidates: [{ id: "wrong", title: "Get Lucky", artist: "Daft Punk",
      durationSec: 248, recordingMbid: "other" }] });
  assert.equal(evaluation.evaluations[0].decision, "reject");
  assert.ok(evaluation.evaluations[0].contradictions.includes("recording-mbid"));
});

test("the canonical request keeps recording and album identifiers separate", () => {
  const normalized = buildTrackRequest({ ...request, albumMbid: "album-only" });
  assert.equal(normalized.recordingMbid, null);
  assert.equal(normalized.albumMbid, "album-only");
});
