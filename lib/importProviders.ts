import { isOwnKey } from "./ownKey.ts";

export const IMPORT_PROVIDER_LABELS = {
  "spotify-playlist": "Spotify",
  "listenbrainz-playlist": "ListenBrainz",
  "listenbrainz-createdfor": "ListenBrainz",
  "lastfm-station": "Last.fm",
  "youtube-music-playlist": "YouTube Music",
  "deezer-playlist": "Deezer",
  "aurral-share": "Aurral share",
} as const;

export type NativeImportProvider = keyof typeof IMPORT_PROVIDER_LABELS;

export const PLUGIN_IMPORT_PREFIX = "plugin:";

export const isNativeImportProvider = (provider: unknown): provider is NativeImportProvider =>
  typeof provider === "string" && isOwnKey(IMPORT_PROVIDER_LABELS, provider);

export const isImportProvider = (provider: string) =>
  isNativeImportProvider(provider) || provider.startsWith(PLUGIN_IMPORT_PREFIX);
