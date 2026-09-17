// Unified post-download validator tests.
//
// The critical invariant: validation reads the ORIGINAL embedded tags, never
// the metadata Aurral is about to write. Real-file cases use ffmpeg to
// generate tagged audio; unit cases inject a parse function.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDownloadedTrackFile,
  selectVerifiedDownloadedFile,
  isBeetsMatcherAvailable,
  resetMatcherAvailability,
  POST_DOWNLOAD_DECISIONS,
} from "../../backend/services/trackMatching/index.js";

resetMatcherAvailability();
const beetsAvailable = await isBeetsMatcherAvailable();
const skip = beetsAvailable ? false : "beets not installed for any available Python interpreter";
const btest = (name, optionsOrFn, maybeFn) => {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn || {};
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  return test(name, { ...options, skip: options.skip || skip }, fn);
};
const test_ = test;

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const GET_LUCKY = {
  artistName: "Daft Punk",
  trackName: "Get Lucky",
  albumName: "Random Access Memories",
  releaseYear: 2013,
  trackNumber: 8,
  durationMs: 248000,
};

function stubParsed(tags = {}, durationSec = 248, format = {}) {
  return {
    common: {
      title: tags.title ?? null,
      artist: tags.artist ?? null,
      artists: tags.artists,
      album: tags.album ?? null,
      year: tags.year,
      track: { no: tags.track },
      disc: { no: tags.disc },
      musicbrainz_recordingid: tags.mbid,
      format: tags.format,
    },
    format: {
      duration: durationSec,
      lossless: format.lossless ?? true,
      sampleRate: format.sampleRate ?? 44100,
      bitsPerSample: format.bitsPerSample ?? 16,
      bitrate: format.bitrate ?? 900000,
      container: format.container,
      codec: format.codec,
    },
  };
}

function stubParseFile(parsed) {
  return async () => parsed;
}

btest("strong original tags and matching duration verify", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(
        stubParsed({ title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", track: 8 }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.valid, true);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.parsedTags.title, "Get Lucky");
  assert.equal(outcome.beets.recommendation, "strong");
});

test("karaoke tags are auto-rejected, never routed to review", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky (Karaoke Version).mp3",
    source: "ytdlp",
    options: {
      parseFile: stubParseFile(
        stubParsed(
          { title: "Get Lucky (Karaoke Version)", artist: "Daft Punk" },
          248,
          { lossless: false, bitrate: 128000, container: "MPEG", codec: "MPEG 1 Layer 3" },
        ),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.blocked, false);
  assert.ok(outcome.contradictions.includes("karaoke"));
});

test("conflicting embedded recording MBID is a hard conflict", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, recordingMbid: "rec-requested" },
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(
        stubParsed({
          title: "Get Lucky",
          artist: "Daft Punk",
          mbid: "rec-different",
        }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(outcome.contradictions.includes("recording-mbid-conflict"));
});

btest("matching embedded recording MBID verifies even with odd tags", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, recordingMbid: "rec-known" },
    filePath: "/staging/daft_punk_gl.mp3",
    source: "soulseek",
    options: {
      parseFile: stubParseFile(
        stubParsed(
          { title: "Get Lucky 2013", artist: "Daft Punk", mbid: "rec-known" },
          248,
          { lossless: false, bitrate: 128000, container: "MPEG", codec: "MPEG 1 Layer 3" },
        ),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
});

btest("strong tags with a conflicting duration are held for review, not silently accepted", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(
        stubParsed({ title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" }, 610),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /duration mismatch/);
});

btest("strict mode refuses the relaxed duration window for verify-tier candidates", async () => {
  const parsed = stubParsed({ title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" }, 330);
  const relaxed = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(parsed), strict: false },
  });
  assert.equal(relaxed.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);

  const strict = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(parsed), strict: true },
  });
  assert.equal(strict.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
});

test("weak identity tags are conflicted regardless of duration", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/unknown rip.mp3",
    source: "soulseek",
    options: {
      parseFile: stubParseFile(
        stubParsed(
          { title: "Track 8", artist: "Unknown Artist" },
          248,
          { lossless: false, bitrate: 128000, container: "MPEG", codec: "MPEG 1 Layer 3" },
        ),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("unreadable files fail", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/corrupt.flac",
    source: "deemix",
    options: {
      parseFile: async () => {
        throw new Error("EACCES");
      },
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.FAILED);
  assert.equal(outcome.valid, false);
});

test("matcher unavailability is a controlled conflict with the diagnostic, never an accept", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(stubParsed({ title: "Get Lucky", artist: "Daft Punk" })),
      pythonPath: "/nonexistent/python-binary",
      timeoutMs: 2000,
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.valid, false);
  assert.match(outcome.reason, /matcher.*unavailable/i);
});

test("validation reads original tags before any metadata repair happens", async () => {
  // The parse spy returns the file's ORIGINAL tags. If a validator ever saw
  // the rewritten (expected) metadata, this result would flip to VERIFIED.
  const originalTags = stubParsed({
    title: "Get Lucky (Karaoke Version)",
    artist: "Daft Punk",
  });
  let parseCalls = 0;
  const spyParse = async () => {
    parseCalls += 1;
    return originalTags;
  };
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/download-then-validate.flac",
    source: "deemix",
    options: { parseFile: spyParse },
  });
  assert.equal(parseCalls, 1, "validation must inspect the file itself");
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.parsedTags.title, "Get Lucky (Karaoke Version)");
  assert.notEqual(
    outcome.parsedTags.title,
    GET_LUCKY.trackName,
    "evidence must be the file's original tag, not the value Aurral is about to write",
  );
});

