import { navidromeSettings, NavidromePlaybackDestination } from "./navidromePlaybackDestination.js";
import { plexSettings, PlexPlaybackDestination } from "./plexPlaybackDestination.js";
import { jellyfinSettings, JellyfinPlaybackDestination } from "./jellyfinPlaybackDestination.js";

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

export async function testPlaybackDestination(key, config) {
  const destination = factories[key]?.();
  if (!destination) throw new Error(`Unknown playback destination: ${key}`);
  destination.updateConfig(config);
  return destination.testConnection();
}
