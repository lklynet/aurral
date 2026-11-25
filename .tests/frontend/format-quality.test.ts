import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatQuality } from "../../lib/formatQuality.ts";

test("a lossless file reads as codec, depth, and sample rate", () => {
  assert.equal(
    formatQuality({
      format: "flac",
      bitrate: null,
      sampleRate: 96000,
      bitsPerSample: 24,
    }),
    "FLAC 24 bit · 96 kHz",
  );
});

test("a lossy file leads with its bitrate", () => {
  assert.equal(
    formatQuality({
      format: "mp3",
      bitrate: 320000,
      sampleRate: 44100,
      bitsPerSample: 16,
    }),
    "MP3 320 kbps · 44.1 kHz",
  );
});

test("missing parts are dropped rather than printed as zero or NaN", () => {
  assert.equal(formatQuality({ format: "mp3", bitrate: 192000 }), "MP3 192 kbps");
  assert.equal(formatQuality({ format: null, sampleRate: 48000 }), "48 kHz");
  assert.equal(
    formatQuality({ format: null, bitrate: null, sampleRate: null, bitsPerSample: null }),
    "",
  );
  assert.equal(formatQuality(null), "");
  assert.equal(formatQuality(undefined), "");
});

test("a codec name with no detail is still worth printing", () => {
  assert.equal(formatQuality({ format: "flac" }), "FLAC");
  assert.equal(
    formatQuality({ format: "flac", bitrate: 900000, sampleRate: 44100, bitsPerSample: 16 }),
    "FLAC 16 bit · 44.1 kHz",
  );
});

test("the scanner's codec names read as the format people know", () => {
  assert.equal(
    formatQuality({ format: "MPEG 1 Layer 3", bitrate: 320000, sampleRate: 44100 }),
    "MP3 320 kbps · 44.1 kHz",
  );
  assert.equal(
    formatQuality({ format: "Opus", bitrate: 136220, sampleRate: 48000 }),
    "Opus 136 kbps · 48 kHz",
  );
  assert.equal(
    formatQuality({ format: "MPEG-4/AAC", bitrate: 256000, sampleRate: 44100 }),
    "AAC 256 kbps · 44.1 kHz",
  );
  assert.equal(
    formatQuality({ format: "Vorbis I", bitrate: 192000, sampleRate: 44100 }),
    "OGG 192 kbps · 44.1 kHz",
  );
  assert.equal(
    formatQuality({ format: "MPEG 2.5 Layer 3", bitrate: 64000, sampleRate: 22050 }),
    "MP3 64 kbps · 22.1 kHz",
  );
});

test("a lossless bitrate is left out, because per-file it says nothing about the format", () => {
  assert.equal(
    formatQuality({
      format: "FLAC",
      bitrate: 891545,
      sampleRate: 44100,
      bitsPerSample: 16,
    }),
    "FLAC 16 bit · 44.1 kHz",
  );
  assert.equal(
    formatQuality({ format: "ALAC", bitrate: 1000000, sampleRate: 48000, bitsPerSample: 24 }),
    "ALAC 24 bit · 48 kHz",
  );
  assert.equal(
    formatQuality({ format: "PCM", bitrate: 1411200, sampleRate: 44100, bitsPerSample: 16 }),
    "PCM 16 bit · 44.1 kHz",
  );
});

test("a file stored in the older Lidarr shape keeps its lossless detail", () => {
  assert.equal(
    formatQuality({
      format: null,
      audioFormat: "FLAC",
      bitrate: 900000,
      bitsPerSample: 24,
      sampleRate: 96000,
    }),
    "FLAC 24 bit · 96 kHz",
  );
  assert.equal(
    formatQuality({ quality: { name: "MP3-320" }, bitrate: 320000 }),
    "MP3-320 320 kbps",
  );
});

test("a queue entry with only a format name reads cleanly", () => {
  assert.equal(formatQuality("MPEG 1 Layer 3"), "MP3");
  assert.equal(formatQuality("FLAC"), "FLAC");
  assert.equal(formatQuality("FLAC 24bit"), "FLAC 24bit");
});

test("an absent value prints nothing", () => {
  assert.equal(formatQuality(null), "");
  assert.equal(formatQuality(""), "");
  assert.equal(formatQuality(undefined), "");
});
