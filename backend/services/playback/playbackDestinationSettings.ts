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

const isDestinationKey = (key: string): key is keyof typeof factories =>
  Object.hasOwn(factories, key);

type DestinationConfig = Parameters<NavidromePlaybackDestination["updateConfig"]>[0] &
  Parameters<PlexPlaybackDestination["updateConfig"]>[0] &
  Parameters<JellyfinPlaybackDestination["updateConfig"]>[0];

export async function testPlaybackDestination(key: string, config: DestinationConfig) {
  if (!isDestinationKey(key)) throw new Error(`Unknown playback destination: ${key}`);
  const destination = factories[key]();
  destination.updateConfig(config);
  return destination.testConnection();
}
