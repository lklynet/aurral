import { releaseChannel } from "./release-version.ts";

export const TELEMETRY_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_TELEMETRY_BYTES = 16 * 1024;

export const COUNT_BUCKETS = [
  "0",
  "1",
  "2-9",
  "10-99",
  "100-999",
  "1k-9k",
  "10k-99k",
  "100k+",
] as const;
const BUCKET_FLOORS = [0, 1, 2, 10, 100, 1_000, 10_000, 100_000];

export type CountBucket = (typeof COUNT_BUCKETS)[number];

export function countBucket(value: number): CountBucket {
  const index = BUCKET_FLOORS.findLastIndex((floor) => value >= floor);
  return COUNT_BUCKETS[Math.max(0, index)] ?? "0";
}

export const SCALE_KEYS = [
  "users",
  "admins",
  "artists",
  "albums",
  "tracks",
  "libraryGb",
  "aurralArtists",
  "lidarrArtists",
  "flows",
  "playlists",
  "shareLinks",
  "plugins",
  "activePlugins",
] as const;

export const INTEGRATIONS = [
  "lidarr",
  "slskd",
  "prowlarr",
  "nzbget",
  "sabnzbd",
  "tidarr",
  "ytdlp",
  "deemix",
  "lastfm",
  "ticketmaster",
  "gotify",
  "webhooks",
  "plex",
  "customMetadata",
] as const;

export const AUTH_MODES = ["oidc", "proxy", "google", "ssoOnly", "localNetworkBypass"] as const;
export const SETTING_FLAGS = [
  "inbox",
  "news",
  "missingTrackSearch",
  "qualityUpgrades",
  "customQuality",
  "favoriteAutoKeep",
  "pathMappings",
] as const;
export const DATE_TIME_FORMATS = ["browser", "day-first", "year-first"] as const;
export const DISCOVERY_SOURCES = ["lastfm", "listenbrainz"] as const;
export const LISTEN_SOURCES = ["lastfm", "listenbrainz", "koito"] as const;
export const PLAYBACK_SERVERS = ["navidrome", "plex", "jellyfin"] as const;
export const PLAY_SOURCES = ["aurral", "subsonic", "other"] as const;
export const DOWNLOAD_SOURCES = ["slskd", "usenet", "deemix", "ytdlp", "share", "plugin"] as const;
export const IMPORT_SOURCES = [
  "spotify-playlist",
  "listenbrainz-playlist",
  "listenbrainz-createdfor",
  "lastfm-station",
  "youtube-music-playlist",
  "deezer-playlist",
  "aurral-share",
  "plugin",
] as const;
export const APPEARANCES = ["system", "light", "dark"] as const;
export const THEME_KINDS = ["aurral", "preset", "custom"] as const;
export const DEPRECATION_KINDS = [
  "download-folder-env",
  "legacy-data-dir",
  "auth-password-env",
  "weekly-flow-api",
  "weekly-flow-channel",
] as const;
export const LOG_CATEGORIES = [
  "api",
  "auth",
  "browser",
  "deemix",
  "discovery",
  "downloads",
  "history",
  "http",
  "images",
  "inbox",
  "jobs",
  "library",
  "library-files",
  "lidarr",
  "listening",
  "metadata",
  "musicbrainz",
  "news",
  "playback",
  "playlist-import",
  "playlists",
  "plex",
  "plugins",
  "scrobbling",
  "search",
  "settings",
  "share",
  "slskd",
  "spotify",
  "subsonic",
  "system",
  "usenet",
  "wrapped",
  "ytdlp",
  "other",
] as const;

export const TELEMETRY_PAGES = [
  "discover",
  "search",
  "shows",
  "news",
  "recommended",
  "trending",
  "editorial-playlists",
  "library",
  "playlists",
  "flows",
  "artist",
  "album",
  "activity",
  "wrapped",
  "blocklist",
  "share-import",
] as const;
export const DEVICES = ["desktop", "mobile", "tablet"] as const;
export const CLIENT_OS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "chromeos",
  "other",
] as const;
export const BROWSERS = ["chrome", "safari", "firefox", "edge", "other"] as const;
export const SUBSONIC_CLIENTS = [
  "symfonium",
  "feishin",
  "supersonic",
  "sonixd",
  "substreamer",
  "dsub",
  "ultrasonic",
  "tempus",
  "tempo",
  "amperfy",
  "playsub",
  "narjo",
  "sublime",
  "submariner",
  "castafiore",
  "musiver",
  "youamp",
  "arpeggi",
  "other",
] as const;

export type TelemetryPage = (typeof TELEMETRY_PAGES)[number];

export const SEEN_GROUPS = {
  pages: TELEMETRY_PAGES,
  devices: DEVICES,
  os: CLIENT_OS,
  browsers: BROWSERS,
  subsonicClients: SUBSONIC_CLIENTS,
  display: ["pwa"],
} as const;

export type SeenGroup = keyof typeof SEEN_GROUPS;
export type SeenKey = {
  [Group in SeenGroup]: `${Group}:${(typeof SEEN_GROUPS)[Group][number]}`;
}[SeenGroup];

