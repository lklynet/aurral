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

  const secondDisc = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, trackNumber: 2, albumTrackTitles: ["Other Song", "Get Lucky"] },
    filePath: "/staging/Get Lucky.flac",
    source: "soulseek",
    options: { parseFile: stubParseFile(stubParsed({
      title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", track: 1, disc: 2,
    })) },
  });
  assert.equal(secondDisc.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
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
    request: { ...GET_LUCKY, recordingMbid: "861f126e-c469-4513-8f7e-9f2d74e7cf36" },
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(
        stubParsed({
          title: "Get Lucky",
          artist: "Daft Punk",
          mbid: "9ee3918a-06c2-47f1-887f-c4adebe929c9",
        }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(outcome.contradictions.includes("recording-mbid-conflict"));
});

test("trackMbid from a resolved download request is checked as recording identity", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, trackMbid: "861f126e-c469-4513-8f7e-9f2d74e7cf36" },
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: {
      parseFile: stubParseFile(
        stubParsed({
          title: "Get Lucky",
          artist: "Daft Punk",
          mbid: "9ee3918a-06c2-47f1-887f-c4adebe929c9",
        }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.ok(outcome.contradictions.includes("recording-mbid-conflict"));
});

btest("matching embedded recording MBID verifies even with odd tags", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { ...GET_LUCKY, recordingMbid: "1a12c321-71cf-4451-8be7-fd68837b1aeb" },
    filePath: "/staging/daft_punk_gl.mp3",
    source: "soulseek",
    options: {
      parseFile: stubParseFile(
        stubParsed(
          { title: "Get Lucky 2013", artist: "Daft Punk", mbid: "1a12c321-71cf-4451-8be7-fd68837b1aeb" },
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

btest("an exact title and artist allow another edition's length, a partial title does not", async () => {
  const validate = (tags, durationSec, strict) => validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/Get Lucky.flac",
    source: "deemix",
    options: { parseFile: stubParseFile(stubParsed(tags, durationSec)), strict },
  });
  const strongTags = { title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" };
  const partialTitle = { title: "Get Luck", artist: "Daft Punk" };
  const artistOnly = { artist: "Daft Punk", album: "Random Access Memories" };

  assert.equal((await validate(strongTags, 254.2, true)).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  const otherRecording = await validate(strongTags, 258.5, true);
  assert.equal(otherRecording.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(otherRecording.reason, "downloaded file is 10.5s longer than the requested track");

  assert.equal((await validate(partialTitle, 249.5, true)).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  const partialBeyondWindow = await validate(partialTitle, 250.5, true);
  assert.equal(partialBeyondWindow.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(partialBeyondWindow.reason, "downloaded file is 2.5s longer than the requested track");

  assert.equal((await validate(artistOnly, 249.5, false)).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  const filenameTitle = await validate(artistOnly, 249.5, true);
  assert.equal(filenameTitle.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(filenameTitle.reason, "downloaded file is 1.5s longer than the requested track");
});

test("a YouTube file gets another edition's length only as the artist's own audio upload", async () => {
  const validate = (rawTitle, channel) => validateDownloadedTrackFile({
    request: GET_LUCKY,
    candidate: { provider: { id: "abc123DEF45", uploader: channel }, raw: { title: rawTitle, channel } },
    filePath: "/staging/abc123DEF45.m4a",
    source: "ytdlp",
    options: {
      strict: true,
      parseFile: stubParseFile(stubParsed(
        { title: "Get Lucky", artist: "Daft Punk" },
        252,
        { lossless: false, bitrate: 128000, container: "MPEG-4", codec: "AAC" },
      )),
    },
  });
  assert.equal((await validate("Get Lucky", "Daft Punk - Topic")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate("Daft Punk - Get Lucky (Audio)", "DaftPunkVEVO")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate("Daft Punk - Get Lucky (Official Lyric Video)", "Daft Punk")).decision,
    POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate("Daft Punk - Get Lucky (Official Music Video)", "Daft Punk")).decision,
    POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal((await validate("Daft Punk - Get Lucky (Lyrics)", "Lyrics Channel")).decision,
    POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
});

test("a YouTube title with extra uploader words goes to review instead of importing", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: { artistName: "Taylor Swift", trackName: "I Know Places (Taylor’s Version)", durationMs: 195000 },
    candidate: { provider: { id: "abc123DEF45", uploader: "Fan Edits" } },
    filePath: "/staging/abc123DEF45.m4a",
    source: "ytdlp",
    options: {
      parseFile: stubParseFile(stubParsed(
        { title: "I Know Places (Taylor's Version Concept)", artist: "Taylor Swift" },
        195,
        { lossless: false, bitrate: 128000, container: "MPEG-4", codec: "AAC" },
      )),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.reason, "downloaded file has a title that only partly matches the requested track");
});

test("a YouTube file's artist comes from the video title when yt-dlp tagged the uploader", async () => {
  const validate = (request, { videoTitle, channel, tags }) => validateDownloadedTrackFile({
    request,
    candidate: { provider: { id: "abc123DEF45", uploader: channel }, raw: { title: videoTitle, channel } },
    filePath: "/staging/abc123DEF45.m4a",
    source: "ytdlp",
    options: {
      parseFile: stubParseFile(stubParsed(tags, request.durationMs / 1000,
        { lossless: false, bitrate: 128000, container: "MPEG-4", codec: "AAC" })),
    },
  });
  const quoted = await validate({ artistName: "YOASOBI", trackName: "群青", durationMs: 249000 }, {
    videoTitle: "YOASOBI「群青」(Gunjou) Lyrics", channel: "Lyric Fan",
    tags: { title: "YOASOBI「群青」(Gunjou) Lyrics", artist: "Lyric Fan" },
  });
  assert.equal(quoted.decision, POST_DOWNLOAD_DECISIONS.VERIFIED, quoted.reason);
  const reversed = await validate({ artistName: "Nirvana", trackName: "Come as You Are", durationMs: 219000 }, {
    videoTitle: "Come as You Are - Nirvana", channel: "RockSongs",
    tags: { title: "Nirvana", artist: "Come as You Are" },
  });
  assert.equal(reversed.decision, POST_DOWNLOAD_DECISIONS.VERIFIED, reversed.reason);
  const relabeled = await validate({ artistName: "Nirvana", trackName: "Breed", durationMs: 184000 }, {
    videoTitle: "Nirvana - Breed (Lyrics)", channel: "Lyric Fan",
    tags: { title: "Polly", artist: "Nirvana" },
  });
  assert.notEqual(relabeled.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  const creditedCover = await validate({ artistName: "AC/DC", trackName: "Let Me Put My Love Into You", durationMs: 256000 }, {
    videoTitle: "Six Feet Under - Let Me Put My Love Into You - AC/DC", channel: "Metal Uploads",
    tags: { title: "Let Me Put My Love Into You - AC/DC", artist: "Six Feet Under" },
  });
  assert.equal(creditedCover.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("a recording ID tag only counts as a MusicBrainz ID, including one merged into the requested recording", async () => {
  const requested = "0cf9f95f-70e7-4f2e-8075-5d8ba38dd4a3";
  const merged = "b4f0642e-05c5-4bc4-bf0c-95e67bfb3e99";
  const validate = (mbid, request = {}) => validateDownloadedTrackFile({
    request: { artistName: "Nirvana", trackName: "Breed", durationMs: 183933, recordingMbid: requested, ...request },
    filePath: "/staging/04 Breed.flac",
    source: "soulseek",
    options: { parseFile: stubParseFile(stubParsed({ title: "Breed", artist: "Nirvana", mbid }, 184)) },
  });
  assert.equal((await validate("30HCB1FoE77IfGRyNv4eFq")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate(merged)).decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal((await validate(merged, { recordingMbidAliases: [merged] })).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
});

test("a file name that puts the artist and album before the title is read by its title", async () => {
  const validate = (fileName) => validateDownloadedTrackFile({
    request: { artistName: "Nirvana", trackName: "Drain You", durationMs: 223733 },
    filePath: `/staging/${fileName}`,
    source: "soulseek",
    options: { parseFile: stubParseFile(stubParsed({ title: "Drain You", artist: "Nirvana" }, 224)) },
  });
  assert.equal((await validate("Nirvana [Nevermind] 08 - Drain You.flac")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal((await validate("Nirvana [Nevermind] 05 - Lithium.flac")).decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("each artist in a multi-artist credit is artist evidence, with or without a leading The", async () => {
  const validate = (artist, source) => validateDownloadedTrackFile({
    request: { artistName: "Kendrick Lamar", trackName: "Poetic Justice", durationMs: 300000 },
    candidate: { provider: { id: "abc123DEF45", uploader: "Kendrick Lamar" }, raw: { title: "Poetic Justice" } },
    filePath: "/staging/abc123DEF45.m4a",
    source,
    options: {
      parseFile: stubParseFile(stubParsed(
        { title: "Poetic Justice", artist },
        300,
        { lossless: false, bitrate: 256000, container: "MPEG-4", codec: "AAC" },
      )),
    },
  });
  for (const credit of ["Kendrick Lamar, Drake", "Drake & Kendrick Lamar", "Kendrick Lamar (ft. Drake)", "The Kendrick Lamar"]) {
    assert.equal((await validate(credit, "ytdlp")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED, credit);
    assert.equal((await validate(credit, "soulseek")).decision, POST_DOWNLOAD_DECISIONS.VERIFIED, credit);
  }
  assert.equal((await validate("Drake, Rick Ross", "soulseek")).decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
});

test("review reasons name every missing piece of recording evidence", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: GET_LUCKY,
    filePath: "/staging/abc123.mp3",
    source: "ytdlp",
    options: {
      parseFile: stubParseFile(stubParsed(
        { title: "Get Lucky", artist: "Daft Punk Tribute" },
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
    request: { ...GET_LUCKY, recordingMbid: "aa8bf4d6-ee95-4407-8f7b-2efb65240a23" },
    filePaths: ["/staging/Get Lucky.flac"],
    source: "deemix",
    options: {
      parseFile: stubParseFile(stubParsed({ title: "Get Lucky", artist: "Daft Punk", mbid: "a4b48a81-cdab-4e1a-8dd3-7907d6c85ca1" })),
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
