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
  POST_DOWNLOAD_DECISIONS,
} from "../../backend/services/trackMatching/index.js";

const btest = test;

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

test("original non-Latin tag contradictions block import even with matching filenames", async () => {
  for (const [trackName, title] of [
    ["Мой", "Мои"], ["かみ", "がみ"], ["時", "詩"], ["愛", "哀"],
    ["Мой любимый город", "Мои любимый город"],
  ]) {
    const outcome = await validateDownloadedTrackFile({
      request: { artistName: "X", trackName, durationMs: 200000 },
      filePath: `/staging/${trackName}.flac`, source: "deemix",
      options: { parseFile: stubParseFile(stubParsed({ title, artist: "X" }, 200)) },
    });
    assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED, `${trackName}/${title}`);
    assert.equal(outcome.valid, false);
  }
});

test("a non-Latin filename contradiction blocks matching original tags", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { artistName: "X", trackName: "Мой любимый город", durationMs: 200000 },
    filePath: "/staging/01 - Мои любимый город.flac", source: "soulseek",
    options: { parseFile: stubParseFile(stubParsed({ title: "Мой любимый город", artist: "X" }, 200)) },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("downloaded version suffixes retain the original title and filename evidence", async () => {
  for (const [artistName, trackName, title, filename] of [
    ["Queen", "Bohemian Rhapsody", "Bohemian Rhapsody - Remastered 2011", "Queen - Bohemian Rhapsody - Remastered 2011.flac"],
    ["Artist Name", "Wide Awake Tonight - Radio Edit", "Wide Awake Tonight - Radio Edit", "11 - Artist Name - Wide Awake Tonight - Radio Edit.flac"],
    ["X", "がみ - Radio Edit", "か\u3099み - Radio Edit", "X - がみ - Radio Edit.flac"],
    ["Beyonce", "Halo", "Halo", "Beyoncé - Halo.flac"],
    ["Beyonce", "Halo", "Halo - Remastered 2011", "Beyoncé - Halo - Remastered 2011.flac"],
  ]) {
    const outcome = await validateDownloadedTrackFile({
      request: { artistName, trackName, durationMs: 200000 },
      filePath: `/staging/${filename}`, source: "soulseek",
      options: { parseFile: stubParseFile(stubParsed({ title, artist: artistName }, 200)) },
    });
    assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED, filename);
  }
});

test("a plain non-Latin filename cannot hide a different title behind matching tags", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { artistName: "X", trackName: "かみ", durationMs: 200000 },
    filePath: "/staging/がみ.flac", source: "soulseek",
    options: { parseFile: stubParseFile(stubParsed({ title: "かみ", artist: "X" }, 200)) },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("release selection keeps distinct non-Latin siblings separate", async () => {
  const parsed = new Map([
    ["/staging/01 कि.flac", stubParsed({ title: "कि", artist: "X", track: 1 }, 200)],
    ["/staging/02 की.flac", stubParsed({ title: "की", artist: "X", track: 2 }, 200)],
  ]);
  const outcome = await selectVerifiedDownloadedFile({
    request: { artistName: "X", trackName: "की", durationMs: 200000,
      trackNumber: 2, albumTrackTitles: ["कि", "की"] },
    filePaths: [...parsed.keys()], source: "soulseek",
    options: { parseFile: async (filePath) => parsed.get(filePath) },
  });
  assert.equal(outcome.filePath, "/staging/02 की.flac");
  assert.equal(outcome.validation.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
});

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
  assert.ok(outcome.native.evidence.includes("artist"));
  assert.ok(outcome.native.evidence.includes("duration"));
});

test("recording IDs differing only in case verify", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, recordingMbid: "A1234567-0000-4000-8000-000000000000" },
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(stubParsed({
      title: "Get Lucky", artist: "Daft Punk", mbid: "a1234567-0000-4000-8000-000000000000",
    })) },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
});

test("a downloaded file tagged as a different album sibling is conflicted", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, trackNumber: 2, albumTrackTitles: ["Other Song", "Get Lucky"] },
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(stubParsed({
      title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", track: 1,
    })) },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(outcome.contradictions.includes("sibling-track-index"));
});

