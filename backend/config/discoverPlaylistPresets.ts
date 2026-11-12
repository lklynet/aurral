import type { PlaylistCoverTemplate } from "../services/playlistCoverTemplates.ts";

export const LISTENING_HISTORY_PRESET_ID = "focus-listening-history";
export const RELEASE_RADAR_PRESET_ID = "release-radar";

export const DISCOVER_PLAYLIST_PRESETS = [
  {
    id: "discover-weekly",
    cover: "a1",
    name: "Discover Weekly",
    description: "Fresh picks from your recommendation profile",
    mix: { discover: 100 },
    size: 20,
  },
  {
    id: "trending-mix",
    cover: "b1",
    name: "Trending Mix",
    description: "Tracks from globally trending artists",
    mix: { trending: 100 },
    size: 20,
  },
  {
    id: "library-blend",
    cover: "a4",
    name: "Library Blend",
    description: "Tracks from artists in your Library",
    mix: { mix: 100 },
    size: 20,
  },
  {
    id: LISTENING_HISTORY_PRESET_ID,
    cover: "a2",
    name: "Listening History",
    description: "Tracks based on what you've recently been listening to",
    mix: { focus: 100 },
    size: 20,
  },
  {
    id: RELEASE_RADAR_PRESET_ID,
    cover: "b4",
    name: "Release Radar",
    description: "Up to one track from each recent album missing in your Library",
    mix: { newReleases: 100 },
    size: 20,
  },
] satisfies ({ cover: PlaylistCoverTemplate } & Record<string, unknown>)[];

export const getDiscoverPlaylistPreset = (presetId: string) => {
  const id = String(presetId || "").trim();
  return DISCOVER_PLAYLIST_PRESETS.find((preset) => preset.id === id) || null;
};
