import type { LibraryTrackFile } from "../../../backend/services/libraryQueryService.ts";

export type FileQuality = NonNullable<LibraryTrackFile["quality"]>;

const CODEC_LABELS: Record<string, string> = {
  "mpeg 1 layer 3": "MP3",
  "mpeg 2 layer 3": "MP3",
  "mpeg 2.5 layer 3": "MP3",
  "mpeg 1 layer 2": "MP2",
  mpeg: "MP3",
  mp3: "MP3",
  "mpeg-4/aac": "AAC",
  m4a: "AAC",
  mp4: "AAC",
  aac: "AAC",
  ogg: "OGG",
  oga: "OGG",
  vorbis: "OGG",
  "vorbis i": "OGG",
  flac: "FLAC",
  alac: "ALAC",
  opus: "Opus",
  wav: "WAV",
  pcm: "PCM",
  ieee_float: "PCM",
  aiff: "AIFF",
  ape: "APE",
  "monkey's audio": "APE",
  wavpack: "WavPack",
};

const LOSSY_LABELS = new Set(["MP3", "MP2", "AAC", "OGG", "Opus"]);

const codecLabel = (format: string | null | undefined) => {
  const value = format?.trim();
  return value ? (CODEC_LABELS[value.toLowerCase()] ?? value) : "";
};

const positive = (value: number | null | undefined) => (value && value > 0 ? value : null);

export function formatQuality(quality: FileQuality | null | undefined) {
  if (!quality) return "";
  const codec =
    codecLabel(quality.format) ||
    codecLabel(quality.audioFormat) ||
    codecLabel(quality.quality?.name);
  const bitrate = positive(quality.bitrate);
  const sampleRate = positive(quality.sampleRate);
  const bitsPerSample = positive(quality.bitsPerSample);
  const parts = [
    bitsPerSample && !LOSSY_LABELS.has(codec)
      ? `${Math.round(bitsPerSample)} bit`
      : bitrate && `${Math.round(bitrate / 1000)} kbps`,
    sampleRate && `${Math.round(sampleRate) / 1000} kHz`,
  ].filter(Boolean);
  if (codec && parts.length) return `${codec} ${parts.join(" · ")}`;
  return codec || parts.join(" · ");
}
