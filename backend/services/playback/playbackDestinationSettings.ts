import { navidromeSettings, NavidromePlaybackDestination } from "./navidromePlaybackDestination.ts";
import { plexSettings, PlexPlaybackDestination } from "./plexPlaybackDestination.ts";
import { jellyfinSettings, JellyfinPlaybackDestination } from "./jellyfinPlaybackDestination.ts";

const definitions = Object.freeze({
  navidrome: navidromeSettings,
  plex: plexSettings,
  jellyfin: jellyfinSettings,
});

const factories = {
  navidrome: () => new NavidromePlaybackDestination(),
  plex: () => new PlexPlaybackDestination(),
  jellyfin: () => new JellyfinPlaybackDestination(),
};

export function getPlaybackDestinationSettings() {
  return structuredClone(definitions);
}

export async function testPlaybackDestination(key: string, config: unknown) {
  const destination = factories[key]?.();
  if (!destination) throw new Error(`Unknown playback destination: ${key}`);
  destination.updateConfig(config);
  return destination.testConnection();
}