test("a copy from a single or compilation verifies under its own track number", async () => {
  const request = { ...GET_LUCKY, trackNumber: 8, albumTrackTitles: [
    "Give Life Back to Music", "The Game of Love", "Giorgio by Moroder", "Within",
    "Instant Crush", "Lose Yourself to Dance", "Touch", "Get Lucky",
  ] };
  for (const [album, track] of [["Get Lucky", 1], ["Now That's What I Call Music! 85", 4]]) {
    const outcome = await validateDownloadedTrackFile({
      request,
      filePath: "/staging/Get Lucky.flac",
      source: "soulseek",
      options: { parseFile: stubParseFile(stubParsed({
        title: "Get Lucky", artist: "Daft Punk", album, track,
      })) },
    });
    assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED, album);
  }
});

test("filename variants reject a tagged original before import", async () => {
  for (const variant of ["Cover", "Nightcore"]) {
    const outcome = await validateDownloadedTrackFile({
      request: GET_LUCKY,
      filePath: `/staging/Get Lucky (${variant}).flac`,
      source: "soulseek",
      options: { parseFile: stubParseFile(stubParsed({
        title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories",
      })) },
    });
    assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED, variant);
    assert.equal(outcome.valid, false, variant);
  }
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

test("trackMbid from a resolved download request is checked as recording identity", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, trackMbid: "rec-requested" },
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

btest("strong tags with a conflicting duration require review, never automatic import", async () => {
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
  assert.ok(outcome.contradictions.includes("duration"));
  assert.equal(outcome.reason, "downloaded file is 362.0s longer than the requested track");
});

btest("strict mode keeps the tight duration window unless original tags confirm title and artist", async () => {
  const validate = (tags, durationSec, strict) => validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(stubParsed(tags, durationSec)), strict },
  });
  const strongTags = { title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" };
  const artistOnly = { artist: "Daft Punk", album: "Random Access Memories" };

  assert.equal((await validate(strongTags, 249.5, true)).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);

  const beyondWindow = await validate(strongTags, 250.5, true);
  assert.equal(beyondWindow.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(beyondWindow.reason, "downloaded file is 2.5s longer than the requested track");

  assert.equal((await validate(artistOnly, 249.5, false)).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  const filenameTitle = await validate(artistOnly, 249.5, true);
  assert.equal(filenameTitle.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(filenameTitle.reason, "downloaded file is 1.5s longer than the requested track");
});

test("review reasons name every missing piece of recording evidence", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/abc123.mp3",
    source: "ytdlp",
    options: {
      parseFile: stubParseFile(stubParsed(
        { title: "Get Lucky", artist: "DaftPunkVEVO" },
        244,
        { lossless: false, bitrate: 320000, container: "MPEG", codec: "MPEG 1 Layer 3" },
      )),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(
    outcome.reason,
    "downloaded file is 4.0s shorter than the requested track and has an artist tag that only partly matches the requested artist",
  );
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

test("native validation verifies original tags without a Python runtime", async () => {
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
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.valid, true);
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
test.after(() => {
  if (ffmpegFixtureDir) rmSync(ffmpegFixtureDir, { recursive: true, force: true });
});

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
  for (const source of ["soulseek", "ytdlp"]) {
    const outcome = await validateDownloadedTrackFile({
      request: { ...GET_LUCKY, durationMs: 4000 },
      candidate: { title: "Get Lucky", artists: ["Daft Punk"] },
      filePath,
      source,
    });
    assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED, source);
  }
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

btest("release selection without a usable file reports no path", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
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
  assert.match(selection.validation.reason, /contradicts/i);
});

test("release selection preserves identity diagnostics when no file is usable", async () => {
  const selection = await selectVerifiedDownloadedFile({
    request: { ...GET_LUCKY, recordingMbid: "wanted" },
    filePaths: ["/staging/Get Lucky.flac"],
    source: "deemix",
    options: {
      parseFile: stubParseFile(stubParsed({ title: "Get Lucky", artist: "Daft Punk", mbid: "wrong" })),
    },
  });
  assert.equal(selection.filePath, null);
  assert.equal(selection.validation.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(selection.validation.contradictions.includes("recording-mbid-conflict"));
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
