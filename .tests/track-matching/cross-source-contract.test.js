// Cross-source contract tests.
//
// The same canonical truth expressed through each provider's representation
// must produce compatible identity decisions. Provider evidence may change
// confidence (accept vs verify) and contradictions must reject everywhere.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceCandidates,
  usableEvaluationEntries,
  validateDownloadedTrackFile,
  POST_DOWNLOAD_DECISIONS,
} from "../../backend/services/trackMatching/index.js";

const beetsAvailable = await (async () => {
  const { isBeetsMatcherAvailable, resetMatcherAvailability } = await import(
    "../../backend/services/trackMatching/index.js"
  );
  resetMatcherAvailability();
  return isBeetsMatcherAvailable();
})();
const skip = beetsAvailable ? false : "beets not installed for any available Python interpreter";
const btest = (name, fn) => test(name, { skip }, fn);

const TRUTH = {
  artistName: "Daft Punk",
  trackName: "Get Lucky",
  albumName: "Random Access Memories",
  releaseYear: 2013,
  trackNumber: 8,
  durationMs: 248000,
};

async function decisionFor(source, candidates, request = TRUTH, options = {}) {
  const evaluation = await buildSourceCandidates({ source, candidates, request, options });
  const usable = usableEvaluationEntries(evaluation);
  return { evaluation, best: usable[0] || null, usable };
}

btest("structured provider result accepts the right track and rejects wrong artists", { skip }, async () => {
  // Availability (readable) is a provider check the orchestrator applies
  // before results reach the shared engine.
  const results = [
    { id: "good", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248, readable: true },
    { id: "bad-artist", title: "Get Lucky", artist: "Lounge Covers Inc", durationSec: 248, readable: true },
    { id: "bad-duration", title: "Get Lucky", artist: "Daft Punk", durationSec: 620, readable: true },
    { id: "unplayable", title: "Get Lucky", artist: "Daft Punk", durationSec: 248, readable: false },
  ].filter((entry) => entry.readable !== false);
  const { best } = await decisionFor("deemix", results);
  assert.ok(best, "a usable candidate must exist");
  assert.equal(best.candidate.provider.id, "good");
});

btest("the same wrong-artist truth is rejected through every provider shape", { skip }, async () => {
  // deemix: structured artist field
  const deemix = await decisionFor("deemix", [
    { id: "x", title: "Get Lucky", artist: "Karaoke Party Band", durationSec: 248 },
  ]);
  // ytdlp: artist only appears inside the video title/channel
  const ytdlp = await decisionFor("ytdlp", [
    { id: "y", title: "Karaoke Party Band - Get Lucky (Karaoke Version)", channel: "Karaoke Party Band", durationSec: 248 },
  ]);
  // soulseek: artist only appears in the folder/file name
  const soulseek = await decisionFor("soulseek", [
    { user: "u", file: "Karaoke Party Band\\Get Lucky (Karaoke Version).mp3", bitrate: 320, length: 248 },
  ]);
  assert.equal(deemix.best, null, "structured wrong artist must not be usable");
  assert.equal(ytdlp.best, null, "karaoke-titled video must not be usable");
  assert.equal(soulseek.best, null, "wrong-artist folder must not be usable");
});

btest("correct track expressed in provider-native shapes is accepted everywhere", { skip }, async () => {
  const deemix = await decisionFor("deemix", [
    { id: "d1", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248 },
  ]);
  const ytdlp = await decisionFor("ytdlp", [
    { id: "v1", title: "Daft Punk - Get Lucky (Official Audio)", channel: "Daft Punk", durationSec: 249 },
  ]);
  const soulseek = await decisionFor("soulseek", [
    {
      user: "peer",
      file: "Daft Punk\\Random Access Memories (2013)\\08. Daft Punk - Get Lucky.flac",
      bitrate: 921600,
      length: 248.4,
    },
  ]);

  assert.ok(deemix.best, "deemix must produce a usable candidate");
  assert.ok(ytdlp.best, "ytdlp must produce a usable candidate");
  assert.ok(soulseek.best, "soulseek must produce a usable candidate");
  assert.equal(deemix.best.decision, "accept");
  assert.equal(ytdlp.best.decision, "accept");
  assert.equal(soulseek.best.decision, "accept");
  // Identity beats presentation noise: the YouTube descriptor does not turn
  // the structured and scraped results into different verdicts.
  assert.equal(deemix.best.distance, 0);
  assert.equal(soulseek.best.distance, 0);
});

