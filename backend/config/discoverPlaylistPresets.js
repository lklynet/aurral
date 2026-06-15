export const DISCOVER_PLAYLIST_PRESETS = [
  {
    id: "discover-weekly",
    name: "Discover Weekly",
    description: "Fresh picks from your recommendation profile",
    mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
    size: 30,
    deepDive: false,
  },
  {
    id: "trending-mix",
    name: "Trending Mix",
    description: "Tracks from globally trending artists",
    mix: { discover: 0, mix: 0, trending: 100, focus: 0 },
    size: 30,
    deepDive: false,
  },
  {
    id: "library-blend",
    name: "Library Blend",
    description: "Tracks from artists in your library",
    mix: { discover: 0, mix: 100, trending: 0, focus: 0 },
    size: 30,
    deepDive: false,
  },
];

export const BASE_DISCOVER_FLOW_COUNT = DISCOVER_PLAYLIST_PRESETS.length + 2;
export const DISCOVERY_FLOWS_DEFAULT = 9;
export const DISCOVERY_FLOWS_MAX = 32;

export const FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS = {
  "discover-weekly": "#4363d8",
  "trending-mix": "#f032e6",
  "library-blend": "#3cb44b",
  "focus-listening-history": "#f58231",
  "release-radar": "#e6194B",
};

export const isFixedDiscoverPlaylistPreset = (presetId) =>
  Object.prototype.hasOwnProperty.call(
    FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS,
    String(presetId || "").trim(),
  );

export const RELEASE_RADAR_PRESET = {
  id: "release-radar",
  name: "Release Radar",
  description: "Up to one track from each recent album missing in your library",
  mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
  size: 30,
  deepDive: false,
};

export const getDiscoverPlaylistPreset = (presetId) => {
  const id = String(presetId || "").trim();
  if (!id) return null;
  if (id === RELEASE_RADAR_PRESET.id) return { ...RELEASE_RADAR_PRESET };
  return DISCOVER_PLAYLIST_PRESETS.find((preset) => preset.id === id) || null;
};
