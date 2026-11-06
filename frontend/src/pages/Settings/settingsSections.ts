import {
  Activity,
  Bell,
  Compass,
  Database,
  Download,
  Eye,
  Headphones,
  Library,
  Link,
  Monitor,
  Puzzle,
  SlidersHorizontal,
  User,
  Users,
} from "../../components/icons";

export const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile", icon: User, group: "account" },
  { id: "listening", label: "Listening", icon: Headphones, group: "account" },
  { id: "appearance", label: "Appearance", icon: Monitor, group: "account" },
  { id: "shared-links", label: "Shared links", icon: Link, group: "account" },
  { id: "general", label: "General", icon: SlidersHorizontal, group: "server" },
  { id: "users", label: "Users", icon: Users, group: "server" },
  { id: "library", label: "Library", icon: Library, group: "server" },
  { id: "monitoring", label: "Monitoring", icon: Eye, group: "server" },
  { id: "downloads", label: "Downloads", icon: Download, group: "server" },
  { id: "discovery", label: "Discovery", icon: Compass, group: "server" },
  { id: "notifications", label: "Notifications", icon: Bell, group: "server" },
  { id: "plugins", label: "Plugins", icon: Puzzle, group: "server", beta: true },
  { id: "status", label: "Status", icon: Activity, group: "server" },
  { id: "metadata", label: "Metadata", icon: Database, group: "server", hidden: true },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsSectionId = SettingsSection["id"];
export type SettingsGroupId = SettingsSection["group"];

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "server", label: "Server" },
];

export const visibleSettingsSections = (canManageServer: boolean) =>
  SETTINGS_SECTIONS.filter(
    (section) => !("hidden" in section) && (section.group === "account" || canManageServer),
  );

const findSection = (id: string) => SETTINGS_SECTIONS.find((section) => section.id === id);

export function resolveSettingsPath(path: string | null, canManageServer: boolean) {
  const [sectionId = "", item = ""] = (path || "").split("/");
  const section = findSection(sectionId);
  if (!section || (section.group === "server" && !canManageServer)) {
    const fallback = canManageServer ? findSection("general") : undefined;
    return { section: fallback ?? SETTINGS_SECTIONS[0], item: null };
  }
  return { section, item: item || null };
}

export type SettingsSearchContext = {
  canManageServer: boolean;
  lidarrConnected: boolean;
  signInMethods: boolean;
  sidebarArt: boolean;
};

type SettingsSearchEntry =
  | string
  | {
      keywords?: string;
      item?: string;
      when?: Exclude<keyof SettingsSearchContext, "canManageServer">;
    };