btest("live variant truth: live requests accept live files and reject studio everywhere", { skip }, async () => {
  const liveRequest = {
    ...TRUTH,
    trackName: "Get Lucky (Live)",
    durationMs: 260000,
  };
  const deemix = await decisionFor(
    "deemix",
    [
      { id: "live", title: "Get Lucky (Live)", artist: "Daft Punk", durationSec: 260 },
      { id: "studio", title: "Get Lucky", artist: "Daft Punk", durationSec: 248 },
    ],
    liveRequest,
  );
  assert.equal(deemix.best.candidate.provider.id, "live");
  assert.equal(deemix.best.decision, "accept");
  const studioEvaluation = deemix.evaluation.evaluations.find(
    (entry) => entry.candidate.provider?.id === "studio",
  );
  assert.equal(studioEvaluation.decision, "reject");
  assert.ok(studioEvaluation.contradictions.includes("live"));
});

btest("radio edit vs album version is rejected unless requested", { skip }, async () => {
  const studio = await decisionFor("deemix", [
    { id: "radio", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationSec: 190 },
  ]);
  assert.equal(studio.best, null, "a radio edit must not stand in for the album version");

  const requested = await decisionFor(
    "deemix",
    [{ id: "radio", title: "Get Lucky (Radio Edit)", artist: "Daft Punk", durationSec: 190 }],
    { ...TRUTH, trackName: "Get Lucky (Radio Edit)", durationMs: 190000 },
  );
  assert.ok(requested.best, "the radio edit is correct when requested");
});

btest("remaster of the same recording stays acceptable (same-recording policy)", { skip }, async () => {
  const { best, evaluation } = await decisionFor("deemix", [
    { id: "remaster", title: "Get Lucky (2013 Remaster)", artist: "Daft Punk", album: "Random Access Memories (10th Anniversary Edition)", durationSec: 248 },
  ]);
  assert.ok(best, "an ordinary remaster must remain usable");
  assert.equal((best.contradictions ?? []).length, 0);
  assert.equal((evaluation.evaluations[0].contradictions ?? []).length, 0);
});

btest("compilation appearance of the same recording stays acceptable", { skip }, async () => {
  const { best } = await decisionFor("soulseek", [
    {
      user: "compPeer",
      file: "Various\\Summer Hits 2013\\Disc 1\\04. Get Lucky.mp3",
      bitrate: 320,
      length: 248,
    },
  ]);
  assert.ok(best, "a compilation appearance must remain usable");
});

btest("post-download: the same truth through actual file tags converges with pre-download verdicts", { skip }, async () => {
  const verified = await validateDownloadedTrackFile({
    request: TRUTH,
    filePath: "/staging/08 - Daft Punk - Get Lucky.flac",
    source: "soulseek",
    options: {
      parseFile: async () => ({
        common: {
          title: "Get Lucky",
          artist: "Daft Punk",
          album: "Random Access Memories",
          track: { no: 8 },
          disc: { no: 1 },
        },
        format: { duration: 248.2, lossless: true, sampleRate: 44100, bitsPerSample: 16, bitrate: 900000 },
      }),
    },
  });
  assert.equal(verified.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);

  const karaoke = await validateDownloadedTrackFile({
    request: TRUTH,
    filePath: "/staging/Get Lucky (Karaoke Version).mp3",
    source: "ytdlp",
    options: {
      parseFile: async () => ({
        common: {
          title: "Get Lucky (Karaoke Version)",
          artist: "Daft Punk",
        },
        format: { duration: 248, lossless: false, sampleRate: 44100, bitrate: 128000, container: "MPEG", codec: "MPEG 1 Layer 3" },
      }),
    },
  });
  assert.equal(karaoke.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

btest("featured-artist naming does not break cross-source identity", { skip }, async () => {
  const deemix = await decisionFor("deemix", [
    { id: "feat", title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248 },
  ]);
  const ytdlp = await decisionFor("ytdlp", [
    { id: "vfeat", title: "Daft Punk - Get Lucky ft. Pharrell Williams (Official Video)", channel: "Daft Punk", durationSec: 248 },
  ]);
  assert.equal(deemix.best?.decision, "accept");
  assert.equal(ytdlp.best?.decision, "accept");
});

btest("diacritics and punctuation fold consistently across sources", { skip }, async () => {
  const request = { artistName: "Sigur Rós", trackName: "Hoppípolla", albumName: "Takk...", durationMs: 275000 };
  const deemix = await decisionFor(
    "deemix",
    [{ id: "d", title: "Hoppipolla", artist: "Sigur Ros", album: "Takk", durationSec: 275 }],
    request,
  );
  const soulseek = await decisionFor(
    "soulseek",
    [{ user: "iceland", file: "Sigur Ros\\Takk\\04 - Sigur Ros - Hoppipolla.flac", bitrate: 921600, length: 275 }],
    request,
  );
  assert.equal(deemix.best?.decision, "accept");
  assert.equal(soulseek.best?.decision, "accept");
});
