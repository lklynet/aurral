import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatQuality } from "../../frontend/src/utils/formatQuality.ts";

test("lossless files show bit depth and lossy files show bitrate", () => {
  const cases: [Parameters<typeof formatQuality>[0], string][] = [
    [
      { format: "FLAC", bitrate: 891545, sampleRate: 96000, bitsPerSample: 24 },
      "FLAC 24 bit · 96 kHz",
    ],
    [
      { format: "ALAC", bitrate: 1000000, sampleRate: 48000, bitsPerSample: 24 },
      "ALAC 24 bit · 48 kHz",
    ],
    [
      { format: "Monkey's Audio", bitrate: 900000, sampleRate: 44100, bitsPerSample: 16 },
      "APE 16 bit · 44.1 kHz",
    ],
    [
      { format: "IEEE_FLOAT", bitrate: 1411200, sampleRate: 44100, bitsPerSample: 32 },
      "PCM 32 bit · 44.1 kHz",
    ],
    [
      { format: "MPEG 1 Layer 3", bitrate: 320000, sampleRate: 44100, bitsPerSample: 16 },
      "MP3 320 kbps · 44.1 kHz",
    ],
    [{ format: "MPEG-4/AAC", bitrate: 256000, sampleRate: 44100 }, "AAC 256 kbps · 44.1 kHz"],
    [{ format: "Vorbis I", bitrate: 192000, sampleRate: 44100 }, "OGG 192 kbps · 44.1 kHz"],
    [{ format: "MPEG 2.5 Layer 3", bitrate: 64000, sampleRate: 22050 }, "MP3 64 kbps · 22.05 kHz"],
    [{ audioFormat: "FLAC", bitrate: 900000, bitsPerSample: 24 }, "FLAC 24 bit"],
    [{ quality: { name: "MP3-320" }, bitrate: 320000 }, "MP3-320 320 kbps"],
    [{ bitrate: 900000, sampleRate: 44100, bitsPerSample: 16 }, "16 bit · 44.1 kHz"],
    [{ format: "flac" }, "FLAC"],
    [{ format: null, bitrate: 0, sampleRate: null }, ""],
    [null, ""],
  ];
  for (const [quality, expected] of cases) assert.equal(formatQuality(quality), expected);
});
