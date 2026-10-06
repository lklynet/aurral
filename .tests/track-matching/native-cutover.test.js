import test from "node:test";
import assert from "node:assert/strict";
import { buildSourceCandidates } from "../../backend/services/trackMatching/sourceSearch.js";
import { evaluateTrackCandidates } from "../../backend/services/trackMatching/decisionEngine.js";
import { validateDownloadedTrackFile } from "../../backend/services/trackMatching/postDownloadValidator.js";

test("source search can accept a matching track without a Python runtime", async () => {
  const result = await buildSourceCandidates({
    source: "soulseek",
    request: {
      trackName: "First Song", artistName: "The Band", durationMs: 180000,
    },
    results: [{
      file: "The Band/First Song.flac", filename: "The Band/First Song.flac",
      durationMs: 180000,
    }],
  });
  assert.equal(result.evaluations[0].decision, "accept");
});

test("a Soulseek filename naming another artist stays rejected despite matching title", async () => {
  const result = await evaluateTrackCandidates({
    source: "soulseek",
    request: { trackName: "First Song", artistName: "The Band", durationMs: 180000 },
    candidates: [{ source: "soulseek", title: "Other Band - First Song", filenameTitle: "First Song",
      artists: [], durationMs: 180000, provider: {}, raw: {} }],
    providerEvidence: [{ folder: { artistContradicted: true, artistScore: 0 } }],
  });
  assert.equal(result.evaluations[0].decision, "reject");
});

test("all source adapters reject a visible wrong recording before download", async () => {
  for (const source of ["soulseek", "usenet", "ytdlp", "deemix"]) {
    const result = await evaluateTrackCandidates({
      source,
      request: { trackName: "First Song", artistName: "The Band", durationMs: 180000,
        recordingMbid: "aa8bf4d6-ee95-4407-8f7b-2efb65240a23" },
      candidates: [{ title: "First Song", artist: "The Band", durationMs: 180000,
        recordingMbid: "a4b48a81-cdab-4e1a-8dd3-7907d6c85ca1", file: "The Band/First Song.flac" }],
    });
    assert.equal(result.evaluations[0].decision, "reject", source);
  }
});

test("a different track title is excluded from automatic source attempts", async () => {
  const result = await evaluateTrackCandidates({
    source: "soulseek",
    request: { trackName: "First Song", artistName: "The Band", durationMs: 180000 },
    candidates: [{ source: "soulseek", title: "A Different Song Entirely",
      filenameTitle: "A Different Song Entirely", artists: ["The Band"],
      durationMs: 180000, provider: {}, raw: {} }],
  });
  assert.equal(result.evaluations[0].decision, "reject");
});

test("a matching video channel and official-audio title remain a plausible track", async () => {
  const result = await buildSourceCandidates({
    source: "ytdlp",
    request: { trackName: "Get Lucky", artistName: "Daft Punk", durationMs: 248000 },
    results: [{ id: "video", title: "Daft Punk - Get Lucky (Official Audio)",
      channel: "Daft Punk", durationSec: 249 }],
  });
  assert.equal(result.evaluations[0].decision, "verify");
});

test("downloaded file verification uses original tags without a Python runtime", async () => {
  const result = await validateDownloadedTrackFile({
    request: { trackName: "First Song", artistName: "The Band", durationMs: 180000 },
    source: "soulseek",
    filePath: "/tmp/First Song.flac",
    options: { parseFile: async () => ({
      common: { title: "First Song", artist: "The Band" },
      format: { duration: 180, container: "FLAC", lossless: true, sampleRate: 44100,
        bitsPerSample: 16, numberOfChannels: 2 },
    }) },
  });
  assert.equal(result.decision, "VERIFIED");
});

test("a provider artist claim cannot fill a missing original file tag", async () => {
  const result = await validateDownloadedTrackFile({
    request: { trackName: "First Song", artistName: "The Band", durationMs: 180000 },
    candidate: { artists: ["The Band"] },
    source: "soulseek",
    filePath: "/tmp/First Song.flac",
    options: { parseFile: async () => ({
      common: { title: "First Song" },
      format: { duration: 180, container: "FLAC", lossless: true,
        sampleRate: 44100, bitsPerSample: 16 },
    }) },
  });
  assert.equal(result.decision, "AMBIGUOUS");
});

test("a live file name cannot be laundered by plain original tags", async () => {
  const result = await validateDownloadedTrackFile({
    request: { trackName: "First Song", artistName: "The Band", durationMs: 180000 },
    source: "soulseek",
    filePath: "/tmp/First Song (Live).flac",
    options: { parseFile: async () => ({
      common: { title: "First Song", artist: "The Band" },
      format: { duration: 180, container: "FLAC", lossless: true,
        sampleRate: 44100, bitsPerSample: 16 },
    }) },
  });
  assert.equal(result.decision, "CONFLICTED");
});
