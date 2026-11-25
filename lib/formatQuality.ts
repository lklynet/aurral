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
  aiff: "AIFF",
  ape: "APE",
  wavpack: "WavPack",
};

const LOSSLESS_LABELS = new Set(["FLAC", "ALAC", "WAV", "PCM", "AIFF", "APE", "WavPack"]);

const codecLabel = (format: unknown) => {
  const value = typeof format === "string" ? format.trim() : "";
  if (!value) return "";
  return CODEC_LABELS[value.toLowerCase()] ?? value;
};

const positive = (input: unknown) => {
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const field = (record: object, key: string): unknown =>
  key in record ? (record as Record<string, unknown>)[key] : undefined;

// Library files store either the scanner's shape (format, bitrate, sampleRate,
// bitsPerSample) or the older Lidarr shape, which names the format in
// audioFormat or quality.name instead.
const formatOf = (quality: object) => {
  const nested = field(quality, "quality");
  return (
    codecLabel(field(quality, "format")) ||
    codecLabel(field(quality, "audioFormat")) ||
    (nested && typeof nested === "object" ? codecLabel(field(nested, "name")) : "")
  );
};

export function formatQuality(quality: unknown) {
  if (typeof quality === "string") return codecLabel(quality);
  if (!quality || typeof quality !== "object") return "";
  const codec = formatOf(quality);
  const bitrate = positive(field(quality, "bitrate"));
  const sampleRate = positive(field(quality, "sampleRate"));
  const bitsPerSample = positive(field(quality, "bitsPerSample"));
  const parts = [
    LOSSLESS_LABELS.has(codec)
      ? bitsPerSample && `${Math.round(bitsPerSample)} bit`
      : bitrate && `${Math.round(bitrate / 1000)} kbps`,
    sampleRate && `${Math.round(sampleRate / 100) / 10} kHz`,
  ].filter(Boolean);
  if (codec && parts.length) return `${codec} ${parts.join(" · ")}`;
  return codec || parts.join(" · ");
}
