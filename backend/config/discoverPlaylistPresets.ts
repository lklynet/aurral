export const DISCOVER_PLAYLIST_PRESETS = [
  {
    id: "discover-weekly",
    name: "Discover Weekly",
    description: "Fresh picks from your recommendation profile",
    mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
    size: 20,
    deepDive: false,
  },
  {
    id: "trending-mix",
    name: "Trending Mix",
    description: "Tracks from globally trending artists",
    mix: { discover: 0, mix: 0, trending: 100, focus: 0 },
    size: 20,
    deepDive: false,
  },
  {
    id: "library-blend",
    name: "Library Blend",
    description: "Tracks from artists in your library",
    mix: { discover: 0, mix: 100, trending: 0, focus: 0 },
    size: 20,
    deepDive: false,
  },
  {
    id: "focus-listening-history",
    name: "Listening History",
    description: "Tracks based on what you've recently been listening to",
    mix: { discover: 0, mix: 0, trending: 0, focus: 100 },
    size: 20,
    deepDive: false,
    tags: [],
    relatedArtists: [],
  },
];

export const FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS = {
  "discover-weekly": "#e6194B",
  "trending-mix": "#3cb44b",
  "library-blend": "#ffe119",
  "focus-listening-history": "#4363d8",
  "release-radar": "#f58231",
};

export const RELEASE_RADAR_PRESET = {
  id: "release-radar",
  name: "Release Radar",
  description: "Up to one track from each recent album missing in your library",
  mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
  size: 20,
  deepDive: false,
};

export const getDiscoverPlaylistPreset = (presetId) => {
  const id = String(presetId || "").trim();
  if (!id) return null;
  if (id === RELEASE_RADAR_PRESET.id) return { ...RELEASE_RADAR_PRESET };
  return DISCOVER_PLAYLIST_PRESETS.find((preset) => preset.id === id) || null;
};