const SETTINGS_SEARCH: Record<SettingsSectionId, Record<string, SettingsSearchEntry>> = {
  profile: {
    Password: "change current new confirm local",
    "Sign-in methods": {
      keywords: "Google SSO OIDC single sign-on connect linked accounts",
      when: "signInMethods",
    },
    "API access": "API key X-Api-Key api_key token copy rotate",
    "Lidarr defaults": {
      keywords: "root folder quality profile artist adds",
      when: "lidarrConnected",
    },
  },
  listening: {
    Services: "scrobbling listening history recommendations",
    "Discovery tastes": "reset more like this less like this blocklist",
    "Last.fm": { item: "lastfm", keywords: "scrobbling listening history" },
    ListenBrainz: { item: "listenbrainz", keywords: "scrobbling user token listening history" },
    Koito: { item: "koito", keywords: "scrobbling API key URL listening history" },
    Spotify: { item: "spotify", keywords: "streaming history data export import zip" },
    Navidrome: { item: "navidrome", keywords: "listening history plays import Subsonic" },
    Plex: { item: "plex", keywords: "listening history plays import Plexamp" },
    Jellyfin: { item: "jellyfin", keywords: "listening history plays import Playback Reporting" },
  },
  appearance: {
    "Color scheme": "dark light system mode",
    Theme: "presets custom colors import immersive mode artwork tint",
    Navigation: "new beta sidebar tabs top bar playlists",
    "Artist pages": "YouTube music videos hide",
    Sidebar: { keywords: "environment art backdrop", when: "sidebarArt" },
  },
  "shared-links": {
    "Shared links": "share playlist artist album revoke expire",
  },
  general: {
    Display: "date and time format all users",
    "API access": "API key X-Api-Key api_key admin authentication copy rotate",
    Backup: "back up restore export import download upload config database migrate move server",
  },
  users: {
    Users: "create edit add account permissions roles suspended disabled claim",
    "Sign-in": "SSO SSO-only OIDC single sign-on login form",
    "Local network auto-login": "LAN bypass authentication",
    Google: { item: "google", keywords: "OAuth sign in client ID secret redirect" },
    "Default permissions": { item: "defaults", keywords: "new users permissions SSO register" },
  },
  library: {
    "Library folder": "downloads path media root favorite flow tracks keep",
    "Playlist files": "M3U Navidrome Plex Jellyfin media server playlists owner",
    "Read-only folders": "existing music never changes",
    "Import a folder": "ingest existing music move copy hardlink fill in missing tags",
    "Clean up Library": "rename organize tags files naming folders",
    "Library managers": "Lidarr",
    Lidarr: {
      item: "lidarr",
      keywords:
        "connection API key server URL root folder quality profile metadata profile tag monitor search on add community guide",
    },
  },
  monitoring: {
    "Default rules":
      "monitor artists back catalogue discography new releases latest since year albums EPs singles live compilations soundtracks remixes demos DJ mixes mixtapes edition deluxe expanded top tracks popular",
    "Missing tracks": "search again retry failed album tracks interval days schedule",
    "Removed from monitoring": "excluded deleted albums tracks allow again exclusions",
  },
  downloads: {
    "Download clients": "add client priority sources",
    "Review queue": "maximum wait hours held tracks deny",
    "Remote path mappings": "download client path mapping remote local docker",
    slskd: { item: "slskd", keywords: "Soulseek download client" },
    NZBGet: { item: "nzbget", keywords: "Usenet download client" },
    SABnzbd: { item: "sabnzbd", keywords: "Usenet download client" },
    Tidarr: { item: "tidarr", keywords: "Tidal download client" },
    "yt-dlp": { item: "ytdlp", keywords: "YouTube download client staging" },
    deemix: { item: "deemix", keywords: "Deezer download client bitrate" },
    Prowlarr: { item: "prowlarr", keywords: "indexers indexer manager search usenet categories" },
    "Quality profile": {
      item: "quality",
      keywords:
        "FLAC MP3 M4A 128 192 256 320 bitrate hi-res allowed formats rank preference cutoff automatic upgrades",
    },
  },
  discovery: {
    Recommendations:
      "refresh frequency daily weekly monthly mode safer balanced deeper artists per refresh now",
    Status: "source artwork cache clear",
    "Last.fm": { item: "lastfm", keywords: "recommendations API key shared secret" },
    Ticketmaster: {
      item: "ticketmaster",
      keywords: "local shows concerts events consumer key radius",
    },
    News: { item: "news", keywords: "RSS articles feeds" },
  },
  notifications: {
    Inbox: "upcoming releases shows artist news recommended discoveries",
    Webhooks: "HTTP callbacks headers body events",
    Gotify: { item: "gotify", keywords: "push notifications mobile alerts token events" },
  },
  plugins: {
    Installed: "add-ons extensions integrations download sources playlist actions updates",
    "Install from a link": "GitHub repo zip add install plugin",
    "Build with an agent": "MCP developer key Claude Codex prompt",
    "Safe mode": "turn off all plugins troubleshoot bug report",
  },
  status: {
    About:
      "version runtime application build uptime environment platform container database path data directory",
    Storage: { item: "storage", keywords: "disk space health free paths run checks" },
    Tasks: { item: "tasks", keywords: "scheduled workers queue jobs running failed retry stale" },
    Logs: { item: "logs", keywords: "errors warnings problems" },
  },
  metadata: {
    "Metadata server": "BrainzMash MusicBrainz provider base URL",
  },
};

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const SETTINGS_SEARCH_ITEMS = SETTINGS_SECTIONS.flatMap((section) =>
  Object.entries({ [section.label]: "", ...SETTINGS_SEARCH[section.id] }).map(([label, entry]) => {
    const { keywords = "", item, when } = typeof entry === "string" ? { keywords: entry } : entry;
    const group = item || label === section.label ? null : label;
    return {
      key: `${section.id}:${label}`,
      label,
      section,
      path: item ? `${section.id}/${item}` : section.id,
      group,
      when,
      labelText: normalizeSearchText(`${section.label} ${label}`),
      searchText: normalizeSearchText(`${section.label} ${label} ${keywords}`),
    };
  }),
);

export type SettingsSearchResult = (typeof SETTINGS_SEARCH_ITEMS)[number];

export function searchSettings(query: string, context: SettingsSearchContext) {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  const matches = (text: string) => terms.every((term) => text.includes(term));
  const hits = SETTINGS_SEARCH_ITEMS.filter(
    (item) =>
      (item.section.group === "account" || context.canManageServer) &&
      (!item.when || context[item.when]) &&
      matches(item.searchText),
  );
  const rank = (item: SettingsSearchResult) =>
    !matches(item.labelText) ? 2 : item.label === item.section.label ? 0 : 1;
  return hits.sort((a, b) => rank(a) - rank(b));
}
