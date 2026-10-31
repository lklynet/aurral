export const LISTENING_HISTORY_PRESET_ID = "focus-listening-history";
export const RELEASE_RADAR_PRESET_ID = "release-radar";

export const DISCOVER_PLAYLIST_PRESETS = [
  {
    id: "discover-weekly",
    name: "Discover Weekly",
    description: "Fresh picks from your recommendation profile",
    mix: { discover: 100 },
    size: 20,
  },
  {
    id: "trending-mix",
    name: "Trending Mix",
    description: "Tracks from globally trending artists",
    mix: { trending: 100 },
    size: 20,
  },
  {
    id: "library-blend",
    name: "Library Blend",
    description: "Tracks from artists in your library",
    mix: { mix: 100 },
    size: 20,
  },
  {
    id: LISTENING_HISTORY_PRESET_ID,
    name: "Listening History",
    description: "Tracks based on what you've recently been listening to",
    mix: { focus: 100 },
    size: 20,
  },
  {
    id: RELEASE_RADAR_PRESET_ID,
    name: "Release Radar",
    description: "Up to one track from each recent album missing in your library",
    mix: { newReleases: 100 },
    size: 20,
  },
];

export const getDiscoverPlaylistPreset = (presetId: string) => {
  const id = String(presetId || "").trim();
  return DISCOVER_PLAYLIST_PRESETS.find((preset) => preset.id === id) || null;
};