const PAGE_PATHS: [RegExp, TelemetryPage][] = [
  [/^\/$/, "discover"],
  [/^\/search(\/|$)/, "search"],
  [/^\/shows(\/|$)/, "shows"],
  [/^\/discover\/news(\/|$)/, "news"],
  [/^\/discover\/recommended(\/|$)/, "recommended"],
  [/^\/discover\/trending(\/|$)/, "trending"],
  [/^\/discover\/playlists(\/|$)/, "editorial-playlists"],
  [/^\/(library\/)?playlists(\/|$)/, "playlists"],
  [/^\/library\/album(\/|$)/, "album"],
  [/^\/library(\/|$)/, "library"],
  [/^\/flows(\/|$)/, "flows"],
  [/^\/artist(\/|$)/, "artist"],
  [/^\/album(\/|$)/, "album"],
  [/^\/activity(\/|$)/, "activity"],
  [/^\/wrapped(\/|$)/, "wrapped"],
  [/^\/blocklist(\/|$)/, "blocklist"],
  [/^\/share\/import(\/|$)/, "share-import"],
];

export const telemetryPageForPath = (pathname: string) =>
  PAGE_PATHS.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;

export function describeUserAgent(userAgent: string) {
  const os: (typeof CLIENT_OS)[number] = /iPhone|iPad|iPod/.test(userAgent)
    ? "ios"
    : /Android/.test(userAgent)
      ? "android"
      : /CrOS/.test(userAgent)
        ? "chromeos"
        : /Windows/.test(userAgent)
          ? "windows"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? "macos"
            : /Linux/.test(userAgent)
              ? "linux"
              : "other";
  const device: (typeof DEVICES)[number] =
    /iPad|Tablet/.test(userAgent) || (os === "android" && !/Mobile/.test(userAgent))
      ? "tablet"
      : /Mobi|iPhone|iPod/.test(userAgent)
        ? "mobile"
        : "desktop";
  const browser: (typeof BROWSERS)[number] = /Edg(e|A|iOS)?\//.test(userAgent)
    ? "edge"
    : /Firefox|FxiOS/.test(userAgent)
      ? "firefox"
      : /SamsungBrowser|OPR\/|Opera/.test(userAgent)
        ? "other"
        : /Chrome|CriOS|Chromium/.test(userAgent)
          ? "chrome"
          : /Safari/.test(userAgent)
            ? "safari"
            : "other";
  return { device, os, browser };
}

export function subsonicClientName(client: string): (typeof SUBSONIC_CLIENTS)[number] {
  const normalized = client.toLowerCase().replace(/[^a-z]/g, "");
  return SUBSONIC_CLIENTS.find((name) => normalized.startsWith(name)) ?? "other";
}

type Guard<Value> = (value: unknown) => value is Value;
type Guarded<Check> = Check extends Guard<infer Value> ? Value : never;
type Exact<Shape> = { [Key in keyof Shape]: Guarded<Shape[Key]> };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneOf =
  <const Values extends readonly unknown[]>(values: Values) =>
  (value: unknown): value is Values[number] =>
    values.includes(value);

const exact =
  <Shape extends Record<string, Guard<unknown>>>(shape: Shape) =>
  (value: unknown): value is Exact<Shape> =>
    isObject(value) &&
    Object.keys(value).length === Object.keys(shape).length &&
    Object.entries(shape).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));

const list =
  <const Values extends readonly string[]>(values: Values) =>
  (value: unknown): value is Values[number][] =>
    Array.isArray(value) && value.length <= values.length && value.every(oneOf(values));

const recordOf =
  <const Keys extends readonly string[], Value>(keys: Keys, check: Guard<Value>) =>
  (value: unknown): value is Partial<Record<Keys[number], Value>> =>
    isObject(value) &&
    Object.entries(value).every(([key, item]) => keys.includes(key) && check(item));

const count = oneOf(COUNT_BUCKETS);
const counts = <const Keys extends readonly string[]>(keys: Keys) => recordOf(keys, count);

export const isTelemetryReport = exact({
  schema: oneOf([1]),
  version: (value: unknown): value is string =>
    typeof value === "string" && value.length <= 64 && releaseChannel(value) !== null,
  docker: (value: unknown): value is boolean => typeof value === "boolean",
  os: oneOf(["linux", "darwin", "win32", "freebsd", "other"]),
  arch: oneOf(["x64", "arm64", "arm", "other"]),
  scale: counts(SCALE_KEYS),
  integrations: list(INTEGRATIONS),
  auth: list(AUTH_MODES),
  settings: list(SETTING_FLAGS),
  dateTimeFormat: oneOf(DATE_TIME_FORMATS),
  discovery: oneOf(DISCOVERY_SOURCES),
  listening: counts(LISTEN_SOURCES),
  playbackServers: counts(PLAYBACK_SERVERS),
  plays: counts(PLAY_SOURCES),
  downloads: recordOf(DOWNLOAD_SOURCES, exact({ done: count, failed: count })),
  imports: counts(IMPORT_SOURCES),
  appearance: counts(APPEARANCES),
  themes: counts(THEME_KINDS),
  seen: exact({
    pages: list(TELEMETRY_PAGES),
    devices: list(DEVICES),
    os: list(CLIENT_OS),
    browsers: list(BROWSERS),
    subsonicClients: list(SUBSONIC_CLIENTS),
    display: list(SEEN_GROUPS.display),
  }),
  problems: recordOf(LOG_CATEGORIES, exact({ warn: count, error: count })),
  deprecations: list(DEPRECATION_KINDS),
});

export type TelemetryReport = Guarded<typeof isTelemetryReport>;