const ffmpegFixtureDir = hasFfmpeg
  ? mkdtempSync(join(tmpdir(), "aurral-postdownload-"))
  : null;

function generateTaggedAudio(fileName, { title, artist, durationSec = 4 }) {
  const filePath = join(ffmpegFixtureDir, fileName);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=44100:cl=stereo`,
      "-t",
      String(durationSec),
      "-metadata",
      `title=${title}`,
      "-metadata",
      `artist=${artist}`,
      "-b:a",
      "128k",
      filePath,
    ],
    { stdio: "ignore" },
  );
  return filePath;
}

btest("real tagged audio: correct recording verifies end to end", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const filePath = generateTaggedAudio("good.mp3", {
    title: "Get Lucky",
    artist: "Daft Punk",
  });
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, durationMs: 4000 },
    filePath,
    source: "deemix",
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.actualDurationMs > 3000, true);
  assert.deepEqual(outcome.parsedTags.artists, ["Daft Punk"]);
});

test("real tagged audio: karaoke tags conflict before any metadata write", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const filePath = generateTaggedAudio("karaoke.mp3", {
    title: "Get Lucky (Karaoke Version)",
    artist: "Daft Punk",
  });
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, durationMs: 4000 },
    filePath,
    source: "deemix",
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(outcome.contradictions.includes("karaoke"));
  assert.equal(outcome.parsedTags.title, "Get Lucky (Karaoke Version)");
});

test("real audio without tags falls back to secondary evidence and stays conflicted", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const filePath = generateTaggedAudio("untagged.mp3", { title: "", artist: "" });
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, durationMs: 4000 },
    filePath,
    source: "soulseek",
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

btest("release selection: the file assigned to the requested track is the verified one", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const files = [
    generateTaggedAudio("01 - Give Life Back to Music.mp3", {
      title: "Give Life Back to Music",
      artist: "Daft Punk",
    }),
    generateTaggedAudio("02 - The Game of Love.mp3", {
      title: "The Game of Love",
      artist: "Daft Punk",
    }),
    generateTaggedAudio("03 - Get Lucky.mp3", { title: "Get Lucky", artist: "Daft Punk" }),
  ];
  const selection = await selectVerifiedDownloadedFile({
    request: {
      ...GET_LUCKY,
      durationMs: 4000,
      albumTrackTitles: ["Give Life Back to Music", "The Game of Love", "Get Lucky"],
      albumTrackCount: 3,
    },
    filePaths: files,
    source: "usenet",
  });
  assert.match(selection.filePath, /03 - Get Lucky\.mp3$/);
  assert.equal(selection.validation.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
});

test("release selection without a usable file reports no path", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const filePath = generateTaggedAudio("wrong - Other Artist.mp3", {
    title: "Something Else Completely",
    artist: "Other Artist",
  });
  const selection = await selectVerifiedDownloadedFile({
    request: { ...GET_LUCKY, durationMs: 4000 },
    filePaths: [filePath],
    source: "usenet",
  });
  // Conflicted files are never handed back as import candidates.
  assert.equal(selection.filePath, null);
  assert.equal(selection.validation.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.match(selection.validation.reason, /does not match/i);
});

test("release selection preserves matcher diagnostics when no file is usable", async () => {
  const selection = await selectVerifiedDownloadedFile({
    request: GET_LUCKY,
    filePaths: ["/staging/Get Lucky.flac"],
    source: "deemix",
    options: {
      parseFile: stubParseFile(stubParsed({ title: "Get Lucky", artist: "Daft Punk" })),
      pythonPath: "/nonexistent/python-binary",
    },
  });
  assert.equal(selection.filePath, null);
  assert.equal(selection.validation.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(selection.validation.error.code, "python_unavailable");
});

test("release selection with an unreadable file set returns nothing usable", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const selection = await selectVerifiedDownloadedFile({
    request: { ...GET_LUCKY, durationMs: 4000 },
    filePaths: [join(ffmpegFixtureDir, "missing-file.mp3")],
    source: "usenet",
  });
  assert.equal(selection.filePath, null);
  assert.equal(selection.validation, null);
});

test("cleanup removes the ffmpeg fixture directory", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, () => {
  rmSync(ffmpegFixtureDir, { recursive: true, force: true });
});
