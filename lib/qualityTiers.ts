export const QUALITY_TIERS = [
  { id: "flac-hires", label: "FLAC hi-res", family: "flac" },
  { id: "flac-standard", label: "FLAC standard", family: "flac" },
  { id: "mp3-320", label: "MP3 320", family: "mp3", bitrate: 320 },
  { id: "m4a-320", label: "AAC 320", family: "m4a", bitrate: 320 },
  { id: "mp3-256", label: "MP3 256", family: "mp3", bitrate: 256 },
  { id: "m4a-256", label: "AAC 256", family: "m4a", bitrate: 256 },
  { id: "mp3-192", label: "MP3 192", family: "mp3", bitrate: 192 },
  { id: "m4a-192", label: "AAC 192", family: "m4a", bitrate: 192 },
  { id: "mp3-128", label: "MP3 128", family: "mp3", bitrate: 128 },
  { id: "m4a-128", label: "AAC 128", family: "m4a", bitrate: 128 },
];

const tierIds = QUALITY_TIERS.map((tier) => tier.id);

export const QUALITY_PRESETS = {
  lossless: { order: tierIds, enabled: tierIds, cutoff: "flac-standard" },
  smaller: {
    order: [
      ...QUALITY_TIERS.filter((tier) => tier.family !== "flac"),
      ...QUALITY_TIERS.filter((tier) => tier.family === "flac"),
    ].map((tier) => tier.id),
    enabled: tierIds,
    cutoff: "mp3-320",
  },
};

export type QualityPreset = keyof typeof QUALITY_PRESETS;

const QUALITY_PRESET_IDS: QualityPreset[] = ["lossless", "smaller"];

type TierSelection = { order: string[]; enabled: string[]; cutoff: string };

const sameIds = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const qualityPresetOf = (profile: TierSelection) =>
  QUALITY_PRESET_IDS.find((id) => {
    const preset = QUALITY_PRESETS[id];
    return (
      preset.cutoff === profile.cutoff &&
      sameIds(preset.order, profile.order) &&
      sameIds(
        preset.order.filter((tier) => preset.enabled.includes(tier)),
        profile.order.filter((tier) => profile.enabled.includes(tier)),
      )
    );
  }) ?? null;
